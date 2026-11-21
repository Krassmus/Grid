/**
 * Das .grid-Dateiformat (eine SQLite-Datenbank) wird in Rust geschrieben und gelesen
 * (src-tauri/src/grid_file.rs). Hier: Zusammenstellen des Binärpakets für die IPC-Schnittstelle und das Einlesen.
 *
 * Maßgeblich beim Öffnen ist der CRDT-Zustand (Protokoll `ydoc_log`); die Datentabellen (siehe tableSync.ts)
 * sind eine abgeleitete Sicht für Auswertungen mit normalen SQLite-Werkzeugen.
 * Ältere Dateien (ZIP) werden beim Öffnen erkannt (`legacy`) und beim ersten Speichern umgewandelt.
 */
import * as Y from 'yjs'
import { invoke } from '@tauri-apps/api/core'
import { filesOf } from './model'
import { fullOps, type Ops } from './tableSync'
import { getBlob, hasBlob, putBlob, thumbKey } from './blobStore'

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export interface GridMeta {
  format: 'grid'
  formatVersion: 2
  docId: string
  createdAt: string
  savedAt?: string
  app?: string
}

export const newMeta = (): GridMeta => ({
  format: 'grid', formatVersion: 2, docId: crypto.randomUUID(), createdAt: new Date().toISOString(),
})

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

/** Dateien, die das Dokument braucht und die `known` (schon in der Datei) noch nicht hat, mit ihren Bytes; Unauffindbares entfällt. */
export async function newAssets(doc: Y.Doc, known: Set<string>, get: BlobGetter = getBlob) {
  const list: { key: string; bytes: Uint8Array }[] = []
  for (const hash of referencedHashes(doc)) {
    for (const key of assetKeysOf(hash)) {
      if (known.has(key)) continue
      const blob = await get(blobKeyOf(key))
      if (blob) list.push({ key, bytes: new Uint8Array(await blob.arrayBuffer()) }) // fehlt z. B. noch von einem anderen Gerät
    }
  }
  return list
}

/** Alle Asset-Schlüssel, die das Dokument braucht (alles andere darf aus der Datei entfallen). */
export const neededAssetKeys = (doc: Y.Doc) => [...referencedHashes(doc)].flatMap(assetKeysOf)

export interface SaveOptions {
  /** Datei neu anlegen (alle Tabellen und Dateien); sonst nur `ops` und die neuen Updates anhängen. */
  full?: boolean
  /** Updates für das Protokoll; bei `compact` ein Gesamtzustand, der es ersetzt. */
  updates: Uint8Array[]
  compact?: boolean
  ops?: Ops
}

/** Stellt das Speicherpaket zusammen. Liefert auch, welche Asset-Schlüssel danach in der Datei liegen. */
export async function buildSaveBundle(doc: Y.Doc, meta: GridMeta, known: Set<string>, opts: SaveOptions, get: BlobGetter = getBlob) {
  const assets = await newAssets(doc, opts.full ? new Set() : known, get)
  const ops: Ops = opts.full ? fullOps(doc) : { ...opts.ops }
  if (opts.full || opts.compact) ops.pruneAssets = neededAssetKeys(doc) // nicht mehr benutzte Dateien entfallen
  const header = {
    meta: { ...meta, savedAt: new Date().toISOString(), app: 'Grid' },
    full: !!opts.full,
    compact: !!opts.compact,
    ops,
    updates: opts.updates.map((u) => u.length),
    assets: assets.map((a) => ({ key: a.key, len: a.bytes.length })),
  }
  const keys = new Set(opts.full ? [] : known)
  for (const a of assets) keys.add(a.key)
  return { bytes: encodeBundle(header, [...opts.updates, ...assets.map((a) => a.bytes)]), keys }
}

const pathHeader = (path: string) => ({ headers: { 'x-path': encodeURIComponent(path) } })

/** Schreibt das Dokument komplett nach `path` (neue Datei, „Speichern unter“, Umwandlung alter Dateien). Liefert die Asset-Namen in der Datei. */
export async function writeGrid(path: string, doc: Y.Doc, meta: GridMeta, _known: Set<string> = new Set()): Promise<Set<string>> {
  const { bytes, keys } = await buildSaveBundle(doc, meta, new Set(), { full: true, updates: [Y.encodeStateAsUpdate(doc)] })
  await invoke<number>('grid_save', bytes, pathHeader(path))
  return keys
}

/** Hängt Änderungen an die vorhandene Datei an. Liefert Asset-Namen in der Datei und die Länge des Protokolls. */
export async function appendGrid(path: string, doc: Y.Doc, meta: GridMeta, known: Set<string>, opts: SaveOptions) {
  const { bytes, keys } = await buildSaveBundle(doc, meta, known, opts)
  const logEntries = await invoke<number>('grid_save', bytes, pathHeader(path))
  return { keys, logEntries }
}

export interface OpenedGrid { doc: Y.Doc; meta: GridMeta; known: Set<string>; /** altes ZIP-Format: beim ersten Speichern umwandeln */ legacy: boolean }

/** Liest eine .grid-Datei, legt die Dateien im lokalen Blob-Speicher ab (zur Anzeige) und baut das Dokument auf. */
export async function readGrid(path: string): Promise<OpenedGrid> {
  const buf = await invoke<ArrayBuffer>('grid_open', new Uint8Array(0), pathHeader(path))
  const { header, bin } = decodeBundle<{ meta: GridMeta; legacy: boolean; updates: number[]; assets: { key: string; len: number }[] }>(buf)
  const doc = new Y.Doc()
  let at = 0
  for (const len of header.updates) {
    Y.applyUpdate(doc, bin.subarray(at, at + len))
    at += len
  }

  const mimes = new Map<string, string>()
  filesOf(doc).forEach((m, key) => mimes.set(key.split('|')[3], m.mime))
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
  return { doc, meta: header.meta, known, legacy: !!header.legacy }
}

export const baseName = (path: string) => (path.split(/[\\/]/).pop() ?? path).replace(/\.grid$/i, '')
