/**
 * Inhaltsadressierter Blob-Speicher (Schlüssel = SHA-256-Hash der Bytes).
 * Prototyp: IndexedDB der WebView, gemeinsam für alle Dokumente/Clients im Fenster.
 * Später: Dateisystem (Tauri/Rust) + Abgleich mit S3-kompatiblem Server.
 */

const DB_NAME = 'grid-blobs'
const STORE = 'blobs'
let dbPromise: Promise<IDBDatabase> | undefined

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db()
  return new Promise<T>((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export const putBlob = (key: string, blob: Blob) => run('readwrite', (s) => s.put(blob, key)).then(() => undefined)
/** Noch laufende Schreibvorgänge (Hash -> Promise): Leser warten darauf, statt "fehlt" zu melden. */
const pending = new Map<string, Promise<unknown>>()

export const getBlob = async (key: string) => {
  await pending.get(key)
  return run<Blob | undefined>('readonly', (s) => s.get(key))
}
export const hasBlob = async (key: string) => (await run<IDBValidKey | undefined>('readonly', (s) => s.getKey(key))) !== undefined

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export const thumbKey = (hash: string) => `${hash}:thumb`

/** Kleines JPEG-Vorschaubild für Bilder; null, wenn es kein (dekodierbares) Bild ist. */
export async function makeThumb(file: Blob, max = 160): Promise<Blob | null> {
  if (!file.type.startsWith('image/')) return null
  try {
    // Mit resizeWidth wird schon beim Dekodieren verkleinert (viel schneller als das volle Bild zu laden).
    const bmp = await createImageBitmap(file, { resizeWidth: max, resizeQuality: 'low' }).catch(() => createImageBitmap(file))
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bmp.width * scale))
    canvas.height = Math.max(1, Math.round(bmp.height * scale))
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    bmp.close()
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.82))
  } catch {
    return null
  }
}

export interface StoredFile {
  ref: { hash: string; name: string; size: number; mime: string }
  /** Erst wenn dieses Promise erfüllt ist, liegt das Original dauerhaft im Speicher. */
  saved: Promise<void>
}

/**
 * Bereitet die Datei vor und liefert die Referenz so früh wie möglich:
 * Vorschaubild und Hash sind fertig, das (große) Original wird im Hintergrund geschrieben.
 */
export async function storeFile(file: File): Promise<StoredFile> {
  const [buf, thumb] = await Promise.all([file.arrayBuffer(), makeThumb(file)])
  const hash = await sha256Hex(buf)
  const mime = file.type || 'application/octet-stream'

  const saved = hasBlob(hash).then((has) => (has ? undefined : putBlob(hash, new Blob([buf], { type: mime }))))
  pending.set(hash, saved.catch(() => undefined))
  saved.then(() => undefined, () => undefined).finally(() => pending.delete(hash))

  if (thumb) await putBlob(thumbKey(hash), thumb)
  return { ref: { hash, name: file.name, size: file.size, mime }, saved }
}
