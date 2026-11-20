import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as Y from 'yjs'
import { addFile, addLink, createRecord, isComputed, removeFile, removeLink, setCell, type CellValue, type ColumnInfo, type FileRef, type TableInfo } from './model'
import { storeFile, thumbKey } from './blobStore'
import { useBlobUrl } from './FileCell'
import { CHECKBOX, DATE, FILE, GEO, NUMBER, TEXT } from './columnTypes'
import { GEO_FORMATS, encodeGeo, decodeGeo, formatGeo, parseGeo } from './geo'
import { toInputValue } from './dateFormat'
import { Modal } from './Modal'
import { RichField } from './richText'

/** Spalten, die im Formular ausgefüllt werden können; Berechnetes und Ausgeblendetes nicht. */
export const formColumns = (table: TableInfo): ColumnInfo[] => table.columns.filter((c) => !isComputed(c) && !c.hidden)

/** Zusätzlich zu den Zellwerten: gewählte Dateien und Verknüpfungen, je Spalte. */
export interface RecordExtras {
  /** Neu hinzugefügte Dateien */
  files: Record<string, File[]>
  /** Bei Relationen die gewünschten Zielzeilen (beim Anlegen alle, beim Bearbeiten der neue Gesamtzustand) */
  relations: Record<string, string[]>
  /** Beim Bearbeiten: Hashes bisheriger Dateien, die entfernt werden sollen */
  removedFiles?: Record<string, string[]>
}

/** Was eine bestehende Zeile schon hat (beim Bearbeiten). */
export interface ExistingRecord { files: Record<string, FileRef[]>; relations: Record<string, string[]> }

/**
 * Wendet das Formular auf eine bestehende Zeile an: nur geänderte Werte werden geschrieben (gleichzeitige Änderungen anderer
 * bleiben so erhalten), neue Dateien kommen hinzu, entfernte gehen, Verknüpfungen werden abgeglichen. Alles in einer Änderung.
 */
export async function updateRecord(
  doc: Y.Doc, tableId: string, rowId: string,
  values: Record<string, CellValue>, original: Record<string, CellValue>,
  extras: RecordExtras, previousRelations: Record<string, string[]>,
): Promise<void> {
  const stored = await Promise.all(Object.entries(extras.files).flatMap(([col, list]) => list.map(async (f) => ({ col, ...(await storeFile(f)) }))))
  doc.transact(() => {
    for (const [col, v] of Object.entries(values)) if ((v ?? null) !== (original[col] ?? null)) setCell(doc, tableId, rowId, col, v ?? null)
    for (const s of stored) addFile(doc, tableId, rowId, s.col, s.ref)
    for (const [col, hashes] of Object.entries(extras.removedFiles ?? {})) for (const h of hashes) removeFile(doc, tableId, rowId, col, h)
    for (const [col, next] of Object.entries(extras.relations)) {
      const prev = previousRelations[col] ?? []
      for (const t of next) if (!prev.includes(t)) addLink(doc, tableId, rowId, col, t)
      for (const t of prev) if (!next.includes(t)) removeLink(doc, tableId, rowId, col, t)
    }
  })
  await Promise.all(stored.map((s) => s.saved))
}

/**
 * Legt die Zeile samt Dateien und Verknüpfungen an. Dateien werden zuerst im lokalen Speicher abgelegt; danach geschieht
 * alles andere in einer einzigen Änderung (auch `inTx`, z. B. die Verknüpfung der neuen Zeile mit ihrer Quelle).
 */
