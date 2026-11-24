/**
 * Verbindung eines Dokuments mit einem Grid-Server (Protokoll: docs/SYNC.md).
 * Abgleich der Yjs-Daten über WebSocket, dazu Hochladen/Nachladen der Dateien (Assets).
 * Bei Verbindungsabbruch wird mit wachsenden Abständen neu verbunden; offline arbeitet das Dokument einfach lokal weiter.
 */
import * as Y from 'yjs'
import { blobKeyOf, neededAssetKeys } from './gridFile'
import { getBlob, putBlob } from './blobStore'
import { filesOf } from './model'
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromHex, getIdentity, onIdentityChanged, signMessage, toHex } from './identity'
import { decryptBlob, decryptEntry, encryptBlob, encryptEntry, MissingKey } from './e2e'
import type { DocKeys } from './docKeys'
import { fetchMembers } from './members'
import { seal } from './signedUpdate'
import type { Verdict } from './updateGuard'
import { t } from './i18n'

export type SyncStatus = 'connecting' | 'online' | 'offline' | 'pending' | 'denied'
/**
 * `pending` heißt: `account` (Konto noch nicht freigegeben), `join` (ein Admin muss die Aufnahme bestätigen) oder
 * `claim` (das Dokument ist auf diesem Server noch nicht angelegt, ein Admin muss es zuerst umziehen).
 * `denied` mit `untrusted`: der Server hat nicht den Schlüssel, den Grid von ihm kennt.
 */
export interface SyncState {
  status: SyncStatus; reason?: string; kind?: 'account' | 'join' | 'claim' | 'untrusted' | 'keys'
  /** Verbunden, aber der Server nimmt keine Änderungen an (kein Abo oder Speicher voll); lokal geht alles weiter. */
  readonly?: { code: string; reason: string }
}

const REMOTE = Symbol('remote')
const STEP1 = 0
const UPDATE = 1
// verschlüsselte Dokumente (docs/E2E.md)
const ENC_PUT = 4
const ENC_ENTRY = 5
const ENC_SNAPSHOT = 6
const SHADOW = Symbol('shadow')
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export const toWsUrl = (server: string, docId: string) =>
  `${server.replace(/\/+$/, '').replace(/^http/i, 'ws')}/ws/${encodeURIComponent(docId)}`

export const normalizeServer = (s: string) => {
  let t = s.trim().replace(/\/+$/, '')
  // ohne Angabe: https, nur für Adressen im eigenen Netz (zum Ausprobieren) http
  if (t && !/^[a-z]+:\/\//i.test(t)) t = `${/^(localhost|127\.|10\.|192\.168\.|\[::1\])/i.test(t) ? 'http' : 'https'}://${t}`
  return t
}

export function frame(kind: number, body: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(body.length + 1)
  out[0] = kind
  out.set(body, 1)
  return out
}

// ---------- Anmeldung mit dem Konto ----------

/** `pending`: das Konto wartet auf Freigabe durch den Server-Betreiber; `invalid`: abgelehnt; `unreachable`: Server nicht erreichbar. */
export class AuthError extends Error {
  constructor(readonly kind: 'pending' | 'invalid' | 'unreachable' | 'untrusted', message: string) { super(message) }
}

// ---------- Identität des Servers: merken und prüfen ----------
// Beim ersten Verbinden merkt sich Grid den öffentlichen Schlüssel des Servers (steht auch in der Dokumentdatei und in
// Einladungen). Danach muss jeder Server unter dieser Adresse beweisen, dass er diesen Schlüssel hat.

const PINS = 'grid-server-pins'
const readPins = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(PINS) ?? '{}') } catch { return {} } }
const pins = new Map<string, string>(Object.entries(readPins()))
const keyListeners = new Set<(server: string, key: string) => void>()

const savePins = () => { try { localStorage.setItem(PINS, JSON.stringify(Object.fromEntries(pins))) } catch { /* egal */ } }
export const pinnedKey = (server: string) => pins.get(normalizeServer(server)) ?? null
/** Schlüssel eines Servers festhalten (`null` = vergessen, beim nächsten Verbinden gilt der dann gemeldete). */
export function pinServer(server: string, key: string | null) {
  const url = normalizeServer(server)
  if (key) pins.set(url, key); else pins.delete(url)
  savePins()
}
/** Meldet, wenn ein Server zum ersten Mal seinen Schlüssel gezeigt hat. */
export const onServerKey = (fn: (server: string, key: string) => void) => { keyListeners.add(fn); return () => { keyListeners.delete(fn) } }

