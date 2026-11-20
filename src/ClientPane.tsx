import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react'
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import {
  addColumn, addLink, addMap, addView, deleteMap, updateMap, buildFileIndex, buildLinkIndex, tablesOf, type CellValue, deleteView, updateView, addRow, addTable, deleteColumn, deleteRow, deleteTable, moveColumn, moveLink, moveTable, removeLink, renameColumn, isComputed, rowExists, setCell, setColumnWidth, summarize,
  type AggFn, type ColType, type ColumnInfo, type LinkIndex, type LinkSlot, type TableInfo,
} from './model'
import { useCell, useFileIndex, useLinkIndex, useRowVersion, useTabs } from './useTables'
import { FileCell } from './FileCell'
import { SelectCell } from './SelectCell'
import { ColumnDialog } from './ColumnDialog'
import { FooterCell } from './Footer'
import { GeoCell } from './GeoCell'
import { RecordForm, commitRecord, firstTextColumn, formColumns, updateRecord, type ExistingRecord } from './RecordForm'
import { ReprContext, TileContent, tileClasses, useReprs } from './ReprTile'
import { initials, reprMap, type Repr } from './repr'
import { columnCells, newCtx, type Cell as CellData } from './cells'
import { FormulaSyntaxError, parseFormula, parseTemplate } from './formula'
import { effectiveType } from './columnTypes'
import { ViewDialog } from './ViewDialog'
import { ViewGrid } from './ViewGrid'
import { MapView } from './MapView'
import { MapDialog } from './MapDialog'
import { aggLabel, allowedAggs, defaultAgg } from './aggregate'
import { sortedRowIds, type SortDir } from './sorting'
import { formatDate, toInputValue } from './dateFormat'
import { CHECKBOX, DATE, FILE, ROLLUP, NUMBER, RELATION, TEXT } from './columnTypes'
import { RichPreview, RichTextDialog } from './richText'
import { AnimItem, useAnimatedList } from './animatedList'
import { ConfirmDialog, Modal } from './Modal'
import { TableDialog } from './TableDialog'

// ---------- Kacheln ----------

/** Aktuell gezogene Verknüpfung (dataTransfer ist in dragover nicht lesbar, daher Modulvariable). */
interface DragInfo { slot: LinkSlot; targetRow: string; targetTable?: string }
let dragging: DragInfo | null = null

/** Gerade umsortierter Tab bzw. Spaltenkopf. */
type ReorderKind = 'table' | 'column'
let dragReorder: { kind: ReorderKind; id: string } | null = null
type DropHint = { kind: ReorderKind; id: string; side: 'before' | 'after' }

function Tile(props: {
  doc: Y.Doc
  table?: TableInfo
  rowId: string
  onRemove?: () => void
  onClick?: () => void
  muted?: boolean
  /** Wenn gesetzt, ist die Kachel in eine andere Relationszelle derselben Zieltabelle ziehbar. */
  drag?: { slot: LinkSlot; targetTable?: string }
  /** 'avatar': nur der Avatar (falls vorhanden); 'full': immer mit Titel (z. B. in der Auswahl). Sonst gilt die Darstellung der Tabelle. */
  display?: 'avatar' | 'full'
}) {
  const { doc, table, rowId } = props
  const [isDragging, setIsDragging] = useState(false)
  useRowVersion(doc, table?.id ?? '', rowId)
  const exists = !!table && rowExists(doc, table.id, rowId)
  const reprs = useReprs()
  const fromRepr = exists ? reprs(table!.id)?.get(rowId) : undefined
  const fallback = exists && !fromRepr ? summarize(doc, table!, rowId) : null // z. B. Tabelle ohne vorberechnete Darstellung
  const base = fromRepr ?? (fallback ? { title: fallback.title, subs: [], avatar: { text: initials(fallback.title) }, avatarInCells: false, subInCells: false } : null)
  const s = !base || !props.display ? base
    : props.display === 'full' ? { ...base, hideTitle: false }
    : base.avatar ? { ...base, hideTitle: true, subs: [], avatarInCells: true } : base
  return (
    <div className={`tile ${tileClasses(s)} ${exists ? '' : 'deleted'} ${props.onClick ? 'clickable' : ''} ${props.muted ? 'muted' : ''} ${isDragging ? 'dragging' : ''}`}
      title={s && exists ? [s.title, ...s.subs].join('\n') : undefined} // Text der Darstellung als Tooltip (wichtig bei „nur Avatar“)
      onClick={props.onClick}
      draggable={!!props.drag}
      onDragStart={props.drag ? (e) => {
        dragging = { slot: props.drag!.slot, targetRow: rowId, targetTable: props.drag!.targetTable }
        e.dataTransfer.effectAllowed = 'copyMove'
        e.dataTransfer.setData('text/plain', s?.title ?? '')
        setIsDragging(true)
      } : undefined}
      onDragEnd={props.drag ? () => { dragging = null; setIsDragging(false) } : undefined}>
      {s ? <TileContent repr={s} /> : <div className="tile-body"><div className="tile-title">gelöscht</div></div>}
      {props.onRemove && (
        <button type="button" className="tile-x" title="Verknüpfung entfernen"
          onClick={(e) => { e.stopPropagation(); props.onRemove!() }}>✕</button>
      )}
    </div>
  )
}

