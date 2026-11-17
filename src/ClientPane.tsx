import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react'
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import {
  addColumn, addLink, addRow, addTable, deleteColumn, deleteRow, deleteTable, moveColumn, moveLink, moveTable, removeLink, renameColumn, renameTable, rowExists, setCell, setColumnWidth, summarize,
  type ColType, type ColumnInfo, type LinkIndex, type LinkSlot, type TableInfo,
} from './model'
import { useCell, useFileIndex, useLinkIndex, useRowVersion, useTables } from './useTables'
import { FileCell } from './FileCell'
import { SelectCell } from './SelectCell'
import { ColumnDialog } from './ColumnDialog'
import { sortedRowIds, type SortDir } from './sorting'
import { formatDate, toInputValue } from './dateFormat'
import { DATE, FILE, NUMBER, RELATION, TEXT } from './columnTypes'
import { RichPreview, RichTextDialog } from './richText'
import { AnimItem, useAnimatedList } from './animatedList'
import { ConfirmDialog, Modal, RenameDialog } from './Modal'

// ---------- Kacheln ----------

/** Aktuell gezogene Verknüpfung (dataTransfer ist in dragover nicht lesbar, daher Modulvariable). */
interface DragInfo { slot: LinkSlot; targetRow: string; targetTable?: string }
let dragging: DragInfo | null = null

/** Gerade umsortierter Tab bzw. Spaltenkopf. */
type ReorderKind = 'table' | 'column'
let dragReorder: { kind: ReorderKind; id: string } | null = null
type DropHint = { kind: ReorderKind; id: string; side: 'before' | 'after' }

const initials = (t: string) =>
  t.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('')

function Tile(props: {
  doc: Y.Doc
  table?: TableInfo
  rowId: string
  onRemove?: () => void
  onClick?: () => void
  muted?: boolean
  /** Wenn gesetzt, ist die Kachel in eine andere Relationszelle derselben Zieltabelle ziehbar. */
  drag?: { slot: LinkSlot; targetTable?: string }
}) {
  const { doc, table, rowId } = props
  const [isDragging, setIsDragging] = useState(false)
  useRowVersion(doc, table?.id ?? '', rowId)
  const exists = !!table && rowExists(doc, table.id, rowId)
  const s = exists ? summarize(doc, table!, rowId) : null
  return (
    <div className={`tile ${exists ? '' : 'deleted'} ${props.onClick ? 'clickable' : ''} ${props.muted ? 'muted' : ''} ${isDragging ? 'dragging' : ''}`}
      onClick={props.onClick}
      draggable={!!props.drag}
      onDragStart={props.drag ? (e) => {
        dragging = { slot: props.drag!.slot, targetRow: rowId, targetTable: props.drag!.targetTable }
        e.dataTransfer.effectAllowed = 'copyMove'
        e.dataTransfer.setData('text/plain', s?.title ?? '')
        setIsDragging(true)
      } : undefined}
      onDragEnd={props.drag ? () => { dragging = null; setIsDragging(false) } : undefined}>
      {s && <div className="avatar">{initials(s.title)}</div>}
      <div className="tile-body">
        <div className="tile-title">{s ? s.title : 'gelöscht'}</div>
        {s?.subs.map((x, i) => <div key={i} className="tile-sub">{x}</div>)}
      </div>
      {props.onRemove && (
        <button type="button" className="tile-x" title="Verknüpfung entfernen"
          onClick={(e) => { e.stopPropagation(); props.onRemove!() }}>✕</button>
      )}
    </div>
  )
}