function checkServer(base: string, nonce: string, server?: { pub: string; sig: string }) {
  const pinned = pins.get(base)
  if (!server) {
    if (pinned) throw new AuthError('untrusted', t('Der Server meldet keinen Schlüssel mehr, Grid kennt aber einen. Es ist vielleicht nicht der richtige Server.'))
    return // älterer Server ohne Identität
  }
  let ok = false
  try { ok = ed25519.verify(fromHex(server.sig), new TextEncoder().encode(`grid-server-v1\n${nonce}`), fromHex(server.pub)) } catch { /* ungültig */ }
  if (!ok) throw new AuthError('untrusted', t('Der Server konnte seine Identität nicht beweisen.'))
  if (pinned && pinned !== server.pub) {
    throw new AuthError('untrusted', t('Dieser Server hat einen anderen Schlüssel als beim ersten Verbinden. Das passiert bei einer Neuinstallation – oder wenn es nicht der richtige Server ist.'))
  }
  if (!pinned) { pins.set(base, server.pub); savePins(); keyListeners.forEach((f) => f(base, server.pub)) }
}

export interface ServerInfo { name: string | null; pub: string; billing: boolean; version: string }
export async function fetchServerInfo(server: string): Promise<ServerInfo> {
  const r = await fetch(`${normalizeServer(server)}/server`)
  if (!r.ok) throw new Error(t('Server antwortet mit {status}', { status: r.status }))
  return r.json()
}

const sessions = new Map<string, { token: string; exp: number }>()
onIdentityChanged(() => sessions.clear())