function Picker(props: {
  doc: Y.Doc
  tables: TableInfo[]
  /** Neuen Datensatz anlegen erlauben (nicht in der Auswahl innerhalb eines Formulars: dort würde er auch bei Abbruch bleiben). */
  allowCreate?: boolean
  target: TableInfo
  linked: string[]
  onPick: (rowId: string) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const reprs = useReprs()
  const rows = props.target.rowIds
    .filter((id) => !props.linked.includes(id))
    .filter((id) => {
      const s = reprs(props.target.id)?.get(id) ?? summarize(props.doc, props.target, id)
      return [s.title, ...s.subs].join(' ').toLowerCase().includes(q.toLowerCase())
    })
  return (
    <Modal onClose={props.onClose}>
      <div className="dialog picker" onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>Datensatz aus „{props.target.name}“ verknüpfen</h3>
        <input autoFocus placeholder="Suchen …" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="picker-list">
          {rows.map((id) => (
            <Tile key={id} doc={props.doc} table={props.target} rowId={id} display="full" onClick={() => props.onPick(id)} />
          ))}
          {rows.length === 0 && <p className="hint">Keine passenden Datensätze.</p>}
        </div>
        <div className="actions split">
          {props.allowCreate !== false ? <button type="button" onClick={() => setCreating(true)}>+ Neuer Datensatz …</button> : <span />}
          <button type="button" onClick={props.onClose}>Fertig</button>
        </div>
        {creating && (
          <RecordForm table={props.target} title={`Neuer Datensatz in „${props.target.name}“`}
            initial={q.trim() && firstTextColumn(props.target) ? { [firstTextColumn(props.target)!.id]: q.trim() } : undefined}
            onClose={() => setCreating(false)}
            relationField={(col, ids, update) => <RelationDraftField doc={props.doc} tables={props.tables} col={col} ids={ids} update={update} />}
            onSubmit={async (values, extras) => {
              // Anlegen (mit Dateien und Verknüpfungen) und Verknüpfen mit der Quelle in einem Schritt
              await commitRecord(props.doc, props.target.id, values, extras, (id) => props.onPick(id))
              setCreating(false)
              props.onClose()
            }} />
        )}
      </div>
    </Modal>
  )
}

/** Bestehenden Datensatz im Formular bearbeiten (Klick auf eine Kachel). Änderungen werden erst mit „Speichern“ übernommen. */
function EditRecordDialog(props: { doc: Y.Doc; tables: TableInfo[]; table: TableInfo; rowId: string; onClose: () => void }) {
  const { doc, tables, table, rowId } = props
  const reprs = useReprs()
  const title = reprs(table.id)?.get(rowId)?.title ?? summarize(doc, table, rowId).title
  // Stand beim Öffnen: Werte, Dateien, Verknüpfungen
  const [snap] = useState(() => {
    const row: Y.Map<any> | undefined = tablesOf(doc).get(table.id)?.get('rows').get(rowId)
    const values: Record<string, CellValue> = {}
    for (const c of formColumns(table)) if (c.type !== 'relation' && c.type !== 'file') values[c.id] = (row?.get(c.id) as CellValue | undefined) ?? null
    const links = buildLinkIndex(doc).forward, files = buildFileIndex(doc)
    const existing: ExistingRecord = { files: {}, relations: {} }
    for (const c of table.columns) {
      if (c.type === 'relation') existing.relations[c.id] = [...(links.get(`${rowId}|${c.id}`) ?? [])]
      if (c.type === 'file') existing.files[c.id] = [...(files.get(`${rowId}|${c.id}`) ?? [])]
    }
    return { values, existing }
  })
  return (
    <RecordForm table={table} title={`„${title}“ bearbeiten`} submitLabel="Speichern" initial={snap.values} existing={snap.existing}
      onClose={props.onClose}
      relationField={(col, ids, update) => <RelationDraftField doc={doc} tables={tables} col={col} ids={ids} update={update} />}
      onSubmit={async (values, extras) => {
        await updateRecord(doc, table.id, rowId, values, snap.values, extras, snap.existing.relations)
        props.onClose()
      }} />
  )
}

/** Relationsfeld im Formular: gewählte Zielzeilen als Kacheln, „+“ öffnet die Auswahl. Gespeichert wird erst beim Anlegen. */
function RelationDraftField(props: { doc: Y.Doc; tables: TableInfo[]; col: ColumnInfo; ids: string[]; update: (f: (prev: string[]) => string[]) => void }) {
  const { doc, tables, col, ids, update } = props
  const target = tables.find((t) => t.id === col.target)
  const [picking, setPicking] = useState(false)
  const single = RELATION.config(col).single
  return (
    <div className="tiles rf-tiles">
      {ids.map((id) => <Tile key={id} doc={doc} table={target} rowId={id} display={RELATION.config(col).display === 'avatar' ? 'avatar' : undefined} onRemove={() => update((p) => p.filter((x) => x !== id))} />)}
      {!(single && ids.length >= 1) && (
        <button type="button" className="add-tile" onClick={() => setPicking(true)} disabled={!target} title={target ? 'Datensatz verknüpfen' : 'Zieltabelle fehlt'}>+</button>
      )}
      {picking && target && (
        <Picker doc={doc} tables={tables} target={target} linked={ids} allowCreate={false}
          onPick={(id) => update((p) => (p.includes(id) ? p : [...p, id]))}
          onClose={() => setPicking(false)} />
      )}
    </div>
  )
}

function RelationCell(props: {
  doc: Y.Doc
  tables: TableInfo[]
  table: TableInfo
  rowId: string
  col: ColumnInfo
  index: LinkIndex
}) {
  const { doc, tables, table, rowId, col, index } = props
  const target = tables.find((t) => t.id === col.target)
  const ids = index.forward.get(`${rowId}|${col.id}`) ?? []
  const anim = useAnimatedList(ids, (id) => id)
  const [picking, setPicking] = useState(false)
  const [editingRow, setEditingRow] = useState<string | null>(null) // Datensatz im Formular öffnen
  const [over, setOver] = useState(false)
  const slot: LinkSlot = { tableId: table.id, rowId, colId: col.id }

  // Ablageziel: Kacheln derselben Zieltabelle (auch aus dieser Zelle: dann wird umsortiert)
  const accepts = () => !!dragging && !!col.target && dragging.targetTable === col.target
  const sameSlot = () => !!dragging && dragging.slot.tableId === table.id && dragging.slot.rowId === rowId && dragging.slot.colId === col.id
  const tilesEl = useRef<HTMLDivElement>(null)
  const [ins, setIns] = useState<{ left: number; top: number; height: number } | null>(null)
  /** Einfügestelle unter dem Mauszeiger: Index unter den angezeigten Kacheln und die Zeile, vor der eingefügt wird (null = ans Ende). */
  const dropSpot = (x: number, y: number) => {
    const box = tilesEl.current
    if (!box) return null
    const items = Array.from(box.children).filter((el) => !el.classList.contains('add-tile') && !el.classList.contains('drop-line')) as HTMLElement[]
    const rects = items.map((el) => el.getBoundingClientRect())
    let i = rects.length
    for (let k = 0; k < rects.length; k++) {
      const r = rects[k]
      if (y < r.top || (y <= r.bottom && x < r.left + r.width / 2)) { i = k; break }
    }
    const dragged = dragging?.targetRow
    const entries = anim.entries
    let before: string | null = null
    for (let k = i; k < entries.length; k++) if (entries[k].phase !== 'exit' && !(sameSlot() && entries[k].item === dragged)) { before = entries[k].item; break }
    const c = box.getBoundingClientRect()
    let line = null
    if (rects.length) {
      const r = rects[Math.min(i, rects.length - 1)]
      line = { left: (i < rects.length ? r.left - 4 : r.right + 4) - c.left, top: r.top - c.top, height: r.height }
    }
    return { before, line }
  }

  return (
    <div className={`c rel ${over ? 'drop-over' : ''}`}
      onDragOver={(e) => {
        if (!accepts()) return
        e.preventDefault()
        e.dataTransfer.dropEffect = sameSlot() ? 'move' : e.altKey ? 'copy' : 'move'
        if (!sameSlot()) setOver(true)
        setIns(dropSpot(e.clientX, e.clientY)?.line ?? null)
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) { setOver(false); setIns(null) } }}
      onDrop={(e) => {
        setOver(false)
        setIns(null)
        if (!accepts()) return
        e.preventDefault()
        const d = dragging!
        dragging = null
        const spot = dropSpot(e.clientX, e.clientY)
        moveLink(doc, d.slot, slot, d.targetRow, e.altKey, spot ? spot.before : undefined) // Alt/Option = kopieren statt verschieben
      }}>
      <div className="tiles" ref={tilesEl}>
        {ins && <i className="drop-line" style={ins} />}
        {anim.entries.map((e) => (
          <AnimItem key={e.key} phase={e.phase} onExited={() => anim.done(e.key)}>
            <Tile doc={doc} table={target} rowId={e.item}
              display={RELATION.config(col).display === 'avatar' ? 'avatar' : undefined}
              drag={{ slot, targetTable: col.target }}
              onClick={() => setEditingRow(e.item)}
              onRemove={() => removeLink(doc, table.id, rowId, col.id, e.item)} />
          </AnimItem>
        ))}
        {!(RELATION.config(col).single && ids.length >= 1) && <button type="button" className="add-tile" onClick={() => setPicking(true)} disabled={!target}
          title={target ? 'Datensatz verknüpfen' : 'Zieltabelle fehlt'}>+</button>}
      </div>
      {picking && target && (
        <Picker doc={doc} tables={tables} target={target} linked={ids}
          onPick={(id) => addLink(doc, table.id, rowId, col.id, id)}
          onClose={() => setPicking(false)} />
      )}
      {editingRow && target && rowExists(doc, target.id, editingRow) && (
        <EditRecordDialog doc={doc} tables={tables} table={target} rowId={editingRow} onClose={() => setEditingRow(null)} />
      )}
    </div>
  )
}