export async function commitRecord(doc: Y.Doc, tableId: string, values: Record<string, CellValue>, extras: RecordExtras, inTx?: (id: string) => void): Promise<string> {
  const stored = await Promise.all(Object.entries(extras.files).flatMap(([col, list]) => list.map(async (f) => ({ col, ...(await storeFile(f)) }))))
  let id = ''
  doc.transact(() => {
    id = createRecord(doc, tableId, values)
    for (const s of stored) addFile(doc, tableId, id, s.col, s.ref)
    for (const [col, targets] of Object.entries(extras.relations)) for (const t of targets) addLink(doc, tableId, id, col, t)
    inTx?.(id)
  })
  await Promise.all(stored.map((s) => s.saved)) // Originale werden im Hintergrund geschrieben
  return id
}

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`)

/** Dateifeld des Formulars: Auswahl über den Dateidialog oder per Ziehen; gespeichert wird erst beim Anlegen. */
function ExistingFile({ file, onRemove }: { file: FileRef; onRemove: () => void }) {
  const isImage = file.mime.startsWith('image/')
  const { url } = useBlobUrl(isImage ? [thumbKey(file.hash), file.hash] : [])
  return (
    <div className="rf-file">
      {url ? <img src={url} alt="" /> : <span className="rf-ext">{file.name.includes('.') ? file.name.split('.').pop()!.slice(0, 4).toUpperCase() : 'DATEI'}</span>}
      <span className="rf-name" title={file.name}>{file.name}</span>
      <small>{fmtSize(file.size)}</small>
      <button type="button" className="tile-x" title="Entfernen" onClick={onRemove}>✕</button>
    </div>
  )
}

function FileField({ col, files, onChange, existing = [], onRemoveExisting }: {
  col: ColumnInfo; files: File[]; onChange: (f: (prev: File[]) => File[]) => void
  /** Bisherige Dateien (beim Bearbeiten), die nicht entfernt wurden */
  existing?: FileRef[]; onRemoveExisting?: (hash: string) => void
}) {
  const cfg = FILE.config(col)
  const input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const urls = useMemo(() => files.map((f) => (f.type.startsWith('image/') ? URL.createObjectURL(f) : null)), [files])
  useEffect(() => () => urls.forEach((u) => u && URL.revokeObjectURL(u)), [urls])
  const add = (list: FileList | File[]) => {
    setError(null)
    let picked = Array.from(list)
    if (cfg.accept === 'images') {
      const images = picked.filter((f) => f.type.startsWith('image/'))
      if (images.length < picked.length) setError('In dieser Spalte sind nur Bilder erlaubt')
      picked = images
    }
    if (cfg.single) {
      if (files.length + existing.length >= 1 || picked.length > 1) setError('In dieser Spalte ist nur eine Datei erlaubt')
      picked = files.length + existing.length >= 1 ? [] : picked.slice(0, 1)
    }
    if (picked.length) onChange((prev) => [...prev, ...picked])
  }
  const full = cfg.single && files.length + existing.length >= 1
  return (
    <div className={`rf-files${over ? ' over' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true) } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { setOver(false); if (e.dataTransfer.files.length) { e.preventDefault(); add(e.dataTransfer.files) } }}>
      {existing.map((f) => <ExistingFile key={f.hash} file={f} onRemove={() => onRemoveExisting?.(f.hash)} />)}
      {files.map((f, i) => (
        <div key={i} className="rf-file">
          {urls[i] ? <img src={urls[i]!} alt="" /> : <span className="rf-ext">{f.name.includes('.') ? f.name.split('.').pop()!.slice(0, 4).toUpperCase() : 'DATEI'}</span>}
          <span className="rf-name" title={f.name}>{f.name}</span>
          <small>{fmtSize(f.size)}</small>
          <button type="button" className="tile-x" title="Entfernen" onClick={() => onChange((prev) => prev.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      {!full && <button type="button" className="rf-add" onClick={() => input.current?.click()}>+ Datei hinzufügen</button>}
      {error && <small className="rf-error">{error}</small>}
      <input ref={input} type="file" hidden multiple={!cfg.single} accept={cfg.accept === 'images' ? 'image/*' : undefined}
        onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = '' }} />
    </div>
  )
}

/** Das Feld, in das ein Suchtext aus der Auswahl passt: die erste Textspalte. */
export const firstTextColumn = (table: TableInfo): ColumnInfo | undefined =>
  formColumns(table).find((c) => c.type === 'text' && TEXT.config(c).mode !== 'rich')

/**
 * Formular für eine Datenzeile: die Felder stehen untereinander. `initial` füllt Felder vor.
 * Es wird nichts gespeichert, bevor „Anlegen“ gedrückt wird.
 */
export function RecordForm(props: {
  table: TableInfo
  title: string
  initial?: Record<string, CellValue>
  submitLabel?: string
  /** Beim Bearbeiten: Dateien und Verknüpfungen, die die Zeile schon hat. */
  existing?: ExistingRecord
  /** Feld für eine Relationsspalte (Auswahl der Zielzeilen); fehlt es, werden Relationen im Formular ausgelassen. */
  relationField?: (col: ColumnInfo, ids: string[], update: (f: (prev: string[]) => string[]) => void) => ReactNode
  onSubmit: (values: Record<string, CellValue>, extras: RecordExtras) => void | Promise<void>
  onClose: () => void
}) {
  const cols = formColumns(props.table).filter((c) => c.type !== 'relation' || props.relationField)
  const [files, setFiles] = useState<Record<string, File[]>>({})
  const [rels, setRels] = useState<Record<string, string[]>>(() => ({ ...(props.existing?.relations ?? {}) }))
  const [removedFiles, setRemovedFiles] = useState<Record<string, string[]>>({})
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, CellValue>>(props.initial ?? {})
  const set = (col: string, v: CellValue) => setValues((s) => ({ ...s, [col]: v === '' ? null : v }))
  // Koordinaten werden als Text eingegeben und beim Anlegen geprüft
  const [geoText, setGeoText] = useState<Record<string, string>>(
    Object.fromEntries(cols.filter((c) => c.type === 'geo').map((c) => {
      const g = decodeGeo(props.initial?.[c.id])
      return [c.id, g ? formatGeo(g, GEO.config(c).format === 'map' ? 'dd' : GEO.config(c).format) : '']
    })),
  )
  const geoError = (c: ColumnInfo): string | null => {
    const t = geoText[c.id]?.trim()
    if (!t) return null
    const r = parseGeo(t, GEO.config(c).format === 'lonlat' ? 'lonlat' : 'latlon')
    return r.ok ? null : r.error
  }
  const invalid = cols.some((c) => c.type === 'geo' && geoError(c))

  const submit = async () => {
    if (invalid || busy) return
    const out: Record<string, CellValue> = { ...values }
    for (const c of cols) {
      if (c.type !== 'geo') continue
      const t = geoText[c.id]?.trim()
      const r = t ? parseGeo(t, GEO.config(c).format === 'lonlat' ? 'lonlat' : 'latlon') : null
      out[c.id] = r && r.ok ? encodeGeo(r.point) : null
    }
    setBusy(true)
    setFailure(null)
    try { await props.onSubmit(out, { files, relations: rels, removedFiles }) } catch (e) {
      setFailure(`Anlegen fehlgeschlagen: ${e}`)
      setBusy(false)
    }
  }

  const field = (c: ColumnInfo, first: boolean): ReactNode => {
    const v = values[c.id]
    switch (c.type) {
      case 'text': {
        const mode = TEXT.config(c).mode
        if (mode === 'rich') return <RichField value={typeof v === 'string' ? v : ''} onChange={(h) => set(c.id, h.replace(/<[^>]*>/g, '').trim() ? h : null)} />
        if (mode === 'multi') return <textarea rows={3} autoFocus={first} value={typeof v === 'string' ? v : ''} onChange={(e) => set(c.id, e.target.value)} />
        return <input autoFocus={first} value={typeof v === 'string' ? v : ''} onChange={(e) => set(c.id, e.target.value)} />
      }
      case 'number': {
        const cfg = NUMBER.config(c)
        return (
          <span className="rf-unit">
            <input autoFocus={first} type="number" step={cfg.decimals >= 0 ? 1 / 10 ** cfg.decimals : 'any'} value={typeof v === 'number' ? v : ''}
              onChange={(e) => set(c.id, e.target.value === '' ? null : Number(e.target.value))} />
            {cfg.unit && <span>{cfg.unit}</span>}
          </span>
        )
      }
      case 'date':
        return <input autoFocus={first} type={DATE.config(c).time ? 'datetime-local' : 'date'} value={toInputValue(v, DATE.config(c).time)} onChange={(e) => set(c.id, e.target.value || null)} />
      case 'select':
        return (
          <select value={typeof v === 'string' ? v : ''} onChange={(e) => set(c.id, e.target.value || null)}>
            <option value="">–</option>
            {(c.options ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        )
      case 'checkbox':
        return (
          <label className="cfg-check">
            <input type="checkbox" checked={!!v} onChange={(e) => set(c.id, e.target.checked ? 1 : null)} />
            <span>{CHECKBOX.config(c).label || 'Ja'}</span>
          </label>
        )
      case 'file':
        return (
          <FileField col={c} files={files[c.id] ?? []} onChange={(f) => setFiles((s) => ({ ...s, [c.id]: f(s[c.id] ?? []) }))}
            existing={(props.existing?.files[c.id] ?? []).filter((f) => !(removedFiles[c.id] ?? []).includes(f.hash))}
            onRemoveExisting={(h) => setRemovedFiles((s) => ({ ...s, [c.id]: [...(s[c.id] ?? []), h] }))} />
        )
      case 'relation':
        return props.relationField!(c, rels[c.id] ?? [], (f) => setRels((s) => ({ ...s, [c.id]: f(s[c.id] ?? []) })))
      case 'geo': {
        const f = GEO.config(c).format === 'map' ? 'dd' : GEO.config(c).format
        const err = geoError(c)
        return (
          <>
            <input autoFocus={first} value={geoText[c.id] ?? ''} spellCheck={false} placeholder={GEO_FORMATS.find((x) => x.id === f)?.example}
              onChange={(e) => setGeoText((s) => ({ ...s, [c.id]: e.target.value }))} />
            {err && <small className="rf-error">{err}</small>}
          </>
        )
      }
    }
    return null
  }
  return (
    <Modal onClose={props.onClose}>
      <form className="dialog recordform" onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); submit() }}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); props.onClose() } }}>
        <h3>{props.title}</h3>
        <div className="rf-fields">
          {cols.map((c, i) => (
            <div key={c.id} className="cfg-field">
              <span>{c.name}</span>
              {field(c, i === 0)}
            </div>
          ))}
          {cols.length === 0 && <p className="hint">Diese Tabelle hat keine Felder zum Ausfüllen. Der Datensatz wird leer angelegt.</p>}
        </div>
        {failure && <p className="formula-error" role="alert">{failure}</p>}
        <div className="actions">
          <button type="button" onClick={props.onClose}>Abbrechen</button>
          <button type="submit" className="primary" disabled={!!invalid || busy}>{busy ? 'Speichert …' : props.submitLabel ?? 'Anlegen'}</button>
        </div>
      </form>
    </Modal>
  )
}
