/**
 * Das .grid-Dateiformat (ZIP mit meta.json, data.sqlite und assets/) wird in Rust geschrieben und gelesen
 * (src-tauri/src/grid_file.rs). Hier: Zusammenstellen des Binärpakets für die IPC-Schnittstelle,
 * die lesbare relationale Abbildung des Dokuments (landet als Tabellen in data.sqlite) und das Einlesen.
 *
 * Maßgeblich beim Öffnen ist der CRDT-Zustand (Tabelle `ydoc`); die übrigen SQLite-Tabellen sind
 * eine abgeleitete Sicht für Auswertungen mit normalen SQLite-Werkzeugen.
 */
import * as Y from 'yjs'
import { invoke } from '@tauri-apps/api/core'
import { filesOf, linksOf, readTables, tablesOf } from './model'
import { getBlob, hasBlob, putBlob, thumbKey } from './blobStore'

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export interface GridMeta {
  format: 'grid'
  formatVersion: 1
  docId: string
  createdAt: string
  savedAt?: string
  app?: string
}

export const newMeta = (): GridMeta => ({
  format: 'grid', formatVersion: 1, docId: crypto.randomUUID(), createdAt: new Date().toISOString(),
})

// ---------- Abbildung für SQLite ----------

export function projectionOf(doc: Y.Doc) {
  const tables = readTables(doc)
  const cells: [string, string, string, string | number][] = []
  for (const t of tables) {
    const colIds = new Set(t.columns.map((c) => c.id))
    const rows: Y.Map<Y.Map<any>> = tablesOf(doc).get(t.id)!.get('rows')
    for (const rid of t.rowIds) {
      rows.get(rid)?.forEach((v, col) => {
        if (colIds.has(col) && (typeof v === 'string' || typeof v === 'number')) cells.push([t.id, rid, col, v])
      })
    }
  }
  const links: [string, string, string, string, number][] = []
  linksOf(doc).forEach((v, key) => {
    const [t, r, c, x] = key.split('|')
    links.push([t, r, c, x, typeof v === 'number' ? v : 0])
  })
  const files: [string, string, string, string, string, number, string][] = []
  filesOf(doc).forEach((m, key) => {
    const [t, r, c, h] = key.split('|')
    files.push([t, r, c, h, m.name, m.size, m.mime])
  })
  return {
    tables: tables.map((t) => ({
      id: t.id, name: t.name, rows: t.rowIds,
      columns: t.columns.map((c) => ({
        id: c.id, name: c.name, type: c.type, target: c.target ?? null, width: c.width ?? null,
        options: (c.options ?? []).map((o) => ({ id: o.id, name: o.name, color: o.color })),
      })),
    })),
    cells, links, files,
  }
}

// ---------- Binärpaket: u32 Länge, JSON, Binärdaten ----------

export function encodeBundle(header: unknown, chunks: Uint8Array[]): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header))
  const total = 4 + json.length + chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  new DataView(out.buffer).setUint32(0, json.length)
  out.set(json, 4)
  let at = 4 + json.length
  for (const c of chunks) { out.set(c, at); at += c.length }
  return out
}

export function decodeBundle<H>(buf: ArrayBuffer | Uint8Array): { header: H; bin: Uint8Array } {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + n))) as H
  return { header, bin: bytes.subarray(4 + n) }
}

// ---------- Assets ----------

/** Asset-Namen im Archiv: `<hash>` für das Original, `<hash>.thumb` für das Vorschaubild. */
export const assetKeysOf = (hash: string) => [hash, `${hash}.thumb`]
const blobKeyOf = (assetKey: string) => (assetKey.endsWith('.thumb') ? thumbKey(assetKey.slice(0, -6)) : assetKey)

export function referencedHashes(doc: Y.Doc): Set<string> {
  const out = new Set<string>()
  filesOf(doc).forEach((_, key) => out.add(key.split('|')[3]))
  return out
}

type BlobGetter = (key: string) => Promise<Blob | undefined>

/**
 * Stellt das Speicherpaket zusammen. Nur vom Dokument referenzierte Dateien kommen in die Datei
 * (nicht mehr benutzte entfallen so beim nächsten Speichern). Was `known` schon im Zielarchiv liegt,
 * wird nicht erneut gesendet, sondern dort übernommen.
 */
export async function buildSaveBundle(doc: Y.Doc, meta: GridMeta, known: Set<string>, get: BlobGetter = getBlob) {
  const assets: { key: string; len: number; keep?: boolean }[] = []
  const chunks: Uint8Array[] = []
  const keys = new Set<string>()
  for (const hash of referencedHashes(doc)) {
    for (const key of assetKeysOf(hash)) {
      if (known.has(key)) { assets.push({ key, len: 0, keep: true }); keys.add(key); continue }
      const blob = await get(blobKeyOf(key))
      if (!blob) continue // z. B. von einem anderen Gerät, noch nicht heruntergeladen
      const bytes = new Uint8Array(await blob.arrayBuffer())
      assets.push({ key, len: bytes.length }); chunks.push(bytes); keys.add(key)
    }
  }
  const ydoc = Y.encodeStateAsUpdate(doc)
  const header = {
    meta: { ...meta, savedAt: new Date().toISOString(), app: 'Grid' },
    projection: projectionOf(doc),
    ydocLen: ydoc.length,
    assets,
  }
  return { bytes: encodeBundle(header, [ydoc, ...chunks]), keys }
}

const pathHeader = (path: string) => ({ headers: { 'x-path': encodeURIComponent(path) } })

/** Schreibt das Dokument nach `path`. Liefert die Asset-Namen, die jetzt in der Datei liegen. */
export async function writeGrid(path: string, doc: Y.Doc, meta: GridMeta, known: Set<string>): Promise<Set<string>> {
  const { bytes, keys } = await buildSaveBundle(doc, meta, known)
  await invoke('grid_save', bytes, pathHeader(path))
  return keys
}

export interface OpenedGrid { doc: Y.Doc; meta: GridMeta; known: Set<string> }

/** Liest eine .grid-Datei, legt die Dateien im lokalen Blob-Speicher ab (zur Anzeige) und baut das Dokument auf. */
export async function readGrid(path: string): Promise<OpenedGrid> {
  const buf = await invoke<ArrayBuffer>('grid_open', new Uint8Array(0), pathHeader(path))
  const { header, bin } = decodeBundle<{ meta: GridMeta; ydocLen: number; assets: { key: string; len: number }[] }>(buf)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, bin.slice(0, header.ydocLen))

  const mimes = new Map<string, string>()
  filesOf(doc).forEach((m, key) => mimes.set(key.split('|')[3], m.mime))
  let at = header.ydocLen
  const known = new Set<string>()
  for (const a of header.assets) {
    const bytes = bin.slice(at, at + a.len)
    at += a.len
    known.add(a.key)
    const key = blobKeyOf(a.key)
    if (!(await hasBlob(key))) {
      const type = a.key.endsWith('.thumb') ? 'image/jpeg' : mimes.get(a.key) ?? 'application/octet-stream'
      await putBlob(key, new Blob([bytes], { type }))
    }
  }
  return { doc, meta: header.meta, known }
}

export const baseName = (path: string) => (path.split(/[\\/]/).pop() ?? path).replace(/\.grid$/i, '')