function Picker(props: {
  doc: Y.Doc
  target: TableInfo
  linked: string[]
  onPick: (rowId: string) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const rows = props.target.rowIds
    .filter((id) => !props.linked.includes(id))
    .filter((id) => {
      const s = summarize(props.doc, props.target, id)
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
            <Tile key={id} doc={props.doc} table={props.target} rowId={id} onClick={() => props.onPick(id)} />
          ))}
          {rows.length === 0 && <p className="hint">Keine passenden Datensätze.</p>}
        </div>
        <div className="actions"><button type="button" onClick={props.onClose}>Fertig</button></div>
      </div>
    </Modal>
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
  const [over, setOver] = useState(false)
  const slot: LinkSlot = { tableId: table.id, rowId, colId: col.id }

  // Ablageziel: Kacheln derselben Zieltabelle, die nicht schon aus dieser Zelle stammen.
  const accepts = () =>
    !!dragging && !!col.target && dragging.targetTable === col.target &&
    !(dragging.slot.rowId === rowId && dragging.slot.colId === col.id)

  return (
    <div className={`c rel ${over ? 'drop-over' : ''}`}
      onDragOver={(e) => {
        if (!accepts()) return
        e.preventDefault()
        e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move'
        setOver(true)
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false) }}
      onDrop={(e) => {
        setOver(false)
        if (!accepts()) return
        e.preventDefault()
        const d = dragging!
        dragging = null
        moveLink(doc, d.slot, slot, d.targetRow, e.altKey) // Alt/Option = kopieren statt verschieben
      }}>
      <div className="tiles">
        {anim.entries.map((e) => (
          <AnimItem key={e.key} phase={e.phase} onExited={() => anim.done(e.key)}>
            <Tile doc={doc} table={target} rowId={e.item}
              drag={{ slot, targetTable: col.target }}
              onRemove={() => removeLink(doc, table.id, rowId, col.id, e.item)} />
          </AnimItem>
        ))}
        {!(RELATION.config(col).single && ids.length >= 1) && <button type="button" className="add-tile" onClick={() => setPicking(true)} disabled={!target}
          title={target ? 'Datensatz verknüpfen' : 'Zieltabelle fehlt'}>+</button>}
      </div>
      {picking && target && (
        <Picker doc={doc} target={target} linked={ids}
          onPick={(id) => addLink(doc, table.id, rowId, col.id, id)}
          onClose={() => setPicking(false)} />
      )}
    </div>
  )
}

/** Rückverweise: schreibgeschützte Spalte, berechnet aus Relationen anderer Tabellen. */
function BacklinkCell(props: {
  doc: Y.Doc
  source: TableInfo
  rowId: string
  col: ColumnInfo
  index: LinkIndex
}) {
  const ids = (props.index.backward.get(`${props.rowId}|${props.col.id}`) ?? [])
    .filter((id) => rowExists(props.doc, props.source.id, id))
  const anim = useAnimatedList(ids, (id) => id)
  return (
    <div className="c rel backlink">
      <div className="tiles">
        {anim.entries.map((e) => (
          <AnimItem key={e.key} phase={e.phase} onExited={() => anim.done(e.key)}>
            <Tile doc={props.doc} table={props.source} rowId={e.item} muted />
          </AnimItem>
        ))}
        {anim.entries.length === 0 && <span className="empty">–</span>}
      </div>
    </div>
  )
}

// ---------- Zellen ----------

