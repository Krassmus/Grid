import { FILE } from './columnTypes'
import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { addFile, moveFile, removeFile, type CellSlot, type ColumnInfo, type FileRef } from './model'
import { getBlob, onBlobStored, storeFile, thumbKey, typedBlob } from './blobStore'
import { ConfirmDialog, Modal } from './Modal'
import { AnimItem, useAnimatedList } from './animatedList'

/** Aktuell gezogene Datei (dataTransfer ist in dragover nicht lesbar, daher Modulvariable). */
let draggingFile: { slot: CellSlot; file: FileRef } | null = null

const fmtSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`
const ext = (name: string) => (name.includes('.') ? name.split('.').pop()!.slice(0, 4).toUpperCase() : 'DATEI')

/** Lädt den ersten vorhandenen Blob aus `keys` und liefert eine Object-URL (wird beim Aufräumen freigegeben). */
export function useBlobUrl(keys: string[]): { url: string | null; missing: boolean } {
  const [state, setState] = useState<{ url: string | null; missing: boolean }>({ url: null, missing: false })
  const dep = keys.join('|')
  const [retry, setRetry] = useState(0)
  // Fehlt der Blob noch (kommt vielleicht gleich aus der Cloud), bei jedem neuen Blob erneut versuchen.
  useEffect(() => (state.missing ? onBlobStored(() => setRetry((n) => n + 1)) : undefined), [state.missing])
  useEffect(() => {
    let alive = true
    let url: string | null = null
    ;(async () => {
      for (const k of keys) {
        const blob = await getBlob(k)
        if (blob && alive) { const shown = await typedBlob(blob); if (!alive) return; url = URL.createObjectURL(shown); setState({ url, missing: false }); return }
      }
      if (alive) setState({ url: null, missing: true })
    })()
    return () => { alive = false; if (url) URL.revokeObjectURL(url) }
  }, [dep, retry])
  return state
}

async function download(ref: FileRef): Promise<boolean> {
  const blob = await getBlob(ref.hash)
  if (!blob) return false
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = ref.name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return true
}

function FileChip(props: { file: FileRef; slot: CellSlot; onOpen: () => void; onRemove: () => void }) {
  const { file } = props
  const [isDragging, setIsDragging] = useState(false)
  const isImage = file.mime.startsWith('image/')
  const { url, missing } = useBlobUrl(isImage ? [thumbKey(file.hash), file.hash] : [file.hash])
  // Bilder: nur das Vorschaubild. Name und Größe stehen im Vorschau-Dialog.
  const imageOnly = isImage && !!url
  return (
    <div className={`filechip ${imageOnly ? 'image-only' : ''} ${missing ? 'missing' : ''} ${isDragging ? 'dragging' : ''}`} onClick={props.onOpen}
      draggable
      onDragStart={(e) => {
        draggingFile = { slot: props.slot, file }
        e.dataTransfer.effectAllowed = 'copyMove'
        e.dataTransfer.setData('text/plain', file.name)
        setIsDragging(true)
      }}
      onDragEnd={() => { draggingFile = null; setIsDragging(false) }}
      title={missing ? `${file.name} – noch nicht auf diesem Gerät` : file.name}>
      {imageOnly
        ? <img className="thumb" src={url!} alt={file.name} />
        : <div className="ext">{isImage ? 'BILD' : ext(file.name)}</div>}
      {!imageOnly && !isImage && <div className="file-name">{file.name}</div>}
      <button type="button" className="tile-x" title="Datei entfernen"
        onClick={(e) => { e.stopPropagation(); props.onRemove() }}>✕</button>
    </div>
  )
}

function Preview({ file, onClose }: { file: FileRef; onClose: () => void }) {
  const { url, missing } = useBlobUrl([file.hash])
  const [err, setErr] = useState(false)
  return (
    <Modal onClose={onClose}>
      <div className="dialog preview" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div>
          <h3>{file.name}</h3>
          <div className="preview-meta">{file.mime} · {fmtSize(file.size)}</div>
        </div>
        <div className="preview-body">
          {url && file.mime.startsWith('image/') && <img src={url} alt={file.name} />}
          {url && !file.mime.startsWith('image/') && <p className="hint">Keine Vorschau verfügbar.</p>}
          {missing && <p className="hint">Diese Datei ist auf diesem Gerät noch nicht vorhanden.</p>}
          {err && <p className="hint">Download fehlgeschlagen.</p>}
        </div>
        <div className="actions">
          <button type="button" disabled={!url} onClick={async () => setErr(!(await download(file)))}>Speichern</button>
          <button type="button" autoFocus className="primary" onClick={onClose}>Schließen</button>
        </div>
      </div>
    </Modal>
  )
}

export function FileCell(props: {
  doc: Y.Doc
  tableId: string
  rowId: string
  col: ColumnInfo
  index: Map<string, FileRef[]>
}) {
  const { doc, tableId, rowId, col, index } = props
  const files = index.get(`${rowId}|${col.id}`) ?? []
  const slot: CellSlot = { tableId, rowId, colId: col.id }
  const anim = useAnimatedList(files, (f) => f.hash)
  const acceptsInternal = () => !!draggingFile && !(draggingFile.slot.rowId === rowId && draggingFile.slot.colId === col.id)
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<FileRef | null>(null)
  const [removing, setRemoving] = useState<FileRef | null>(null)

  const cfg = FILE.config(col)
  const full = cfg.single && files.length >= 1
  const upload = async (list: FileList | File[]) => {
    setError(null)
    let picked = Array.from(list)
    if (cfg.accept === 'images') {
      const images = picked.filter((f) => f.type.startsWith('image/'))
      if (images.length < picked.length) setError('In dieser Spalte sind nur Bilder erlaubt')
      picked = images
    }
    if (cfg.single) {
      if (files.length >= 1) { setError('In dieser Spalte ist nur eine Datei erlaubt'); return }
      if (picked.length > 1) { setError('In dieser Spalte ist nur eine Datei erlaubt'); picked = picked.slice(0, 1) }
    }
    await Promise.all(picked.map(async (f) => {
      setBusy((n) => n + 1)
      try {
        const { ref, saved } = await storeFile(f)
        addFile(doc, tableId, rowId, col.id, ref) // Chip erscheint sofort (mit Vorschaubild)
        await saved // Original wird im Hintergrund geschrieben
      } catch (e) {
        setError(`„${f.name}“ konnte nicht gespeichert werden`)
        console.error(e)
      } finally {
        setBusy((n) => n - 1)
      }
    }))
  }

  return (
    <div className={`c filecell ${cfg.accept === 'images' ? 'images' : ''} ${over ? 'over' : ''}`}
      onDragOver={(e) => {
        if (acceptsInternal()) { e.preventDefault(); e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move'; setOver(true) }
        else if (!draggingFile && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true) }
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false) }}
      onDrop={(e) => {
        setOver(false)
        if (draggingFile) { // Datei aus einer anderen Zelle: verschieben (Alt/Option = kopieren)
          if (!acceptsInternal()) return
          e.preventDefault()
          const d = draggingFile
          draggingFile = null
          moveFile(doc, d.slot, slot, d.file, e.altKey)
        } else if (e.dataTransfer.files.length) { // Dateien aus dem Finder: hochladen
          e.preventDefault()
          upload(e.dataTransfer.files)
        }
      }}>
      <div className="tiles">
        {anim.entries.map((e) => (
          <AnimItem key={e.key} phase={e.phase} onExited={() => anim.done(e.key)}>
            <FileChip file={e.item} slot={slot} onOpen={() => setPreview(e.item)}
              onRemove={() => setRemoving(e.item)} />
          </AnimItem>
        ))}
        {!full && <button type="button" className="add-tile" title="Datei hinzufügen (oder hierher ziehen)"
          onClick={() => input.current?.click()}>+</button>}
        {busy > 0 && <span className="hint">lädt …</span>}
        {error && <span className="hint err">{error}</span>}
      </div>
      <input ref={input} type="file" multiple={!cfg.single} accept={cfg.accept === 'images' ? 'image/*' : undefined} hidden
        onChange={(e) => { if (e.target.files) upload(e.target.files); e.target.value = '' }} />
      {preview && <Preview file={preview} onClose={() => setPreview(null)} />}
      {removing && (
        <ConfirmDialog detail={`„${removing.name}“`} onCancel={() => setRemoving(null)}
          onConfirm={() => { removeFile(doc, tableId, rowId, col.id, removing.hash); setRemoving(null) }} />
      )}
    </div>
  )
}