/** Sitzungsschlüssel des Servers: Rätsel holen, mit dem Konto-Schlüssel signieren, einlösen. Wird zwischengespeichert. */
export async function sessionToken(server: string, force = false): Promise<string> {
  const base = normalizeServer(server)
  const have = sessions.get(base)
  if (have && !force && have.exp - 60 > Date.now() / 1000) return have.token
  let res: Response
  let challenge: { nonce: string; server?: { pub: string; sig: string } }
  try { challenge = await (await fetch(`${base}/challenge`)).json() } catch { throw new AuthError('unreachable', t('Server nicht erreichbar')) }
  checkServer(base, challenge.nonce, challenge.server)
  try {
    const { nonce } = challenge
    const me = await getIdentity()
    res = await fetch(`${base}/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: me.id, pub: me.publicKey, nonce, sig: signMessage(me, `grid-login-v1\n${me.id}\n${nonce}`) }),
    })
  } catch { throw new AuthError('unreachable', t('Server nicht erreichbar')) }
  const body = await res.json().catch(() => ({}))
  if (res.ok && body.token) { sessions.set(base, { token: body.token, exp: body.exp }); return body.token }
  if (body.status === 'pending') throw new AuthError('pending', t('Das Konto wartet auf Freigabe durch den Betreiber des Servers'))
  throw new AuthError('invalid', body.reason ?? t('Server antwortet mit {status}', { status: res.status }))
}

/** `fetch` mit Sitzungsschlüssel; bei „abgelaufen“ einmal neu anmelden. */
export async function authedFetch(server: string, path: string, init: RequestInit = {}): Promise<Response> {
  const go = async (force: boolean) => fetch(`${normalizeServer(server)}${path}`, {
    ...init, headers: { ...init.headers, Authorization: `Bearer ${await sessionToken(server, force)}` },
  })
  const r = await go(false)
  return r.status === 401 ? go(true) : r
}

/** Abo und Speicher des Kontos auf einem Server. */
export interface AccountInfo {
  id: string; plan: 'free' | 'paid'; active: boolean; paidUntil: number | null; quota: number; used: number; billing: boolean
  manageUrl: string | null
  /** Zahlungslink mit der Konto-Kennung (Stripe), falls der Server einen kennt */
  checkoutUrl: string | null
  /** In-App-Kauf (App Store): Produkte, die ein Abo freischalten, und die Links, die Apple verlangt; sonst `null` */
  iap?: { products: { id: string; quota: number }[]; termsUrl: string | null; privacyUrl: string | null } | null
  /** Woher das Abo kommt: `apple` (Kauf) oder `manual` (vom Betreiber freigeschaltet) */
  planSource?: string
  /** Der Server kann E-Mails schicken (Bestätigung, Wiederherstellung) */
  mail?: boolean
  email?: string | null
  emailVerified?: boolean
  /** Auf dem Server liegt ein mit Passwort verschlüsselter Kontotext zur Wiederherstellung */
  recovery?: boolean
}

export async function fetchAccountInfo(server: string): Promise<AccountInfo> {
  const r = await authedFetch(server, '/me')
  if (!r.ok) throw new Error(t('Server antwortet mit {status}', { status: r.status }))
  return r.json()
}

/** Rechte (docs/RIGHTS.md): wie die Verbindung Änderungen bewertet und signiert. */
export interface RightsHooks {
  /** Wartet, bis die Mitgliederliste aktuell ist (sie bestimmt, wer was darf). */
  settled: () => Promise<void>
  /** Bewertet den entschlüsselten Klartext des Eintrags `seq`. */
  judge: (live: Y.Doc, seq: number, plain: Uint8Array) => Verdict
  /** Gibt es Gruppen (dann wird signiert) und ist dieses Konto Admin (nur dann darf es zusammenführen)? */
  mode: () => { active: boolean; admin: boolean }
  /** Eine Änderung wurde abgelehnt. */
  onRejected: (seq: number, reason: string) => void
}

export interface CloudDoc { id: string; name: string; updated: number; enc?: boolean }

export async function listCloudDocs(server: string): Promise<CloudDoc[]> {
  const r = await authedFetch(server, '/docs')
  if (!r.ok) throw new Error(t('Server antwortet mit {status}', { status: r.status }))
  return r.json()
}

export class SyncConnection {
  private ws: WebSocket | null = null
  private stopped = false
  private attempt = 0
  private retry: ReturnType<typeof setTimeout> | undefined
  private blobTimer: ReturnType<typeof setTimeout> | undefined
  private blobRun: Promise<void> = Promise.resolve()
  private online = false
  private relogin = false
  private offIdentity: () => void
  private expired = 0
  private claims = 0
  private readonly: { code: string; reason: string } | null = null
  private resyncTimer: ReturnType<typeof setTimeout> | undefined
  // verschlüsselter Modus: `shadow` hält, was der Server schon kennt (daraus ergibt sich, was noch hochgeladen werden muss)
  private shadow = new Y.Doc()
  private since = 0
  private chain: Promise<void> = Promise.resolve()
  private gen = 0
  private keysReady: Promise<void> = Promise.resolve()
  private pendingCompact = 0

  constructor(
    private doc: Y.Doc,
    private cfg: { server: string; docId: string; name: string; keys?: DocKeys; rights?: RightsHooks },
    private onState: (s: SyncState) => void,
    /** Mitglieder oder Beitrittsanfragen könnten sich geändert haben (auch gleich nach dem Verbinden). */
    private onNotice: () => void = () => {},
    /** Das Dokument gibt es auf dem Server noch nicht: anlegen (oder umziehen). Scheitert mit einer Erklärung. */
    private onClaim: (() => Promise<void>) | null = null,
  ) {
    doc.on('update', this.onLocal)
    filesOf(doc).observe(this.onFilesChanged)
    this.offIdentity = onIdentityChanged(() => this.restart())
    void this.open()
  }

  /** Zustand mit dem Server neu abgleichen (z. B. weil ein Abo gerade aktiv geworden ist). */
  resync() {
    if (!this.online) return
    if (this.cfg.keys) void this.pushDiff()
    else this.ws?.send(frame(STEP1, Y.encodeStateVector(this.doc)))
  }

  /** Anderes Konto in Gebrauch: neu verbinden. */
  private restart() {
    clearTimeout(this.retry)
    const ws = this.ws
    this.ws = null
    this.online = false
    ws?.close()
    this.stopped = false
    this.attempt = 0
    this.expired = 0
    this.shadow = new Y.Doc() // anderes Konto, andere Schlüssel: von vorn nachladen
    this.since = 0
    void this.open()
  }

  private onLocal = (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE || origin === SHADOW || !this.online) return
    if (this.cfg.keys) void this.sendEnc(update)
    else this.ws?.send(frame(UPDATE, update))
  }

  private onFilesChanged = () => {
    clearTimeout(this.blobTimer)
    this.blobTimer = setTimeout(() => void this.syncBlobs(), 300)
  }

  private async open() {
    if (this.stopped) return
    this.onState({ status: 'connecting' })
    let token: string
    try {
      token = await sessionToken(this.cfg.server, this.relogin)
      this.relogin = false
    } catch (e) {
      if (this.stopped) return
      if (e instanceof AuthError && e.kind === 'pending') {
        this.onState({ status: 'pending', kind: 'account', reason: e.message })
        this.retry = setTimeout(() => void this.open(), 10_000) // der Betreiber gibt vielleicht gleich frei
      } else if (e instanceof AuthError && e.kind === 'untrusted') {
        this.stopped = true
        this.onState({ status: 'denied', kind: 'untrusted', reason: e.message })
      } else if (e instanceof AuthError && e.kind === 'invalid') {
        this.stopped = true
        this.onState({ status: 'denied', reason: e.message })
      } else this.lost()
      return
    }
    if (this.stopped) return
    let ws: WebSocket
    try { ws = new WebSocket(toWsUrl(this.cfg.server, this.cfg.docId)) } catch { return this.lost() }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    const gen = ++this.gen
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', token, name: this.cfg.name, since: this.cfg.keys ? this.since : undefined }))
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data)
        if (m.t === 'ok' && this.cfg.keys) {
          // verschlüsselt: erst nach dem Nachladen (Nachricht „synced“) gilt die Verbindung als online
          this.attempt = 0; this.expired = 0; this.claims = 0; this.readonly = null
          this.keysReady = this.ensureKeys(ws, gen)
        } else if (m.t === 'synced' && this.cfg.keys) {
          this.chain = this.chain.then(() => this.finishSync(ws, gen))
        } else if (m.t === 'compact' && this.cfg.keys) {
          this.pendingCompact = Math.max(this.pendingCompact, m.upto)
          this.chain = this.chain.then(() => this.compactIfDue(ws, gen))
        } else if (m.t === 'ok') {
          this.online = true
          this.attempt = 0
          this.expired = 0
          this.claims = 0
          this.readonly = null
          this.onState({ status: 'online' })
          this.onNotice()
          ws.send(frame(STEP1, Y.encodeStateVector(this.doc)))
          void this.syncBlobs()
        } else if (m.t === 'readonly') {
          this.readonly = { code: m.code, reason: m.reason }
          this.onState({ status: 'online', readonly: this.readonly })
          // später noch einmal abgleichen: vielleicht ist das Abo inzwischen da, dann geht der aufgelaufene Stand hoch
          clearTimeout(this.resyncTimer)
          this.resyncTimer = setTimeout(() => { if (this.online) ws.send(frame(STEP1, Y.encodeStateVector(this.doc))) }, 60_000)
        } else if (m.t === 'writable') {
          if (this.readonly) { this.readonly = null; this.onState({ status: 'online' }) }
        } else if (m.t === 'members') {
          if (this.cfg.keys) void this.cfg.keys.load().catch(() => {})
          this.onNotice()
        } else if (m.t === 'denied') {
          this.ws = null
          ws.close()
          if (m.code === 'expired' && this.expired++ < 2) { this.relogin = true; void this.open(); return } // Sitzung abgelaufen: neu anmelden
          if (m.code === 'unclaimed' && this.onClaim && this.claims++ < 2) {
            this.onClaim().then(() => void this.open(), (e: Error) => {
              if (this.stopped) return
              this.onState({ status: 'pending', kind: 'claim', reason: e.message })
              this.retry = setTimeout(() => void this.open(), 30_000)
            })
            return
          }
          if (m.code === 'requested') { // angeklopft: ein Admin muss zustimmen
            this.onState({ status: 'pending', kind: 'join', reason: m.reason })
            this.retry = setTimeout(() => void this.open(), 10_000)
            return
          }
          this.stopped = true // ohne Berechtigung hilft Wiederholen nicht
          this.onState({ status: 'denied', reason: m.reason })
        }
        return
      }
      const data = new Uint8Array(e.data as ArrayBuffer)
      const body = data.subarray(1)
      if (this.cfg.keys) {
        if (data[0] === ENC_ENTRY && data.length > 9) {
          const seq = Number(new DataView(data.buffer, data.byteOffset + 1, 8).getBigUint64(0))
          const entry = data.slice(9)
          this.chain = this.chain.then(() => this.applyEntry(ws, gen, seq, entry))
        }
        return
      }
      if (data[0] === STEP1) ws.send(frame(UPDATE, Y.encodeStateAsUpdate(this.doc, body)))
      else if (data[0] === UPDATE && body.length > 2) Y.applyUpdate(this.doc, body, REMOTE)
    }
    ws.onclose = () => { if (this.ws === ws) this.lost() }
    ws.onerror = () => { /* onclose folgt */ }
  }

  // ---------- verschlüsselter Modus ----------

  private alive(ws: WebSocket, gen: number) { return !this.stopped && gen === this.gen && this.ws === ws }

  /** Dokumentschlüssel besorgen; der Ersteller legt den ersten an, alle anderen warten, bis ein Admin ihre Kiste abgelegt hat. */
  private async ensureKeys(ws: WebSocket, gen: number) {
    const keys = this.cfg.keys!
    while (this.alive(ws, gen)) {
      try {
        if (await keys.load()) return
        if (keys.serverEpoch === 0 && (await keys.createFirst(await fetchMembers(this.cfg.server, this.cfg.docId)))) return
      } catch { /* offline oder noch kein Mitglied: nächster Versuch */ }
      this.onState({ status: 'pending', kind: 'keys', reason: t('Wartet auf den Dokumentschlüssel: ein Admin muss ihn senden (er muss dafür online sein).') })
      await sleep(5000)
    }
  }

  private async keyFor(epoch: number, ws: WebSocket, gen: number): Promise<Uint8Array | undefined> {
    for (;;) {
      const k = await this.cfg.keys!.keyFor(epoch)
      if (k || !this.alive(ws, gen)) return k
      this.onState({ status: 'pending', kind: 'keys', reason: t('Schlüssel (Epoche {epoch}) fehlt: ein Admin muss ihn senden.', { epoch }) })
      await sleep(5000)
    }
  }

  private async applyEntry(ws: WebSocket, gen: number, seq: number, entry: Uint8Array) {
    if (!this.alive(ws, gen)) return
    await this.keysReady
    let plain: Uint8Array
    try {
      plain = await decryptEntry(this.cfg.docId, (e) => this.keyFor(e, ws, gen), entry)
    } catch (e) {
      if (e instanceof MissingKey || !this.alive(ws, gen)) return
      this.since = Math.max(this.since, seq) // beschädigter oder fremder Eintrag: überspringen
      return
    }
    const rights = this.cfg.rights
    if (rights) {
      await rights.settled()
      if (!this.alive(ws, gen)) return
      const v = rights.judge(this.doc, seq, plain)
      if (!v.ok) { // nicht erlaubt: weder ins Dokument noch in den Schatten (so geht es auch nie in einen Gesamtzustand ein)
        this.since = Math.max(this.since, seq)
        rights.onRejected(seq, v.reason)
        return
      }
      plain = v.update
    }
    Y.applyUpdate(this.shadow, plain, SHADOW)
    Y.applyUpdate(this.doc, plain, REMOTE)
    this.since = Math.max(this.since, seq)
    if (this.pendingCompact && this.since >= this.pendingCompact) await this.compactIfDue(ws, gen)
  }

  private async finishSync(ws: WebSocket, gen: number) {
    if (!this.alive(ws, gen)) return
    await this.keysReady
    if (!this.alive(ws, gen)) return
    this.online = true
    this.onState({ status: 'online' })
    this.onNotice()
    await this.pushDiff()
    void this.syncBlobs()
  }

  /** Was der Server noch nicht kennt (z. B. aus der Zeit ohne Verbindung), verschlüsselt hochladen. */
  private async pushDiff() {
    const diff = Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(this.shadow))
    if (diff.length > 2) await this.sendEnc(diff)
  }

  private async sendEnc(update: Uint8Array) {
    const keys = this.cfg.keys!
    const epoch = keys.top
    const key = keys.key(epoch)
    const ws = this.ws
    if (!key || !ws || ws.readyState !== WebSocket.OPEN) return
    const signed = this.cfg.rights?.mode().active ? seal(await getIdentity(), this.cfg.docId, update) : update // mit Gruppen trägt jede Änderung die Unterschrift ihres Autors
    ws.send(frame(ENC_PUT, await encryptEntry(this.cfg.docId, epoch, key, signed)))
  }

  /** Meldet der Server viele Einträge, lädt ein Client den Gesamtzustand hoch (der Server kann ihn nicht selbst bilden). */
  private async compactIfDue(ws: WebSocket, gen: number) {
    const upto = this.pendingCompact
    if (!upto || this.since < upto || !this.alive(ws, gen)) return
    this.pendingCompact = 0
    const keys = this.cfg.keys!
    const epoch = keys.top, key = keys.key(epoch)
    if (!key || ws.readyState !== WebSocket.OPEN) return
    const mode = this.cfg.rights?.mode()
    if (mode?.active && !mode.admin) return // mit Gruppen führen nur Admins zusammen: der Gesamtzustand bündelt Änderungen aller
    const state = Y.encodeStateAsUpdate(this.shadow)
    const entry = await encryptEntry(this.cfg.docId, epoch, key, mode?.active ? seal(await getIdentity(), this.cfg.docId, state, 'snap') : state)
    const body = new Uint8Array(8 + entry.length)
    new DataView(body.buffer).setBigUint64(0, BigInt(upto))
    body.set(entry, 8)
    ws.send(frame(ENC_SNAPSHOT, body))
  }

  private lost() {
    this.online = false
    this.ws = null
    if (this.stopped) return
    this.onState({ status: 'offline' })
    const wait = Math.min(30_000, 1000 * 2 ** this.attempt++)
    this.retry = setTimeout(() => void this.open(), wait)
  }

  /** Dateien abgleichen: was der Server nicht hat, hochladen; was hier fehlt, herunterladen. */
  syncBlobs(): Promise<void> {
    this.blobRun = this.blobRun.then(async () => {
      if (!this.online) return
      const { server, docId } = this.cfg
      try {
        const r = await authedFetch(server, `/blobs/${docId}`)
        if (!r.ok) return
        const remote = new Set<string>(await r.json())
        const mimes = new Map<string, string>() // Hash → Dateityp aus dem Dokument (der Server liefert nur Bytes)
        filesOf(this.doc).forEach((f, k) => mimes.set(k.split('|')[3], f.mime))
        const keys = this.cfg.keys
        for (const key of neededAssetKeys(this.doc)) {
          const local = await getBlob(blobKeyOf(key))
          if (local && !remote.has(key)) {
            if (keys) {
              const epoch = keys.top, k = keys.key(epoch)
              if (!k) continue
              await authedFetch(server, `/blob/${docId}/${key}`, { method: 'PUT', body: await encryptBlob(docId, epoch, k, key, new Uint8Array(await local.arrayBuffer())) as BodyInit })
            } else await authedFetch(server, `/blob/${docId}/${key}`, { method: 'PUT', body: local })
          } else if (!local && remote.has(key)) {
            const d = await authedFetch(server, `/blob/${docId}/${key}`)
            if (!d.ok) continue
            let bytes: BlobPart = await d.arrayBuffer()
            if (keys) {
              try {
                const plain = await decryptBlob(docId, (e) => keys.keyFor(e), key, new Uint8Array(bytes as ArrayBuffer))
                if (!key.endsWith('.thumb') && toHex(sha256(plain)) !== key) continue // passt nicht zum Hash im Dokument
                bytes = plain as BlobPart
              } catch { continue }
            }
            await putBlob(blobKeyOf(key), new Blob([bytes], { type: key.endsWith('.thumb') ? 'image/jpeg' : mimes.get(key) ?? '' }))
          }
        }
      } catch { /* beim nächsten Verbinden erneut */ }
    })
    return this.blobRun
  }

  close() {
    this.offIdentity()
    this.stopped = true
    this.online = false
    clearTimeout(this.retry)
    clearTimeout(this.blobTimer)
    clearTimeout(this.resyncTimer)
    this.doc.off('update', this.onLocal)
    filesOf(this.doc).unobserve(this.onFilesChanged)
    const ws = this.ws
    this.ws = null
    ws?.close()
  }
}