function Cell({ doc, table, rowId, col }: { doc: Y.Doc; table: string; rowId: string; col: ColumnInfo; lead?: boolean }) {
  const value = useCell(doc, table, rowId, col.id)
  if (col.type === 'number') return <NumberInput doc={doc} table={table} rowId={rowId} col={col} value={value} />
  if (col.type === 'date') return <DateInput doc={doc} table={table} rowId={rowId} col={col} value={value} />
  return <TextInput doc={doc} table={table} rowId={rowId} col={col} value={value} />
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
  const tables = useTables(doc)
  const index = useLinkIndex(doc)
  const fileIndex = useFileIndex(doc)
  const [active, setActive] = useState<string | null>(null)
  const table = tables.find((t) => t.id === active) ?? tables[0]

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
      const ids = (kind === 'table' ? tables.map((t) => t.id) : table!.columns.map((c) => c.id)).filter((x) => x !== d.id)
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

  const template = table
    ? [
        ...table.columns.map((c, i) =>
          liveWidth?.id === c.id ? `${liveWidth.w}px` : c.width ? `${c.width}px` : i === 0 ? '200px' : c.type === 'relation' || c.type === 'file' ? '240px' : c.type === 'number' ? '120px' : c.type === 'date' ? '170px' : c.type === 'select' ? '160px' : '180px'),
        ...backlinks.map(() => '220px'),
        'minmax(120px, 1fr)',
      ].join(' ')
    : ''

  return (
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
        {tables.map((t) => (
          <span key={t.id} className={`tabgroup ${hintClass('table', t.id)}`}>
            <button className={t.id === table?.id ? 'active' : ''} onClick={() => setActive(t.id)}
              title="Ziehen zum Umsortieren" {...reorderProps('table', t.id, t.name)}>{t.name}</button>
            {t.id === table?.id && (
              <button type="button" className="tab-menu" title="Tabelle umbenennen oder löschen"
                onClick={() => setEditing({ kind: 'table', id: t.id })}>⋯</button>
            )}
          </span>
        ))}
        <button onClick={() => setDialog('table')}>+ Tabelle</button>
      </nav>

      {!synced && <p className="hint">Lade lokale Daten …</p>}
      {synced && !table && <p className="hint">Noch keine Tabelle. Lege eine an.</p>}

      {table && (
        <>
          <div className="gridwrap"
            onFocus={() => { editingInGrid.current = true }}
            onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { editingInGrid.current = false; setSortTick((n) => n + 1) } }}>
            <div className="grid" style={{ ['--cols' as any]: template }}>
              <div className="grid-head">
                {table.columns.map((c) => (
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
                    {table.columns.map((c, i) =>
                      c.type === 'relation'
                        ? <RelationCell key={c.id} doc={doc} tables={tables} table={table} rowId={rid} col={c} index={index} />
                        : c.type === 'file'
                        ? <FileCell key={c.id} doc={doc} tableId={table.id} rowId={rid} col={c} index={fileIndex} />
                        : c.type === 'select'
                        ? <SelectCell key={c.id} doc={doc} tableId={table.id} rowId={rid} col={c} />
                        : <Cell key={c.id} doc={doc} table={table.id} rowId={rid} col={c} lead={i === 0} />)}
                    {backlinks.map(({ source, col }) => (
                      <BacklinkCell key={col.id} doc={doc} source={source} rowId={rid} col={col} index={index} />
                    ))}
                    <div className="c actions-c"><button className="del" title="Zeile löschen" onClick={() => setDeleting(rid)}>✕</button></div>
                  </div>
                </div>
              ))}
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
          <RenameDialog title="Tabelle" name={tbl!.name}
            onClose={() => setEditing(null)}
            onSave={(n) => renameTable(doc, tbl!.id, n)}
            onDelete={() => { setDeletingItem(editing); setEditing(null) }} />
        )
      })()}

      {deletingItem && (() => {
        const col = deletingItem.kind === 'column' ? table?.columns.find((c) => c.id === deletingItem.id) : undefined
        const tbl = deletingItem.kind === 'table' ? tables.find((t) => t.id === deletingItem.id) : undefined
        if (!col && !tbl) return null
        const detail = col
          ? `Spalte „${col.name}“ mit allen Werten, Verknüpfungen und Dateien dieser Spalte.`
          : `Tabelle „${tbl!.name}“ mit ${tbl!.rowIds.length} ${tbl!.rowIds.length === 1 ? 'Zeile' : 'Zeilen'}. Verknüpfungen darauf werden entfernt.`
        return (
          <ConfirmDialog detail={detail} onCancel={() => setDeletingItem(null)}
            onConfirm={() => {
              if (col) deleteColumn(doc, table!.id, col.id)
              else { deleteTable(doc, tbl!.id); setActive(null) }
              setDeletingItem(null)
            }} />
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
        <Dialog title={`Neue Spalte in „${table.name}“`} withType tables={tables} defaultTarget={table.id}
          onClose={() => setDialog(null)}
          onSubmit={(f) => { addColumn(doc, table.id, f.name, f.type, f.target, f.options); setDialog(null) }} />
      )}
    </section>
  )
}

function Dialog(props: {
  title: string
  withType?: boolean
  tables: TableInfo[]
  defaultTarget?: string
  onClose: () => void
  onSubmit: (f: { name: string; type: ColType; target?: string; options?: string[] }) => void
}) {
  const [name, setName] = useState('')
  const [type, setType] = useState<ColType>('text')
  const [target, setTarget] = useState(props.defaultTarget ?? props.tables[0]?.id)
  const [optionsText, setOptionsText] = useState('')
  const submit = () => {
    if (!name.trim()) return
    const options = optionsText.split('\n').map((x) => x.trim()).filter(Boolean)
    props.onSubmit({ name: name.trim(), type, target: type === 'relation' ? target : undefined, options: type === 'select' ? options : undefined })
  }
  return (
    <Modal onClose={props.onClose}>
      <form className="dialog" onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); submit() }}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>{props.title}</h3>
        <input autoFocus placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        {props.withType && (
          <select value={type} onChange={(e) => setType(e.target.value as ColType)}>
            <option value="text">Text</option>
            <option value="number">Zahl</option>
            <option value="relation">Relation (Verknüpfung)</option>
            <option value="file">Datei / Bild</option>
            <option value="select">Auswahl (z. B. Status)</option>
            <option value="date">Datum</option>
          </select>
        )}
        {props.withType && type === 'relation' && (
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {props.tables.map((t) => <option key={t.id} value={t.id}>auf Tabelle „{t.name}“</option>)}
          </select>
        )}
        {props.withType && type === 'select' && (
          <textarea rows={4} placeholder={'Optionen, eine pro Zeile\nz. B. Entwurf\nIn Arbeit'} value={optionsText}
            onChange={(e) => setOptionsText(e.target.value)} />
        )}
        <div className="actions">
          <button type="button" onClick={props.onClose}>Abbrechen</button>
          <button type="submit" className="primary" disabled={!name.trim()}>Anlegen</button>
        </div>
      </form>
    </Modal>
  )
}