/** Rückverweise: schreibgeschützte Spalte, berechnet aus Relationen anderer Tabellen. */
function BacklinkCell(props: {
  doc: Y.Doc
  tables: TableInfo[]
  source: TableInfo
  rowId: string
  col: ColumnInfo
  index: LinkIndex
}) {
  const ids = (props.index.backward.get(`${props.rowId}|${props.col.id}`) ?? [])
    .filter((id) => rowExists(props.doc, props.source.id, id))
  const anim = useAnimatedList(ids, (id) => id)
  const [editingRow, setEditingRow] = useState<string | null>(null)
  return (
    <div className="c rel backlink">
      <div className="tiles">
        {anim.entries.map((e) => (
          <AnimItem key={e.key} phase={e.phase} onExited={() => anim.done(e.key)}>
            <Tile doc={props.doc} table={props.source} rowId={e.item} muted onClick={() => setEditingRow(e.item)} />
          </AnimItem>
        ))}
        {anim.entries.length === 0 && <span className="empty">–</span>}
      </div>
      {editingRow && rowExists(props.doc, props.source.id, editingRow) && (
        <EditRecordDialog doc={props.doc} tables={props.tables} table={props.source} rowId={editingRow} onClose={() => setEditingRow(null)} />
      )}
    </div>
  )
}

// ---------- Zellen ----------

function Cell({ doc, table, rowId, col }: { doc: Y.Doc; table: string; rowId: string; col: ColumnInfo; lead?: boolean }) {
  const value = useCell(doc, table, rowId, col.id)
  if (col.type === 'number') return <NumberInput doc={doc} table={table} rowId={rowId} col={col} value={value} />
  if (col.type === 'geo') return <GeoCell doc={doc} tableId={table} rowId={rowId} col={col} />
  if (col.type === 'checkbox') return <CheckboxInput doc={doc} table={table} rowId={rowId} col={col} value={value} />
  if (col.type === 'date') return <DateInput doc={doc} table={table} rowId={rowId} col={col} value={value} />
  return <TextInput doc={doc} table={table} rowId={rowId} col={col} value={value} />
}

function CheckboxInput({ doc, table, rowId, col, value }: { doc: Y.Doc; table: string; rowId: string; col: ColumnInfo; value: unknown }) {
  const label = CHECKBOX.config(col).label
  return (
    <div className="c">
      <label className="check-cell">
        <input type="checkbox" checked={!!value} aria-label={label || col.name}
          onChange={(e) => setCell(doc, table, rowId, col.id, e.target.checked ? 1 : null)} />
        {label && <span>{label}</span>}
      </label>
    </div>
  )
}

function DateInput({ doc, table, rowId, col, value }: { doc: Y.Doc; table: string; rowId: string; col: ColumnInfo; value: unknown }) {
  const cfg = DATE.config(col)
  const [editing, setEditing] = useState(false)
  const shown = formatDate(value, cfg.style, cfg.time)
  return (
    <div className="c">
      {editing ? (
        <input className="cell" autoFocus type={cfg.time ? 'datetime-local' : 'date'} value={toInputValue(value, cfg.time)}
          onChange={(e) => setCell(doc, table, rowId, col.id, e.target.value || null)}
          onBlur={() => setEditing(false)} onKeyDown={(e) => e.key === 'Enter' && setEditing(false)} />
      ) : (
        <button type="button" className="cell cell-date" onClick={() => setEditing(true)} onFocus={() => setEditing(true)}>
          {shown || <span className="placeholder">{col.name}</span>}
        </button>
      )}
    </div>
  )
}

