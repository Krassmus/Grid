/**
 * Verbindung eines Dokuments mit einem Grid-Server (Protokoll: docs/SYNC.md).
 * Abgleich der Yjs-Daten über WebSocket, dazu Hochladen/Nachladen der Dateien (Assets).
 * Bei Verbindungsabbruch wird mit wachsenden Abständen neu verbunden; offline arbeitet das Dokument einfach lokal weiter.
 */
import * as Y from 'yjs'
import { blobKeyOf, neededAssetKeys } from './gridFile'
import { getBlob, putBlob } from './blobStore'
import { filesOf } from './model'

export type SyncStatus = 'connecting' | 'online' | 'offline' | 'denied'
export interface SyncState { status: SyncStatus; reason?: string }

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

// ---------- Zugangsschlüssel (nicht in der Dokumentdatei) ----------

const TOKENS = 'grid-sync-tokens'
const readTokens = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(TOKENS) ?? '{}') } catch { return {} } }
export const tokenFor = (server: string) => readTokens()[normalizeServer(server)] ?? ''
export const rememberToken = (server: string, token: string) => {
  try { localStorage.setItem(TOKENS, JSON.stringify({ ...readTokens(), [normalizeServer(server)]: token })) } catch { /* egal */ }
}

// ---------- Server-Abfragen (Dokumentliste, Dateien) ----------

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

export interface CloudDoc { id: string; name: string; updated: number }

export async function listCloudDocs(server: string, token: string): Promise<CloudDoc[]> {
  const r = await fetch(`${normalizeServer(server)}/docs`, { headers: auth(token) })
  if (r.status === 401) throw new Error('Zugangsschlüssel falsch')
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

  constructor(
    private doc: Y.Doc,
    private cfg: { server: string; token: string; docId: string; name: string },
    private onState: (s: SyncState) => void,
  ) {
    doc.on('update', this.onLocal)
    filesOf(doc).observe(this.onFilesChanged)
    this.open()
  }

  private onLocal = (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE || !this.online) return
    this.ws?.send(frame(UPDATE, update))
  }

  private onFilesChanged = () => {
    clearTimeout(this.blobTimer)
    this.blobTimer = setTimeout(() => void this.syncBlobs(), 300)
  }

  private open() {
    if (this.stopped) return
    this.onState({ status: 'connecting' })
    let ws: WebSocket
    try { ws = new WebSocket(toWsUrl(this.cfg.server, this.cfg.docId)) } catch { return this.lost() }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', token: this.cfg.token, name: this.cfg.name }))
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data)
        if (m.t === 'ok') {
          this.online = true
          this.attempt = 0
          this.onState({ status: 'online' })
          ws.send(frame(STEP1, Y.encodeStateVector(this.doc)))
          void this.syncBlobs()
        } else if (m.t === 'denied') {
          this.stopped = true // mit falschem Schlüssel hilft Wiederholen nicht
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
    this.retry = setTimeout(() => this.open(), wait)
  }

  /** Dateien abgleichen: was der Server nicht hat, hochladen; was hier fehlt, herunterladen. */
  syncBlobs(): Promise<void> {
    this.blobRun = this.blobRun.then(async () => {
      if (!this.online) return
      const base = `${normalizeServer(this.cfg.server)}`
      const headers = auth(this.cfg.token)
      try {
        const r = await fetch(`${base}/blobs/${this.cfg.docId}`, { headers })
        if (!r.ok) return
        const remote = new Set<string>(await r.json())
        for (const key of neededAssetKeys(this.doc)) {
          const local = await getBlob(blobKeyOf(key))
          if (local && !remote.has(key)) {
            await fetch(`${base}/blob/${this.cfg.docId}/${key}`, { method: 'PUT', headers, body: local })
          } else if (!local && remote.has(key)) {
            const d = await fetch(`${base}/blob/${this.cfg.docId}/${key}`, { headers })
            if (d.ok) await putBlob(blobKeyOf(key), await d.blob())
          }
        }
      } catch { /* beim nächsten Verbinden erneut */ }
    })
    return this.blobRun
  }

  close() {
    this.stopped = true
    this.online = false
    clearTimeout(this.retry)
    clearTimeout(this.blobTimer)
    this.doc.off('update', this.onLocal)
    filesOf(this.doc).unobserve(this.onFilesChanged)
    const ws = this.ws
    this.ws = null
    ws?.close()
  }
}
