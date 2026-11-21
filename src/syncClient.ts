/**
 * Verbindung eines Dokuments mit einem Grid-Server (Protokoll: docs/SYNC.md).
 * Abgleich der Yjs-Daten über WebSocket, dazu Hochladen/Nachladen der Dateien (Assets).
 * Bei Verbindungsabbruch wird mit wachsenden Abständen neu verbunden; offline arbeitet das Dokument einfach lokal weiter.
 */
import * as Y from 'yjs'
import { blobKeyOf, neededAssetKeys } from './gridFile'
import { getBlob, putBlob } from './blobStore'
import { filesOf } from './model'
import { getIdentity, onIdentityChanged, signMessage } from './identity'

export type SyncStatus = 'connecting' | 'online' | 'offline' | 'pending' | 'denied'
/** `pending` kann zweierlei heißen: `account` (Konto noch nicht freigegeben) oder `join` (ein Admin muss die Aufnahme ins Dokument bestätigen). */
export interface SyncState {
  status: SyncStatus; reason?: string; kind?: 'account' | 'join'
  /** Verbunden, aber der Server nimmt keine Änderungen an (kein Abo oder Speicher voll); lokal geht alles weiter. */
  readonly?: { code: string; reason: string }
}

const REMOTE = Symbol('remote')
const STEP1 = 0
const UPDATE = 1

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
  constructor(readonly kind: 'pending' | 'invalid' | 'unreachable', message: string) { super(message) }
}

const sessions = new Map<string, { token: string; exp: number }>()
onIdentityChanged(() => sessions.clear())

/** Sitzungsschlüssel des Servers: Rätsel holen, mit dem Konto-Schlüssel signieren, einlösen. Wird zwischengespeichert. */
export async function sessionToken(server: string, force = false): Promise<string> {
  const base = normalizeServer(server)
  const have = sessions.get(base)
  if (have && !force && have.exp - 60 > Date.now() / 1000) return have.token
  let res: Response
  try {
    const { nonce } = await (await fetch(`${base}/challenge`)).json()
    const me = await getIdentity()
    res = await fetch(`${base}/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: me.id, pub: me.publicKey, nonce, sig: signMessage(me, `grid-login-v1\n${me.id}\n${nonce}`) }),
    })
  } catch { throw new AuthError('unreachable', 'Server nicht erreichbar') }
  const body = await res.json().catch(() => ({}))
  if (res.ok && body.token) { sessions.set(base, { token: body.token, exp: body.exp }); return body.token }
  if (body.status === 'pending') throw new AuthError('pending', 'Das Konto wartet auf Freigabe durch den Betreiber des Servers')
  throw new AuthError('invalid', body.reason ?? `Server antwortet mit ${res.status}`)
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
export interface AccountInfo { id: string; plan: 'free' | 'paid'; active: boolean; paidUntil: number | null; quota: number; used: number; billing: boolean; manageUrl: string | null }

export async function fetchAccountInfo(server: string): Promise<AccountInfo> {
  const r = await authedFetch(server, '/me')
  if (!r.ok) throw new Error(`Server antwortet mit ${r.status}`)
  return r.json()
}

export interface CloudDoc { id: string; name: string; updated: number }

export async function listCloudDocs(server: string): Promise<CloudDoc[]> {
  const r = await authedFetch(server, '/docs')
  if (!r.ok) throw new Error(`Server antwortet mit ${r.status}`)
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
  private readonly: { code: string; reason: string } | null = null
  private resync: ReturnType<typeof setTimeout> | undefined

  constructor(
    private doc: Y.Doc,
    private cfg: { server: string; docId: string; name: string },
    private onState: (s: SyncState) => void,
    /** Mitglieder oder Beitrittsanfragen könnten sich geändert haben (auch gleich nach dem Verbinden). */
    private onNotice: () => void = () => {},
  ) {
    doc.on('update', this.onLocal)
    filesOf(doc).observe(this.onFilesChanged)
    this.offIdentity = onIdentityChanged(() => this.restart())
    void this.open()
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
    void this.open()
  }

  private onLocal = (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE || !this.online) return
    this.ws?.send(frame(UPDATE, update))
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
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', token, name: this.cfg.name }))
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data)
        if (m.t === 'ok') {
          this.online = true
          this.attempt = 0
          this.expired = 0
          this.readonly = null
          this.onState({ status: 'online' })
          this.onNotice()
          ws.send(frame(STEP1, Y.encodeStateVector(this.doc)))
          void this.syncBlobs()
        } else if (m.t === 'readonly') {
          this.readonly = { code: m.code, reason: m.reason }
          this.onState({ status: 'online', readonly: this.readonly })
          // später noch einmal abgleichen: vielleicht ist das Abo inzwischen da, dann geht der aufgelaufene Stand hoch
          clearTimeout(this.resync)
          this.resync = setTimeout(() => { if (this.online) ws.send(frame(STEP1, Y.encodeStateVector(this.doc))) }, 60_000)
        } else if (m.t === 'writable') {
          if (this.readonly) { this.readonly = null; this.onState({ status: 'online' }) }
        } else if (m.t === 'members') {
          this.onNotice()
        } else if (m.t === 'denied') {
          this.ws = null
          ws.close()
          if (m.code === 'expired' && this.expired++ < 2) { this.relogin = true; void this.open(); return } // Sitzung abgelaufen: neu anmelden
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
      if (data[0] === STEP1) ws.send(frame(UPDATE, Y.encodeStateAsUpdate(this.doc, body)))
      else if (data[0] === UPDATE && body.length > 2) Y.applyUpdate(this.doc, body, REMOTE)
    }
    ws.onclose = () => { if (this.ws === ws) this.lost() }
    ws.onerror = () => { /* onclose folgt */ }
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
        for (const key of neededAssetKeys(this.doc)) {
          const local = await getBlob(blobKeyOf(key))
          if (local && !remote.has(key)) {
            await authedFetch(server, `/blob/${docId}/${key}`, { method: 'PUT', body: local })
          } else if (!local && remote.has(key)) {
            const d = await authedFetch(server, `/blob/${docId}/${key}`)
            if (d.ok) await putBlob(blobKeyOf(key), await d.blob())
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
    clearTimeout(this.resync)
    this.doc.off('update', this.onLocal)
    filesOf(this.doc).unobserve(this.onFilesChanged)
    const ws = this.ws
    this.ws = null
    ws?.close()
  }
}