function NumberInput({ doc, table, rowId, col, value }: { doc: Y.Doc; table: string; rowId: string; col: ColumnInfo; value: unknown }) {
  const cfg = NUMBER.config(col)
  const round = (n: number) => (cfg.decimals >= 0 ? Number(n.toFixed(cfg.decimals)) : n)
  return (
    <div className="c">
      <input className="cell" type="number" value={(value as number | null) ?? ''} placeholder={col.name}
        step={cfg.decimals >= 0 ? 1 / 10 ** cfg.decimals : 'any'}
        onChange={(e) => setCell(doc, table, rowId, col.id, e.target.value === '' ? null : Number(e.target.value))}
        onBlur={() => { if (typeof value === 'number' && round(value) !== value) setCell(doc, table, rowId, col.id, round(value)) }} />
      {cfg.unit && <span className="cell-unit">{cfg.unit}</span>}
    </div>
  )
}

function TextInput({ doc, table, rowId, col, value }: { doc: Y.Doc; table: string; rowId: string; col: ColumnInfo; value: unknown }) {
  const cfg = TEXT.config(col)
  const text = (value as string | null) ?? ''
  const area = useRef<HTMLTextAreaElement>(null)
  const [editing, setEditing] = useState(false)
  useEffect(() => { // Mehrzeilig: Höhe folgt dem Inhalt
    const el = area.current
    if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` }
  }, [text, cfg.mode, col.id])
  const change = (v: string) => setCell(doc, table, rowId, col.id, v)
  const cls = `cell ${cfg.bold ? 'bold' : ''}`

  if (cfg.mode === 'rich') {
    return (
      <div className="c">
        <button type="button" className="rich-cell" title="Text bearbeiten" onClick={() => setEditing(true)}>
          <RichPreview html={text} placeholder={col.name} />
        </button>
        {editing && <RichTextDialog doc={doc} tableId={table} rowId={rowId} colId={col.id} title={col.name} html={text} onClose={() => setEditing(false)} />}
      </div>
    )
  }
  return (
    <div className="c">
      {cfg.mode === 'multi'
        ? <textarea ref={area} className={cls} rows={1} value={text} placeholder={col.name} onChange={(e) => change(e.target.value)} />
        : <input className={cls} type="text" value={text} placeholder={col.name} onChange={(e) => change(e.target.value)} />}
    </div>
  )
}

// ---------- Pane ----------

export function ClientPane(props: {
  title: string
  doc: Y.Doc
  /** IndexedDB-Name für den lokalen Zwischenspeicher; `null` = das Dokument liegt in einer Datei. Standard: nach Titel. */
  persist?: string | null
  online?: boolean
  onToggle?: () => void
}) {
  const { doc } = props
  const { tables, views, maps, tabs } = useTabs(doc)
  const index = useLinkIndex(doc)
  const fileIndex = useFileIndex(doc)
  const [active, setActive] = useState<string | null>(null)
  const tab = tabs.find((t) => t.id === active) ?? tabs[0]
  const table = tab?.kind === 'table' ? tables.find((t) => t.id === tab.id) : undefined
  const view = tab?.kind === 'view' ? views.find((v) => v.id === tab.id) : undefined
  const mapTab = tab?.kind === 'map' ? maps.find((m) => m.id === tab.id) : undefined
  // Menü der gewählten Tabelle (Bearbeiten, Abgeleitete Tabelle, Löschen)
  const [menuOpen, setMenuOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false) // Menü des „+“ (Tabelle oder Karte)
  useEffect(() => {
    if (!menuOpen && !addOpen) return
    const close = () => { setMenuOpen(false); setAddOpen(false) }
    const away = (e: MouseEvent) => { if (!(e.target as Element).closest('.tabgroup.menu-open')) close() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [menuOpen, addOpen])
  type ViewDialogState = { mode: 'new'; sourceId: string } | { mode: 'edit'; id: string }
  const [viewDialog, setViewDialog] = useState<ViewDialogState | null>(null)
  const [deletingView, setDeletingView] = useState<string | null>(null)
  const [mapDialog, setMapDialog] = useState<{ mode: 'new' } | { mode: 'edit'; id: string } | null>(null)
  const [deletingMap, setDeletingMap] = useState<string | null>(null)
  const [mapRecord, setMapRecord] = useState<{ tableId: string; rowId: string } | null>(null) // auf der Karte angeklickte Zeile

  const [synced, setSynced] = useState(false)
  useEffect(() => {
    if (props.persist === null) { setSynced(true); return }
    const p = new IndexeddbPersistence(props.persist ?? `grid-proto-${props.title}`, doc)
    p.whenSynced.then(() => setSynced(true))
    return () => { p.destroy() }
  }, [doc, props.title, props.persist])

  const [dialog, setDialog] = useState<'table' | 'column' | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null) // Zeilen-ID, die gelöscht werden soll
  // Umbenennen/Löschen von Tabellen und Spalten
  type Target = { kind: 'table' | 'column'; id: string }
  const [hint, setHint] = useState<DropHint | null>(null)
  // Nach „+ Tabelle“ gleich in die erste Zelle der ersten Zeile springen
  const sectionRef = useRef<HTMLElement>(null)
  const [focusFirst, setFocusFirst] = useState(false)
  useEffect(() => {
    if (!focusFirst || !table?.rowIds.length) return
    sectionRef.current?.querySelector<HTMLInputElement>('.row-inner .cell')?.focus()
    setFocusFirst(false)
  }, [focusFirst, table?.id, table?.rowIds.length])
  const [editing, setEditing] = useState<Target | null>(null)
  const [deletingItem, setDeletingItem] = useState<Target | null>(null)

  const sideOf = (e: DragEvent): 'before' | 'after' => {
    const r = e.currentTarget.getBoundingClientRect()
    return e.clientX < r.left + r.width / 2 ? 'before' : 'after'
  }
  /** Drag-Handler zum Umsortieren von Tabs und Spaltenköpfen (horizontale Listen). */
  const reorderProps = (kind: ReorderKind, id: string, label: string) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      dragReorder = { kind, id }
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', label)
    },
    onDragEnd: () => { dragReorder = null; setHint(null) },
    onDragOver: (e: DragEvent) => {
      if (!dragReorder || dragReorder.kind !== kind || dragReorder.id === id) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const side = sideOf(e)
      setHint((h) => (h && h.kind === kind && h.id === id && h.side === side ? h : { kind, id, side }))
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setHint((h) => (h && h.id === id ? null : h))
    },
    onDrop: (e: DragEvent) => {
      const d = dragReorder
      if (!d || d.kind !== kind || d.id === id) return
      e.preventDefault()
      const side = sideOf(e)
      dragReorder = null
      setHint(null)
      // Zielindex in der Liste ohne das gezogene Element
      const ids = (kind === 'table' ? tabs.map((t) => t.id) : table!.columns.map((c) => c.id)).filter((x) => x !== d.id)
      const to = ids.indexOf(id) + (side === 'after' ? 1 : 0)
      if (kind === 'table') moveTable(doc, d.id, to)
      else moveColumn(doc, table!.id, d.id, to)
    },
  })
  const hintClass = (kind: ReorderKind, id: string) =>
    hint && hint.kind === kind && hint.id === id ? (hint.side === 'before' ? 'drop-before' : 'drop-after') : ''

  const backlinks = table
    ? tables.flatMap((t) =>
        t.columns.filter((c) => c.type === 'relation' && c.target === table.id && RELATION.config(c).backlink).map((c) => ({ source: t, col: c })))
    : []

  // Sortierung ist nur eine Ansicht (pro Tabelle, nur auf diesem Gerät); die gespeicherte Reihenfolge bleibt unverändert.
  // Klick 1: aufsteigend, Klick 2: absteigend, Klick 3: wieder die gespeicherte Reihenfolge.
  const [sorts, setSorts] = useState<Record<string, { colId: string; dir: SortDir }>>({})
  const sort = table ? sorts[table.id] : undefined
  const cycleSort = (colId: string) => {
    if (!table) return
    setSorts((all) => {
      const cur = all[table.id]
      const next = !cur || cur.colId !== colId ? { colId, dir: 'asc' as const } : cur.dir === 'asc' ? { colId, dir: 'desc' as const } : null
      const { [table.id]: _, ...rest } = all
      return next ? { ...rest, [table.id]: next } : rest
    })
  }
  // Während in der Tabelle getippt wird, bleibt die Reihenfolge stehen und wird erst beim Verlassen der Zelle neu sortiert.
  const [sortTick, setSortTick] = useState(0)
  const editingInGrid = useRef(false)
  useEffect(() => {
    const h = () => { if (!editingInGrid.current) setSortTick((n) => n + 1) }
    doc.on('update', h)
    return () => { doc.off('update', h) }
  }, [doc])
  const rowIds = useMemo(
    () => (table && sort ? sortedRowIds(doc, table.id, sort.colId, sort.dir) : table?.rowIds ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, table?.id, sort?.colId, sort?.dir, sortTick, table && !sort ? table.rowIds : null],
  )

  // Berechnete Spalten (Rollup) und Spalten mit Summenzeile: je Spalte einmal für alle Zeilen ausgewertet
  const { cellData, reprs } = useMemo(() => {
    const m = new Map<string, Map<string, CellData>>()
    const r = new Map<string, Map<string, Repr>>()
    if (!table) return { cellData: m, reprs: r }
    const ctx = newCtx() // gemeinsamer Zwischenspeicher: jede Spalte (auch von Formeln benutzte) wird nur einmal berechnet
    for (const c of table.columns) if (isComputed(c) || c.footer) m.set(c.id, columnCells(doc, tables, table, c, ctx))
    // Darstellung der Zeilen für alles, was hier als Kachel erscheint: Ziele der Relationen, Quellen der Rückverweise, die Tabelle selbst
    const wanted = new Set<string>([table.id])
    for (const c of table.columns) if (c.type === 'relation' && c.target) wanted.add(c.target)
    for (const t of tables) if (t.columns.some((c) => c.type === 'relation' && c.target === table.id)) wanted.add(t.id)
    // Formulare für neue Datensätze zeigen deren Relationen: auch die Ziele der Zieltabellen
    for (const id of [...wanted]) for (const c of tables.find((t) => t.id === id)?.columns ?? []) if (c.type === 'relation' && c.target) wanted.add(c.target)
    for (const t of tables) if (wanted.has(t.id)) r.set(t.id, reprMap(doc, tables, t, ctx))
    return { cellData: m, reprs: r }
    // `index` (Verknüpfungen), `fileIndex` (Bilder) und `tables` (Werte, Struktur) decken alle Änderungen ab, die das Ergebnis beeinflussen
  }, [doc, tables, table?.id, index, fileIndex])
  const reprOf = useCallback((id: string) => reprs.get(id), [reprs])

  // Nach „+ Zeile“: zur neuen Zeile scrollen und ihre erste Zelle fokussieren
  const [focusRow, setFocusRow] = useState<string | null>(null)
  useEffect(() => {
    if (!focusRow) return
    const row = sectionRef.current?.querySelector<HTMLElement>(`[data-row="${focusRow}"]`)
    if (!row) return // noch nicht gerendert: der Effekt läuft mit der nächsten Zeilenliste erneut
    row.scrollIntoView({ block: 'nearest' })
    row.querySelector<HTMLElement>('input, textarea, button')?.focus({ preventScroll: true })
    setFocusRow(null)
  }, [focusRow, rowIds])

  const [liveWidth, setLiveWidth] = useState<{ id: string; w: number } | null>(null)
  const startResize = (e: ReactMouseEvent, colId: string) => {
    e.preventDefault()
    e.stopPropagation()
    const th = (e.currentTarget as HTMLElement).parentElement!
    const startX = e.clientX
    const startW = th.getBoundingClientRect().width
    let w = startW
    const move = (ev: MouseEvent) => { w = Math.min(800, Math.max(80, Math.round(startW + ev.clientX - startX))); setLiveWidth({ id: colId, w }) }
    const up = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      document.body.classList.remove('resizing')
      if (w !== startW) setColumnWidth(doc, table!.id, colId, w)
      setLiveWidth(null)
    }
    document.body.classList.add('resizing')
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }

  const shownColumns = table ? table.columns.filter((c) => !c.hidden) : [] // ausgeblendete Spalten bleiben für Formeln und Darstellung nutzbar
  const template = table
    ? [
        ...shownColumns.map((c, i) =>
          liveWidth?.id === c.id ? `${liveWidth.w}px` : c.width ? `${c.width}px` : i === 0 ? '200px' : c.type === 'relation' || c.type === 'file' ? '240px' : c.type === 'number' ? '120px' : c.type === 'date' ? '170px' : c.type === 'checkbox' ? '110px' : isComputed(c) ? '150px' : c.type === 'geo' ? (c.config?.format === 'map' ? '240px' : '210px') : c.type === 'select' ? '160px' : '180px'),
        ...backlinks.map(() => '220px'),
        'minmax(120px, 1fr)',
      ].join(' ')
    : ''

  return (
    <ReprContext.Provider value={reprOf}>
    <section ref={sectionRef} className={`pane ${props.online === false ? 'offline' : ''}`}>
      {/* Titel und Online-Schalter nur im Simulationsmodus (mehrere Clients) */}
      {props.onToggle && (
        <header>
          <h2>{props.title}</h2>
          <button onClick={props.onToggle} className={props.online ? 'on' : 'off'}>
            {props.online ? '● online' : '○ offline'}
          </button>
        </header>
      )}

      {/* Alles bis zur Tabelle scrollt gemeinsam; der Tabellenkopf bleibt oben stehen, die Leiste „+ Zeile“ unten. */}
      <div className="gridscroll">
      <nav className="tabs">
        {tabs.map((t) => {
          const current = t.id === tab?.id
          return (
            <span key={t.id} className={`tabgroup ${hintClass('table', t.id)}${current && menuOpen ? ' menu-open' : ''}`}>
              <button className={`${current ? 'active' : ''}${t.kind === 'view' ? ' view' : ''}${t.kind === 'map' ? ' map' : ''}`} aria-haspopup={current ? 'menu' : undefined} aria-expanded={current ? menuOpen : undefined}
                onClick={() => { if (current) setMenuOpen((o) => !o); else { setActive(t.id); setMenuOpen(false) } }}
                title={current ? 'Menü öffnen – Ziehen zum Umsortieren' : 'Ziehen zum Umsortieren'}
                {...reorderProps('table', t.id, t.name)}>{t.name}{current && <span className="tab-caret"> ▾</span>}</button>
              {current && menuOpen && (
                <div className="tab-popup" role="menu">
                  <button type="button" role="menuitem" autoFocus onClick={() => {
                    setMenuOpen(false)
                    if (t.kind === 'table') setEditing({ kind: 'table', id: t.id }); else if (t.kind === 'map') setMapDialog({ mode: 'edit', id: t.id }); else setViewDialog({ mode: 'edit', id: t.id })
                  }}>Bearbeiten …</button>
                  {t.kind === 'table' && (
                    <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setViewDialog({ mode: 'new', sourceId: t.id }) }}>Abgeleitete Tabelle …</button>
                  )}
                  <button type="button" role="menuitem" className="danger-item" onClick={() => {
                    setMenuOpen(false)
                    if (t.kind === 'table') setDeletingItem({ kind: 'table', id: t.id }); else if (t.kind === 'map') setDeletingMap(t.id); else setDeletingView(t.id)
                  }}>Löschen …</button>
                </div>
              )}
            </span>
          )
        })}
        <span className={`tabgroup${addOpen ? ' menu-open' : ''}`}>
          <button aria-haspopup="menu" aria-expanded={addOpen} title="Tabelle oder Karte hinzufügen" aria-label="Hinzufügen"
            onClick={() => { setAddOpen((o) => !o); setMenuOpen(false) }}>+</button>
          {addOpen && (
            <div className="add-popup" role="menu">
              <button type="button" role="menuitem" autoFocus onClick={() => { setAddOpen(false); setDialog('table') }}>Neue Tabelle …</button>
              <button type="button" role="menuitem" onClick={() => { setAddOpen(false); setMapDialog({ mode: 'new' }) }}>Neue Karte …</button>
            </div>
          )}
        </span>
      </nav>

      {!synced && <p className="hint">Lade lokale Daten …</p>}
      {synced && !tab && <p className="hint">Noch keine Tabelle. Lege eine an.</p>}
      {view && <ViewGrid key={view.id} doc={doc} view={view} />}
      {mapTab && <MapView key={mapTab.id} doc={doc} map={mapTab} tables={tables} onOpenRecord={(tableId, rowId) => setMapRecord({ tableId, rowId })} />}

      {table && (
        <>
          <div className="gridwrap"
            onFocus={() => { editingInGrid.current = true }}
            onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { editingInGrid.current = false; setSortTick((n) => n + 1) } }}>
            <div className="grid" style={{ ['--cols' as any]: template }}>
              <div className="grid-head">
                {shownColumns.map((c) => (
                  <div key={c.id} className={`h reorderable ${hintClass('column', c.id)}`} {...reorderProps('column', c.id, c.name)}>
                    <button type="button" className="h-name" title="Spalte konfigurieren"
                      onClick={() => setEditing({ kind: 'column', id: c.id })}>{c.name}</button>
                    <button type="button" draggable={false} className={`h-sort${sort?.colId === c.id ? ' on' : ''}`}
                      title={sort?.colId === c.id ? (sort.dir === 'asc' ? 'Aufsteigend sortiert – klicken für absteigend' : 'Absteigend sortiert – klicken für die ursprüngliche Reihenfolge') : 'Nach dieser Spalte sortieren'}
                      aria-label={`Nach ${c.name} sortieren`}
                      onClick={() => cycleSort(c.id)}>{sort?.colId === c.id ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}</button>
                    <span className="col-resize" title="Ziehen: Breite ändern, Doppelklick: zurücksetzen"
                      onMouseDown={(e) => startResize(e, c.id)}
                      onDoubleClick={() => setColumnWidth(doc, table.id, c.id, undefined)} />
                  </div>
                ))}
                {backlinks.map(({ source, col }) => (
                  <div key={col.id} className="h back-th">
                    ← {source.name}<small>{col.name}</small>
                  </div>
                ))}
                <div className="h"><button className="add-col" onClick={() => setDialog('column')}>+ Spalte</button></div>
              </div>
              {rowIds.map((rid) => (
                <div key={rid} className="row-outer" data-row={rid}>
                  <div className="row-inner">
                    {shownColumns.map((c, i) =>
                      isComputed(c)
                        ? (() => {
                            const cell = cellData.get(c.id)?.get(rid)
                            return (
                              <div key={c.id} className={`c vcell${cell?.error ? ' err' : ''}`}>
                                <span title={cell?.error ?? cell?.text}>{cell?.text}</span>
                              </div>
                            )
                          })()
                        : c.type === 'relation'
                        ? <RelationCell key={c.id} doc={doc} tables={tables} table={table} rowId={rid} col={c} index={index} />
                        : c.type === 'file'
                        ? <FileCell key={c.id} doc={doc} tableId={table.id} rowId={rid} col={c} index={fileIndex} />
                        : c.type === 'select'
                        ? <SelectCell key={c.id} doc={doc} tableId={table.id} rowId={rid} col={c} />
                        : <Cell key={c.id} doc={doc} table={table.id} rowId={rid} col={c} lead={i === 0} />)}
                    {backlinks.map(({ source, col }) => (
                      <BacklinkCell key={col.id} doc={doc} tables={tables} source={source} rowId={rid} col={col} index={index} />
                    ))}
                    <div className="c actions-c"><button className="del" title="Zeile löschen" onClick={() => setDeleting(rid)}>✕</button></div>
                  </div>
                </div>
              ))}
              <div className="grid-foot">
                <div className="row-inner">
                  {shownColumns.map((c) => (
                    <FooterCell key={c.id} doc={doc} tableId={table.id} col={c} tables={tables} cells={cellData.get(c.id)} />
                  ))}
                  {backlinks.map(({ col }) => <div key={col.id} className="c" />)}
                  <div className="c" />
                </div>
              </div>
            </div>
          </div>
        </>
      )}
      </div>
      {table && (
        <div className="addrow-bar">
          <button className="add-row" onClick={() => setFocusRow(addRow(doc, table.id))}>+ Zeile</button>
        </div>
      )}
      {view && (
        <div className="addrow-bar view-bar">
          <span>Abgeleitete Tabelle aus „{tables.find((t) => t.id === view.def.source)?.name ?? '?'}“ – nur Lesen.</span>
          <button type="button" onClick={() => setViewDialog({ mode: 'edit', id: view.id })}>Bearbeiten …</button>
        </div>
      )}

      {editing && (() => {
        const col = editing.kind === 'column' ? table?.columns.find((c) => c.id === editing.id) : undefined
        const tbl = editing.kind === 'table' ? tables.find((t) => t.id === editing.id) : undefined
        if (!col && !tbl) return null
        if (col) {
          return (
            <ColumnDialog doc={doc} table={table!} tables={tables} column={col} onClose={() => setEditing(null)}
              onDelete={() => { setDeletingItem(editing); setEditing(null) }} />
          )
        }
        return (
          <TableDialog doc={doc} table={tbl!} tables={tables}
            onClose={() => setEditing(null)}
            onDelete={() => { setDeletingItem(editing); setEditing(null) }} />
        )
      })()}

      {deletingItem && (() => {
        const col = deletingItem.kind === 'column' ? table?.columns.find((c) => c.id === deletingItem.id) : undefined
        const tbl = deletingItem.kind === 'table' ? tables.find((t) => t.id === deletingItem.id) : undefined
        if (!col && !tbl) return null
        const detail = col
          ? `Spalte „${col.name}“ mit allen Werten, Verknüpfungen und Dateien dieser Spalte.`
          : `Tabelle „${tbl!.name}“ mit ${tbl!.rowIds.length} ${tbl!.rowIds.length === 1 ? 'Zeile' : 'Zeilen'}. Verknüpfungen darauf werden entfernt.${views.some((v) => v.def.source === tbl!.id) ? ` Abgeleitete Tabellen daraus (${views.filter((v) => v.def.source === tbl!.id).length}) werden ebenfalls gelöscht.` : ''}`
        return (
          <ConfirmDialog detail={detail} onCancel={() => setDeletingItem(null)}
            onConfirm={() => {
              if (col) deleteColumn(doc, table!.id, col.id)
              else { deleteTable(doc, tbl!.id); setActive(null) }
              setDeletingItem(null)
            }} />
        )
      })()}

      {viewDialog && (() => {
        const editing = viewDialog.mode === 'edit' ? views.find((v) => v.id === viewDialog.id) : undefined
        const source = tables.find((t) => t.id === (editing ? editing.def.source : viewDialog.mode === 'new' ? viewDialog.sourceId : ''))
        if (!source) return null
        return (
          <ViewDialog doc={doc} source={source} tables={tables} initial={editing && { name: editing.name, def: editing.def }}
            onClose={() => setViewDialog(null)}
            onSubmit={(name, def) => {
              if (editing) updateView(doc, editing.id, { name, def })
              else setActive(addView(doc, name, def))
              setViewDialog(null)
            }} />
        )
      })()}
      {mapDialog && (() => {
        const editing = mapDialog.mode === 'edit' ? maps.find((m) => m.id === mapDialog.id) : undefined
        if (mapDialog.mode === 'edit' && !editing) return null
        return (
          <MapDialog tables={tables} initial={editing && { name: editing.name, layers: editing.layers }}
            onClose={() => setMapDialog(null)}
            onDelete={editing && (() => { setDeletingMap(editing.id); setMapDialog(null) })}
            onSubmit={(name, layers) => {
              if (editing) updateMap(doc, editing.id, { name, layers })
              else setActive(addMap(doc, name, layers))
              setMapDialog(null)
            }} />
        )
      })()}
      {deletingMap && (() => {
        const m = maps.find((x) => x.id === deletingMap)
        if (!m) return null
        return (
          <ConfirmDialog detail={`Karte „${m.name}“ mit ${m.shapes.length} ${m.shapes.length === 1 ? 'eigenem Objekt' : 'eigenen Objekten'}. Die Tabellen und ihre Daten bleiben unverändert.`}
            onCancel={() => setDeletingMap(null)}
            onConfirm={() => { deleteMap(doc, m.id); setActive(null); setDeletingMap(null) }} />
        )
      })()}
      {mapRecord && tables.find((t) => t.id === mapRecord.tableId) && (
        <EditRecordDialog doc={doc} tables={tables} table={tables.find((t) => t.id === mapRecord.tableId)!} rowId={mapRecord.rowId} onClose={() => setMapRecord(null)} />
      )}
      {deletingView && (() => {
        const v = views.find((x) => x.id === deletingView)
        if (!v) return null
        return (
          <ConfirmDialog detail={`Abgeleitete Tabelle „${v.name}“. Die Quelltabelle und ihre Daten bleiben unverändert.`}
            onCancel={() => setDeletingView(null)}
            onConfirm={() => { deleteView(doc, v.id); setActive(null); setDeletingView(null) }} />
        )
      })()}

      {deleting && table && (
        <ConfirmDialog detail={`Zeile „${summarize(doc, table, deleting).title}“`}
          onCancel={() => setDeleting(null)}
          onConfirm={() => { deleteRow(doc, table.id, deleting); setDeleting(null) }} />
      )}

      {dialog === 'table' && (
        <Dialog title="Neue Tabelle" tables={tables} onClose={() => setDialog(null)}
          onSubmit={(f) => { setActive(addTable(doc, f.name)); setFocusFirst(true); setDialog(null) }} />
      )}
      {dialog === 'column' && table && (
        <Dialog title={`Neue Spalte in „${table.name}“`} withType tables={tables} table={table} defaultTarget={table.id}
          onClose={() => setDialog(null)}
          onSubmit={(f) => { addColumn(doc, table.id, f.name, f.type, f.target, f.options, f.config); setDialog(null) }} />
      )}
    </section>
    </ReprContext.Provider>
  )
}

function Dialog(props: {
  title: string
  withType?: boolean
  tables: TableInfo[]
  defaultTarget?: string
  onClose: () => void
  /** Spalten der aktuellen Tabelle (für Rollup: welche Relation). */
  table?: TableInfo
  onSubmit: (f: { name: string; type: ColType; target?: string; options?: string[]; config?: Record<string, unknown> }) => void
}) {
  const [name, setName] = useState('')
  const [type, setType] = useState<ColType>('text')
  const [target, setTarget] = useState(props.defaultTarget ?? props.tables[0]?.id)
  const [optionsText, setOptionsText] = useState('')
  // Rollup: Relation dieser Tabelle, Spalte der verknüpften Zeilen, Zusammenfassung
  const relations = (props.table?.columns ?? []).filter((c) => c.type === 'relation')
  const [rel, setRel] = useState(relations[0]?.id ?? '')
  const rollupTarget = props.tables.find((t) => t.id === relations.find((c) => c.id === rel)?.target)
  const [rcol, setRcol] = useState('')
  const rcolInfo = rollupTarget?.columns.find((c) => c.id === rcol)
  const rfns: AggFn[] = rcolInfo ? allowedAggs(effectiveType(rcolInfo, props.tables)).filter((f) => f !== 'hide') : []
  const [fn, setFn] = useState<AggFn>('sum')
  const rollupReady = !!rcolInfo && rfns.includes(fn)
  const [expr, setExpr] = useState('')
  const exprError = (() => {
    if (!expr.trim()) return null
    try { if (type === 'template') parseTemplate(expr); else parseFormula(expr); return null } catch (e) { return e instanceof FormulaSyntaxError ? e.message : String(e) }
  })()
  const submit = () => {
    if (!name.trim()) return
    if (type === 'formula' || type === 'template') {
      if (!expr.trim() || exprError) return
      props.onSubmit({ name: name.trim(), type, config: type === 'template' ? { tpl: expr } : { expr: expr.trim() } })
      return
    }
    if (type === 'rollup') {
      if (!rollupReady) return
      props.onSubmit({ name: name.trim(), type, config: { rel, col: rcol, fn } })
      return
    }
    const options = optionsText.split('\n').map((x) => x.trim()).filter(Boolean)
    props.onSubmit({ name: name.trim(), type, target: type === 'relation' ? target : undefined, options: type === 'select' ? options : undefined })
  }
  return (
    <Modal onClose={props.onClose}>
      <form className="dialog" onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); submit() }}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>{props.title}</h3>
        {props.withType && (
          <select value={type} onChange={(e) => setType(e.target.value as ColType)}>
            <option value="text">Text</option>
            <option value="number">Zahl</option>
            <option value="relation">Relation (Verknüpfung)</option>
            <option value="file">Datei / Bild</option>
            <option value="select">Auswahl (z. B. Status)</option>
            <option value="date">Datum</option>
            <option value="checkbox">Checkbox</option>
            <option value="formula">Formel (Berechnung aus anderen Spalten)</option>
            <option value="geo">Geokoordinate</option>
            <option value="template">Text mit Platzhaltern {'({{…}})'}</option>
            <option value="rollup" disabled={!props.table || relations.length === 0}>Rollup (Summe u. a. über verknüpfte Zeilen)</option>
          </select>
        )}
        <input autoFocus placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        {props.withType && type === 'relation' && (
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {props.tables.map((t) => <option key={t.id} value={t.id}>auf Tabelle „{t.name}“</option>)}
          </select>
        )}
        {props.withType && type === 'template' && (
          <>
            <textarea rows={3} spellCheck={false} className="formula-input" placeholder={'z. B. {{Vorname}} {{Name}} – {{[Führer] + [Helfer]}} Personen'}
              value={expr} onChange={(e) => setExpr(e.target.value)} />
            {exprError && <p className="formula-error" role="alert">{exprError}</p>}
          </>
        )}
        {props.withType && type === 'formula' && (
          <>
            <textarea rows={3} spellCheck={false} className="formula-input" placeholder={'z. B. [Führer] + [Unterführer] + [Helfer]\noder SUMME(Gruppen.Führer)'}
              value={expr} onChange={(e) => setExpr(e.target.value)} />
            {exprError && <p className="formula-error" role="alert">{exprError}</p>}
          </>
        )}
        {props.withType && type === 'rollup' && (
          <>
            <select value={rel} onChange={(e) => { setRel(e.target.value); setRcol('') }}>
              {relations.map((c) => <option key={c.id} value={c.id}>über Relation „{c.name}“</option>)}
            </select>
            <select value={rcol} onChange={(e) => {
              const id = e.target.value
              setRcol(id)
              const ci = rollupTarget?.columns.find((c) => c.id === id)
              if (ci) setFn(defaultAgg(effectiveType(ci, props.tables)))
            }}>
              <option value="">Spalte der verknüpften Zeilen …</option>
              {(rollupTarget?.columns ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select value={fn} disabled={!rcolInfo} onChange={(e) => setFn(e.target.value as AggFn)}>
              {rfns.map((f) => <option key={f} value={f}>{aggLabel(rcolInfo!.type, f)}</option>)}
            </select>
          </>
        )}
        {props.withType && type === 'select' && (
          <textarea rows={4} placeholder={'Optionen, eine pro Zeile\nz. B. Entwurf\nIn Arbeit'} value={optionsText}
            onChange={(e) => setOptionsText(e.target.value)} />
        )}
        <div className="actions">
          <button type="button" onClick={props.onClose}>Abbrechen</button>
          <button type="submit" className="primary" disabled={!name.trim() || (type === 'rollup' && !rollupReady) || ((type === 'formula' || type === 'template') && (!expr.trim() || !!exprError))}>Anlegen</button>
        </div>
      </form>
    </Modal>
  )
}
