import { DurationInput, LinkInput, PersonCell } from './NewCells'
import { currentTracking, stopTracking, useTracking } from './tracking'
import { useCallback, useLayoutEffect, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import {
  addColumn, addLink, addMap, addView, deleteMap, updateMap, buildFileIndex, buildLinkIndex, tablesOf, type CellValue, deleteView, updateView, addRow, addTable, deleteColumn, deleteRow, deleteTable, moveColumn, moveLink, moveTable, removeLink, renameColumn, isComputed, rowExists, setCell, setColumnWidth, summarize,
  type AggFn, type ColType, type ColumnInfo, type LinkIndex, type LinkSlot, type TableInfo,
} from './model'
import { useCell, useFileIndex, useLinkIndex, useRingVersion, useRowVersion, useTabs } from './useTables'
import { FileCell } from './FileCell'
import { SelectCell } from './SelectCell'
import { ColumnDialog } from './ColumnDialog'
import { DatePicker } from './DatePicker'
import { floatingFromMs } from './dateFormat'
import { SheetIcon } from './icons'
import { useVirtualRows } from './virtualRows'
import { useRowTransitions } from './rowTransitions'
import { allowsMultiTarget, targetAvailable } from './relationRules'
import { beginTileDrag, registerDropTarget, type DragPayload } from './tileDrag'
import { computeView } from './viewEngine'
import { FooterCell } from './Footer'
import { GeoCell } from './GeoCell'
import { writeBlocker } from './viewWrite'
import { RecordForm, commitRecord, firstTextColumn, formColumns, updateRecord, type ExistingRecord } from './RecordForm'
import { ReprContext, TileContent, tileClasses, useReprs } from './ReprTile'
import { initials, reprMap, type Repr } from './repr'
import { columnCells, newCtx, type Cell as CellData } from './cells'
import { FormulaSyntaxError, parseFormula, parseTemplate } from './formula'
import { effectiveType } from './columnTypes'
import { useRights } from './rights'
import { hiddenByRights } from './rightsView'
import { plainOf, ringOf } from './colCrypt'
import { ViewDialog } from './ViewDialog'
import { ViewGrid } from './ViewGrid'
import { MapView } from './MapView'
import { MapDialog } from './MapDialog'
import { aggLabel, allowedAggs, defaultAgg } from './aggregate'
import { sortedRowIds, sortRelevant, type SortDir } from './sorting'
import { CHECKBOX, DATE, FILE, ROLLUP, NUMBER, RELATION, TEXT } from './columnTypes'
import { RichPreview, RichTextDialog } from './richText'
import { SyncDialog, syncLabel, type SyncControl } from './SyncDialog'
import { isMobileUI } from './platform'
import { ItemMenu, beginLongPress } from './ItemMenu'
import { AccountButton } from './ProfileDialog'
import { useUndo } from './undo'
import { AnimItem, useAnimatedList } from './animatedList'
import { ConfirmDialog, Modal } from './Modal'
import { TableDialog } from './TableDialog'
import { t, tn, locale, useLanguage } from './i18n'

// ---------- Kacheln ----------

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
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const touchMenu = isMobileUI && !!props.onRemove // statt des Kreuzes: langes Drücken öffnet ein Menü
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
    <div className={`tile ${tileClasses(s)} ${exists ? '' : 'deleted'} ${props.onClick ? 'clickable' : ''} ${props.muted ? 'muted' : ''} ${props.drag ? 'draggable' : ''}`}
      title={s && exists ? [s.title, ...s.subs].join('\n') : undefined} // Text der Darstellung als Tooltip (wichtig bei „nur Avatar“)
      onClick={props.onClick}
      onContextMenu={touchMenu ? (e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }) } : undefined}
      onPointerDown={props.drag ? (e) => beginTileDrag(e.nativeEvent, e.currentTarget, { slot: props.drag!.slot, targetRow: rowId, targetTable: props.drag!.targetTable }, touchMenu ? (x, y) => setMenu({ x, y }) : undefined)
        : touchMenu ? (e) => beginLongPress(e.nativeEvent, (x, y) => setMenu({ x, y })) : undefined}>
      {s ? <TileContent repr={s} /> : <div className="tile-body"><div className="tile-title">{t('gelöscht')}</div></div>}
      {menu && <ItemMenu x={menu.x} y={menu.y} label={t('Verknüpfung entfernen')} onRemove={props.onRemove!} onClose={() => setMenu(null)} />}
      {props.onRemove && !isMobileUI && (
        <button type="button" className="tile-x" title={t('Verknüpfung entfernen')}
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
  /** Nicht wählbar (z. B. Ziel, das schon zu einer anderen Zeile gehört). */
  unavailable?: string[]
  onPick: (rowId: string) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const reprs = useReprs()
  const rights = useRights()
  const mayCreate = rights.canAdd(props.target.id, props.target.columns.map((c) => c.id))
  // Gesucht wird in der Darstellung (Titel, Untertitel) und in allen Spalten des Datensatzes, auch in ausgeblendeten
  const needle = q.trim().toLowerCase()
  const columnTexts = useMemo(() => {
    if (!needle) return null
    const ctx = newCtx()
    return props.target.columns.filter((c) => rights.colAccess(props.target.id, c.id) !== 'none').map((c) => columnCells(props.doc, props.tables, props.target, c, ctx))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.doc, props.target, props.tables, needle])
  const rows = props.target.rowIds
    .filter((id) => !props.linked.includes(id) && !props.unavailable?.includes(id))
    .filter((id) => {
      if (!needle) return true
      const s = reprs(props.target.id)?.get(id) ?? summarize(props.doc, props.target, id)
      return [s.title, ...s.subs].join(' ').toLowerCase().includes(needle)
        || !!columnTexts?.some((m) => (m.get(id)?.text ?? '').toLowerCase().includes(needle))
    })
  // alphabetisch nach der Darstellung (Titel, dann Untertitel); Zahlen im Text nach ihrem Wert („2“ vor „10“)
  const label = (id: string) => { const s = reprs(props.target.id)?.get(id) ?? summarize(props.doc, props.target, id); return [s.title, ...s.subs].join(' ') }
  const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' })
  const sorted = rows.map((id) => ({ id, text: label(id) })).sort((a, b) => collator.compare(a.text, b.text)).map((x) => x.id)
  return (
    <Modal onClose={props.onClose}>
      <div className="dialog picker" onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>{t('Datensatz aus „{name}“ verknüpfen', { name: props.target.name })}</h3>
        <input autoFocus placeholder={t('Suchen …')} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="picker-list">
          {sorted.map((id) => (
            <Tile key={id} doc={props.doc} table={props.target} rowId={id} display="full" onClick={() => props.onPick(id)} />
          ))}
          {sorted.length === 0 && <p className="hint">{t('Keine passenden Datensätze.')}</p>}
        </div>
        <div className="actions split">
          {props.allowCreate !== false && mayCreate ? <button type="button" onClick={() => setCreating(true)}>{t('+ Neuer Datensatz …')}</button> : <span />}
          <button type="button" onClick={props.onClose}>{t('Fertig')}</button>
        </div>
        {creating && (
          <RecordForm doc={props.doc} table={props.target} title={t('Neuer Datensatz in „{name}“', { name: props.target.name })} access={(c) => rights.colAccess(props.target.id, c.id)}
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
  const rights = useRights()
  const colAccess = (c: ColumnInfo) => rights.colAccess(table.id, c.id)
  const readOnly = !table.columns.some((c) => colAccess(c) === 'write')
  const reprs = useReprs()
  const title = reprs(table.id)?.get(rowId)?.title ?? summarize(doc, table, rowId).title
  // Stand beim Öffnen: Werte, Dateien, Verknüpfungen
  const [snap] = useState(() => {
    const row: Y.Map<any> | undefined = tablesOf(doc).get(table.id)?.get('rows').get(rowId)
    const values: Record<string, CellValue> = {}
    for (const c of formColumns(table)) if (c.type !== 'relation' && c.type !== 'file') values[c.id] = (plainOf(doc, c.id, row?.get(c.id)) as CellValue | undefined) ?? null
    const links = buildLinkIndex(doc).forward, files = buildFileIndex(doc)
    const existing: ExistingRecord = { files: {}, relations: {} }
    for (const c of table.columns) {
      if (c.type === 'relation') existing.relations[c.id] = [...(links.get(`${rowId}|${c.id}`) ?? [])]
      if (c.type === 'file') existing.files[c.id] = [...(files.get(`${rowId}|${c.id}`) ?? [])]
    }
    return { values, existing }
  })
  return (
    <RecordForm doc={doc} table={table} title={t('„{title}“ bearbeiten', { title })} submitLabel={t('Speichern')} readOnly={readOnly} access={colAccess} initial={snap.values} existing={snap.existing}
      onClose={props.onClose}
      relationField={(col, ids, update) => <RelationDraftField doc={doc} tables={tables} col={col} ids={ids} update={update} rowId={rowId} readOnly={colAccess(col) !== 'write'} />}
      onSubmit={async (values, extras) => {
        await updateRecord(doc, table.id, rowId, values, snap.values, extras, snap.existing.relations)
        props.onClose()
      }} />
  )
}

/** Relationsfeld im Formular: gewählte Zielzeilen als Kacheln, „+“ öffnet die Auswahl. Gespeichert wird erst beim Anlegen. */
function RelationDraftField(props: { doc: Y.Doc; tables: TableInfo[]; col: ColumnInfo; ids: string[]; update: (f: (prev: string[]) => string[]) => void; /** Der Datensatz, der bearbeitet wird (nicht beim Anlegen). */ rowId?: string; readOnly?: boolean }) {
  const { doc, tables, col, ids, update } = props
  const target = tables.find((t) => t.id === col.target)
  const owner = tables.find((t) => t.columns.some((c) => c.id === col.id))
  const index = useLinkIndex(doc)
  const unavailable = target ? target.rowIds.filter((id) => !targetAvailable(index, col, id, props.rowId ? [props.rowId] : [], (r) => !!owner && rowExists(doc, owner.id, r))) : []
  const [picking, setPicking] = useState(false)
  const single = RELATION.config(col).single
  return (
    <div className="tiles rf-tiles">
      {ids.map((id) => <Tile key={id} doc={doc} table={target} rowId={id} display={RELATION.config(col).display === 'avatar' ? 'avatar' : undefined} onRemove={props.readOnly ? undefined : () => update((p) => p.filter((x) => x !== id))} />)}
      {!props.readOnly && !(single && ids.length >= 1) && (
        <button type="button" className="add-tile" onClick={() => setPicking(true)} disabled={!target} title={target ? t('Datensatz verknüpfen') : t('Zieltabelle fehlt')}>+</button>
      )}
      {picking && target && (
        <Picker doc={doc} tables={tables} target={target} linked={ids} unavailable={unavailable} allowCreate={false}
          onPick={(id) => update((p) => (p.includes(id) ? p : [...p, id]))}
          onClose={() => setPicking(false)} />
      )}
    </div>
  )
}

function DropGap({ width, height }: { width: number; height: number }) {
  const ref = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && typeof el.animate === 'function') el.animate([{ width: '0px', opacity: 0 }, { width: `${width}px`, opacity: 1 }], { duration: 160, easing: 'ease-out' })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return <i ref={ref} className="drop-gap" style={{ width, height }} />
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
  const ro = useRights().colAccess(table.id, col.id) !== 'write'
  const target = tables.find((t) => t.id === col.target)
  const ids = index.forward.get(`${rowId}|${col.id}`) ?? []
  const anim = useAnimatedList(ids, (id) => id)
  const [picking, setPicking] = useState(false)
  const [editingRow, setEditingRow] = useState<string | null>(null) // Datensatz im Formular öffnen
  const [over, setOver] = useState(false)
  const slot: LinkSlot = { tableId: table.id, rowId, colId: col.id }

  // Ablageziel: Kacheln derselben Zieltabelle (auch aus dieser Zelle: dann wird umsortiert)
  const sameSlot = (p: DragPayload) => p.slot.tableId === table.id && p.slot.rowId === rowId && p.slot.colId === col.id
  const cellRef = useRef<HTMLDivElement>(null)
  const tilesEl = useRef<HTMLDivElement>(null)
  const [ins, setIns] = useState<{ index: number; width: number; height: number; lift: boolean } | null>(null)
  /** Einfügestelle unter dem Mauszeiger: Index unter den angezeigten Kacheln und die Zeile, vor der eingefügt wird (null = ans Ende). */
  const dropSpot = (x: number, y: number, p: DragPayload) => {
    const box = tilesEl.current
    if (!box) return null
    const items = Array.from(box.children).filter((el) => !el.classList.contains('add-tile') && !el.classList.contains('drop-gap')) as HTMLElement[]
    const rects = items.map((el) => el.getBoundingClientRect())
    let i = rects.length
    for (let k = 0; k < rects.length; k++) {
      const r = rects[k]
      if (y < r.top || (y <= r.bottom && x < r.left + r.width / 2)) { i = k; break }
    }
    const dragged = p.targetRow
    const entries = anim.entries
    let before: string | null = null
    for (let k = i; k < entries.length; k++) if (entries[k].phase !== 'exit' && !(sameSlot(p) && entries[k].item === dragged)) { before = entries[k].item; break }
    // Platzhalter in Größe der gezogenen Kachel; liegt der Zeiger schon darauf, bleibt er, wo er ist (sonst zappelt er)
    const ghost = document.querySelector('.tile-ghost')?.getBoundingClientRect()
    const gap = box.querySelector('.drop-gap')?.getBoundingClientRect()
    const onGap = !!gap && x >= gap.left && x <= gap.right && y >= gap.top && y <= gap.bottom
    // das einzige Objekt der Zelle lässt sich nirgends sonst einsortieren: kein Platzhalter
    const alone = sameSlot(p) && entries.filter((e) => e.phase !== 'exit').length <= 1
    const line = ghost && !alone ? { index: i, width: ghost.width, height: ghost.height, lift: sameSlot(p) } : null
    if (onGap) return { before, line: null, keep: true }
    return { before, line, keep: false }
  }

  // Beim Umsortieren in dieser Zelle verschwindet die Kachel in der Hand von ihrem Platz (der Platzhalter vertritt sie);
  // alles, was der Platzhalter verschiebt, gleitet an seine neue Stelle.
  const lifted = !!ins?.lift
  useLayoutEffect(() => {
    const el = tilesEl.current?.querySelector('.tile.dragging')?.closest('.anim-item')
    if (!el || !lifted) return
    el.classList.add('lifted')
    return () => el.classList.remove('lifted')
  }, [lifted])
  const placed = useRef(new Map<Element, { x: number; y: number }>())
  const wasIns = useRef(false)
  const order = useRef<string[]>([])
  useLayoutEffect(() => {
    const box = tilesEl.current
    if (!box) return
    const next = new Map<Element, { x: number; y: number }>()
    const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    // Reihenfolge der bleibenden Kacheln geändert (z. B. von jemand anderem umsortiert)? Dann gleiten sie an den neuen Platz.
    const keys = anim.entries.filter((e) => e.phase !== 'exit').map((e) => e.key)
    const before = order.current.filter((k) => keys.includes(k))
    const reordered = before.join('|') !== keys.filter((k) => before.includes(k)).join('|')
    order.current = keys
    for (const el of Array.from(box.children) as HTMLElement[]) {
      const at = { x: el.offsetLeft, y: el.offsetTop }
      next.set(el, at)
      const was = placed.current.get(el)
      if (was && (ins || wasIns.current || reordered) && !calm && (Math.abs(was.x - at.x) > 1 || Math.abs(was.y - at.y) > 1))
        el.animate([{ transform: `translate(${was.x - at.x}px, ${was.y - at.y}px)` }, { transform: 'none' }], { duration: reordered ? 300 : 180, easing: 'ease-out' })
    }
    placed.current = next
    wasIns.current = !!ins
  })

  // Ohne „Zieldatensatz darf mehrfach verknüpft werden“ gehört ein Ziel zu höchstens einer Zeile: Ablegen nur, wenn es frei ist
  // (oder von der Quelle einer Verschiebung innerhalb derselben Spalte kommt)
  const exists = (r: string) => rowExists(doc, table.id, r)
  const sameCol = (p: DragPayload) => p.slot.tableId === table.id && p.slot.colId === col.id
  const ignoreFor = (p: DragPayload) => (sameCol(p) ? [rowId, p.slot.rowId] : [rowId])
  // Ablageziel für gezogene Kacheln (Umschalt oder Alt/Option beim Loslassen = kopieren statt verschieben); die Funktionen
  // greifen auf den aktuellen Stand zu, darum wird bei jedem Zeichnen neu angemeldet.
  useEffect(() => cellRef.current ? registerDropTarget(cellRef.current, {
    accepts: (p) => !!col.target && p.targetTable === col.target && (sameSlot(p) || targetAvailable(index, col, p.targetRow, ignoreFor(p), exists)),
    hover: (x, y, _copy, p) => { setOver(false); const s = dropSpot(x, y, p); if (s && !s.keep) setIns((o) => (o && s.line && o.index === s.line.index && o.lift === s.line.lift ? o : s.line)) },
    leave: () => { setOver(false); setIns(null) },
    drop: (x, y, copy, p) => {
      setOver(false)
      setIns(null)
      const spot = dropSpot(x, y, p)
      // Kopieren innerhalb derselben Spalte würde das Ziel doppelt verknüpfen: dort wird verschoben
      moveLink(doc, p.slot, slot, p.targetRow, copy && (allowsMultiTarget(col) || !sameCol(p)), spot ? spot.before : undefined)
    },
  }) : undefined)

  return (
    <div ref={cellRef} className={`c rel ${over ? 'drop-over' : ''}`}>
      <div className="tiles" ref={tilesEl}>
        {(() => {
          const nodes = anim.entries.map((e) => (
            <AnimItem key={e.key} phase={e.phase} onExited={() => anim.done(e.key)}>
              <Tile doc={doc} table={target} rowId={e.item}
                display={RELATION.config(col).display === 'avatar' ? 'avatar' : undefined}
                drag={ro ? undefined : { slot, targetTable: col.target }}
                onClick={() => setEditingRow(e.item)}
                onRemove={ro ? undefined : () => removeLink(doc, table.id, rowId, col.id, e.item)} />
            </AnimItem>
          ))
          if (ins) nodes.splice(Math.min(ins.index, nodes.length), 0, <DropGap key="drop-gap" width={ins.width} height={ins.height} />)
          return nodes
        })()}
        {!ro && !(RELATION.config(col).single && ids.length >= 1) && <button type="button" className="add-tile" onClick={() => setPicking(true)} disabled={!target}
          title={target ? t('Datensatz verknüpfen') : t('Zieltabelle fehlt')}>+</button>}
      </div>
      {picking && target && (
        <Picker doc={doc} tables={tables} target={target} linked={ids}
          unavailable={target.rowIds.filter((id) => !targetAvailable(index, col, id, [rowId], exists))}
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
  const [linking, setLinking] = useState<{ current: string | null } | null>(null) // Rückverweis ändern (current) oder neu hinzufügen (null)
  const target = props.tables.find((t) => t.id === props.col.target)
  const multi = allowsMultiTarget(props.col) // sonst steht im Rückverweis höchstens ein Datensatz
  const ro = useRights().colAccess(props.source.id, props.col.id) !== 'write'
  const [viewing, setViewing] = useState<string | null>(null) // nur lesen: Datensatz im Formular ansehen
  return (
    <div className="c rel backlink">
      <div className="tiles">
        {anim.entries.map((e) => (
          <AnimItem key={e.key} phase={e.phase} onExited={() => anim.done(e.key)}>
            <Tile doc={props.doc} table={props.source} rowId={e.item} muted onClick={() => ro ? setViewing(e.item) : setLinking({ current: e.item })} />
          </AnimItem>
        ))}
        {anim.entries.length === 0 && <span className="empty">–</span>}
        {!ro && target && (multi || ids.length === 0) && <button type="button" className="add-tile" onClick={() => setLinking({ current: null })} title={t('Datensatz aus „{name}“ verknüpfen', { name: props.source.name })}>+</button>}
      </div>
      {viewing && rowExists(props.doc, props.source.id, viewing) && (
        <EditRecordDialog doc={props.doc} tables={props.tables} table={props.source} rowId={viewing} onClose={() => setViewing(null)} />
      )}
      {linking && target && (
        <BacklinkPicker doc={props.doc} source={props.source} col={props.col} target={target} rowId={props.rowId} current={linking.current} linked={ids} multi={multi} onClose={() => setLinking(null)} />
      )}
    </div>
  )
}

/**
 * Rückverweis bearbeiten (Klick auf eine Kachel in der Zieltabelle): aus Sicht des Datensatzes, den man gerade sieht, wird
 * gewählt, welcher Datensatz der Quelltabelle hier stehen soll – oder keiner. `current` ist der bisherige (null = neu hinzufügen).
 * Die Wahl ersetzt `current` sofort; bei Spalten mit „höchstens eine Verknüpfung“ verliert der gewählte Datensatz seine
 * bisherige Verknüpfung.
 */
function BacklinkPicker(props: { doc: Y.Doc; source: TableInfo; col: ColumnInfo; target: TableInfo; rowId: string; current: string | null; linked: string[]; multi: boolean; onClose: () => void }) {
  const { doc, source, col, target, rowId } = props
  const reprs = useReprs()
  const [q, setQ] = useState('')
  const [current, setCurrent] = useState(props.current) // bleibt offen: die Wahl gilt sofort, man kann weiter ändern
  const single = RELATION.config(col).single
  const titleOf = (t: TableInfo, id: string) => reprs(t.id)?.get(id)?.title ?? summarize(doc, t, id).title
  // Datensätze, die schon an anderer Stelle in diesem Feld stehen, sind nicht noch einmal wählbar
  const rows = source.rowIds
    .filter((id) => id === current || !props.linked.includes(id))
    .filter((id) => {
      const s = reprs(source.id)?.get(id) ?? summarize(doc, source, id)
      return [s.title, ...s.subs].join(' ').toLowerCase().includes(q.toLowerCase())
    })
  const choose = (id: string | null) => {
    if (id === current) return
    doc.transact(() => {
      if (current) removeLink(doc, source.id, current, col.id, rowId)
      if (id) {
        if (single) for (const x of buildLinkIndex(doc).forward.get(`${id}|${col.id}`) ?? []) removeLink(doc, source.id, id, col.id, x)
        // ohne Mehrfach-Verknüpfung steht hier höchstens ein Datensatz: andere Verweise auf diesen entfallen
        if (!props.multi) for (const r of buildLinkIndex(doc).backward.get(`${rowId}|${col.id}`) ?? []) removeLink(doc, source.id, r, col.id, rowId)
        addLink(doc, source.id, id, col.id, rowId)
      }
    })
    setCurrent(id)
  }
  const radio = (id: string | null, label: string, content: ReactNode) => {
    const on = id === current
    return (
      <div key={id ?? 'none'} className={`pick-item radio${on ? ' on' : ''}`} role="radio" aria-checked={on} aria-label={label} tabIndex={0}
        onClick={() => choose(id)} onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); choose(id) } }}>
        <span className="pick-mark" aria-hidden />
        {content}
      </div>
    )
  }
  return (
    <Modal onClose={props.onClose}>
      <div className="dialog picker" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>{t('Datensatz aus „{source}“ für „{target}“', { source: source.name, target: titleOf(target, rowId) })}</h3>
        <p className="hint">{t('Spalte „{col}“ in „{source}“ verweist auf diesen Datensatz.', { col: col.name, source: source.name })}</p>
        <input autoFocus placeholder={t('Suchen …')} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="picker-list" role="radiogroup" aria-label={t('Datensatz aus {name}', { name: source.name })}>
          {radio(null, t('Keine Verknüpfung'), <span className="pick-none">{t('Keine Verknüpfung')}</span>)}
          {rows.map((id) => radio(id, titleOf(source, id), <Tile doc={doc} table={source} rowId={id} display="full" />))}
          {rows.length === 0 && <p className="hint">{t('Keine passenden Datensätze.')}</p>}
        </div>
        <div className="actions"><button type="button" className="primary" onClick={props.onClose}>{t('Fertig')}</button></div>
      </div>
    </Modal>
  )
}

// ---------- Zellen ----------

function Cell({ doc, table, rowId, col }: { doc: Y.Doc; table: string; rowId: string; col: ColumnInfo; lead?: boolean }) {
  const value = useCell(doc, table, rowId, col.id)
  if (col.type === 'number') return <NumberInput doc={doc} table={table} rowId={rowId} col={col} value={value} />
  if (col.type === 'geo') return <GeoCell doc={doc} tableId={table} rowId={rowId} col={col} />
  if (col.type === 'checkbox') return <CheckboxInput doc={doc} table={table} rowId={rowId} col={col} value={value} />
  if (col.type === 'date') return <DateInput doc={doc} table={table} rowId={rowId} col={col} value={value} />
  if (col.type === 'link') return <LinkInput doc={doc} table={table} rowId={rowId} col={col} value={value} />
  if (col.type === 'duration') return <DurationInput doc={doc} table={table} rowId={rowId} col={col} value={value} />
  if (col.type === 'person') return <PersonCell doc={doc} table={table} rowId={rowId} col={col} value={value} />
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
  return (
    <div className="c">
      <DatePicker className="cell cell-date" value={value} withTime={cfg.time} style={cfg.style} placeholder={col.name}
        onChange={(v) => setCell(doc, table, rowId, col.id, v)} />
    </div>
  )
}

function NumberInput({ doc, table, rowId, col, value }: { doc: Y.Doc; table: string; rowId: string; col: ColumnInfo; value: unknown }) {
  const cfg = NUMBER.config(col)
  const round = (n: number) => (cfg.decimals >= 0 ? Number(n.toFixed(cfg.decimals)) : n)
  return (
    <div className="c">
      <input className="cell" type="number" enterKeyHint="next" value={(value as number | null) ?? ''} placeholder={col.name}
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
        <button type="button" className="rich-cell" title={t('Text bearbeiten')} onClick={() => setEditing(true)}>
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
        : <input className={cls} type="text" enterKeyHint="next" value={text} placeholder={col.name} onChange={(e) => change(e.target.value)} />}
    </div>
  )
}

/** Pfeile für die Sortierung (als Zeichnung, damit iOS keine bunten Emoji daraus macht). */
function SortIcon({ dir }: { dir: SortDir | null }) {
  return (
    <svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {dir === 'asc' && <path d="M7 12V2.5M3.2 6L7 2.2 10.8 6" />}
      {dir === 'desc' && <path d="M7 2v9.5M3.2 8L7 11.8 10.8 8" />}
      {dir === null && <path d="M4 5.2L7 2.2l3 3M4 8.8l3 3 3-3" />}
    </svg>
  )
}

/** Hinweis „GPS-Tracking aktiv“ neben der Wolke: zeigt Ziel und Beginn, und beendet die Verfolgung. */
function TrackingChip({ doc }: { doc: Y.Doc }) {
  const tr = useTracking()
  const [open, setOpen] = useState(false)
  useEffect(() => { if (!tr) setOpen(false) }, [tr])
  if (!tr || tr.target.doc !== doc) return null
  const since = new Date(tr.since)
  const sinceText = since.toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  const tg = tr.target
  return (
    <span className="track-wrap">
      <button type="button" className={`track-chip${tr.error ? ' err' : ''}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <i className="track-dot" />{tr.error ? t('GPS-Tracking gestoppt') : t('GPS-Tracking aktiv')}
      </button>
      {open && (
        <div className="track-pop" role="dialog" aria-label={t('GPS-Tracking')}>
          <dl>
            <dt>{t('Gespeichert in')}</dt><dd>{t('Tabelle „{table}“, {row}, Spalte „{col}“', { table: tg.tableName, row: tg.rowLabel, col: tg.colName })}</dd>
            <dt>{t('Seit')}</dt><dd>{sinceText}</dd>
            <dt>{t('Letzte Position')}</dt><dd>{tr.last ? `${tr.last.point.lat.toFixed(5)}, ${tr.last.point.lon.toFixed(5)} (${new Date(tr.last.at).toLocaleTimeString(locale())})` : t('noch keine')}</dd>
          </dl>
          {tr.error && <p className="formula-error">{tr.error}</p>}
          <div className="actions"><button type="button" onClick={() => setOpen(false)}>{t('Schließen')}</button><button type="button" className="danger-outline" onClick={() => stopTracking()}>{t('Tracking beenden')}</button></div>
        </div>
      )}
    </span>
  )
}

/** Wolke unten rechts: zeigt den Stand der Synchronisation, ein Klick öffnet die Einstellungen. */
export interface AsOfInfo {
  /** Gewählter Zeitpunkt (ms) */ at: number
  /** Ältester und neuester Eintrag im Protokoll (ms) oder null */ earliest: number | null
  latest: number | null
  /** Stand eventuell ungenau (Einträge ohne Gegenschritte) */ incomplete: boolean
  /** Anzahl der Einträge im Stand und insgesamt */ pos: number
  total: number
  /** Einträge je Abschnitt der Zeitleiste */ histogram: number[]
  /** Letzte Änderung im Stand, als Satz, und ihre Zeit */ caption: string | null
  captionTime: number | null
  playing: boolean
  onChange: (at: number) => void
  onSeek: (at: number) => void
  onStep: (dir: 1 | -1) => void
  onPlay: () => void
  onExit: () => void
}

const stamp = (ms: number) => new Date(ms).toLocaleString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** Zeitleiste: Säulen zeigen, wann viel passiert ist; Klick oder Ziehen springt in die Zeit. */
function AsOfTimeline({ info }: { info: AsOfInfo }) {
  const track = useRef<HTMLDivElement>(null)
  const { earliest, latest } = info
  const span = earliest !== null && latest !== null ? Math.max(1, latest - earliest) : 1
  const max = Math.max(1, ...info.histogram)
  const frac = earliest === null ? 0 : Math.min(1, Math.max(0, (info.at - earliest) / span))
  const seek = (e: ReactPointerEvent) => {
    if (earliest === null || !track.current) return
    const r = track.current.getBoundingClientRect()
    info.onSeek(Math.round(earliest + Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * span))
  }
  const tooEarly = earliest !== null && info.at < earliest - 1 // „ganz am Anfang“ (Stand vor dem ersten Eintrag) ist ein gültiger Stand
  return (
    <div className="asof-timeline">
      <div className="asof-caption" aria-live="polite">
        {info.total === 0 ? t('Das Protokoll ist noch leer.') : info.caption
          ? <>{info.caption}{info.captionTime !== null && <small> · {stamp(info.captionTime)}</small>}</>
          : t('Bis zu diesem Zeitpunkt gab es noch keine Änderung im Protokoll.')}
        {info.total > 0 && <small className="asof-count"> {t('{pos} von {total}', { pos: info.pos, total: info.total })}</small>}
        {tooEarly && <span className="asof-warn"> {t('Zurückgerechnet werden kann nur ab {time}; davor ist der Stand nicht bekannt.', { time: stamp(earliest!) })}</span>}
        {info.incomplete && <span className="asof-warn"> {t('Einige ältere Einträge enthalten keine Gegenschritte; der Stand kann ungenau sein.')}</span>}
      </div>
      <div className="asof-row">
        <button type="button" className="asof-play" onClick={info.onPlay} disabled={info.total === 0} aria-pressed={info.playing} aria-label={info.playing ? t('Pause') : t('Abspielen')} title={info.playing ? t('Pause') : t('Abspielen')}>{info.playing ? '❚❚' : '▶'}</button>
        <div className="asof-trackbox">
          <div ref={track} className="asof-track" role="slider" aria-label={t('Zeitleiste')} aria-valuemin={earliest ?? 0} aria-valuemax={latest ?? 0} aria-valuenow={info.at}
            tabIndex={0}
            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); seek(e) }}
            onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) seek(e) }}
            onKeyDown={(e) => { if (e.key === 'ArrowLeft') { e.preventDefault(); info.onStep(-1) } else if (e.key === 'ArrowRight') { e.preventDefault(); info.onStep(1) } }}>
            <div className="asof-bars">
              {info.histogram.map((n, i) => <span key={i} className={n ? 'has' : ''} style={{ height: n ? `${Math.max(12, Math.round((n / max) * 100))}%` : undefined }} title={n ? tn(n, '{n} Änderung', '{n} Änderungen') : undefined} />)}
            </div>
            <div className="asof-progress" style={{ width: `${frac * 100}%` }} />
          </div>
          {earliest !== null && latest !== null && <div className="asof-axis"><span>{stamp(earliest)}</span><span>{stamp(latest)}</span></div>}
        </div>
        <button type="button" className="asof-close" onClick={info.onExit} aria-label={t('Zeitreise beenden')} title={t('Zur aktuellen Ansicht')}>✕</button>
      </div>
    </div>
  )
}

/** Zeitpunkt in der Fußzeile der Ansicht eines früheren Standes (derselbe Auswahldialog wie bei Datumsspalten). */
function AsOfPicker({ info }: { info: AsOfInfo }) {
  return (
    <DatePicker className="asof-date" value={floatingFromMs(info.at)} withTime style="short" placeholder={t('Zeitpunkt wählen')}
      onChange={(v) => { const ms = v ? new Date(v).getTime() : NaN; if (Number.isFinite(ms) && ms <= Date.now() && ms !== info.at) info.onChange(ms) }} />
  )
}

function SyncButton(props: { control: SyncControl; onClick: () => void }) {
  const { control } = props
  const status = control.server ? (control.state?.status === 'online' && control.state.readonly ? 'readonly' : control.state?.status ?? 'connecting') : 'none'
  const requests = control.members?.requests.length ?? 0
  const note = requests > 0 ? ` – ${tn(requests, '{n} Beitrittsanfrage', '{n} Beitrittsanfragen')}` : control.moved ? ` – ${t('Dokument ist auf einen anderen Server umgezogen')}` : ''
  const title = `${syncLabel(control)}${note}`
  return (
    <button type="button" className={`sync-btn ${status}${requests > 0 ? ' requests' : ''}`} onClick={props.onClick} title={title} aria-label={t('Cloud: {title}', { title })}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M7 18a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 9.5a4.25 4.25 0 0 1 .5 8.5H7z" />
      </svg>
      {status !== 'none' && <i className="dot" />}
      {requests > 0 && <b className="req-badge">{requests}</b>}
      {requests === 0 && control.moved && <b className="req-badge moved">↪</b>}
    </button>
  )
}

// ---------- Pane ----------

const NO_ROWS: string[] = []

/** Rückgängig und Wiederholen (iPad: oben neben dem Konto). */
function UndoButtons({ undo }: { undo: ReturnType<typeof useUndo> }) {
  const icon = (flip: boolean) => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={flip ? { transform: 'scaleX(-1)' } : undefined}>
      <path d="M9 14L4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  )
  return (
    <span className="undo-btns">
      <button type="button" disabled={!undo.canUndo} onClick={undo.undo} title={t('Rückgängig')} aria-label={t('Rückgängig')}>{icon(false)}</button>
      <button type="button" disabled={!undo.canRedo} onClick={undo.redo} title={t('Wiederholen')} aria-label={t('Wiederholen')}>{icon(true)}</button>
    </span>
  )
}

export function ClientPane(props: {
  title: string
  doc: Y.Doc
  /** IndexedDB-Name für den lokalen Zwischenspeicher; `null` = das Dokument liegt in einer Datei. Standard: nach Titel. */
  persist?: string | null
  /** Zurück zur Dokumentenliste (nur auf iPad/iPhone) */
  onHome?: () => void
  /** Konto-Dialog öffnen (iPad: Knopf in der Kopfzeile über den Blättern) */
  onAccount?: () => void
  /** Cloud-Anbindung des Dokuments (fehlt in der Simulation). */
  sync?: SyncControl
  online?: boolean
  onToggle?: () => void
  /** Ansicht eines früheren Standes (nur Lesen): Zeitpunkt, Auswahl und Rückkehr */
  asOf?: AsOfInfo
}) {
  useLanguage() // bei Sprachwechsel neu zeichnen
  // Wird das Dokument geschlossen, endet auch seine GPS-Verfolgung (sonst schriebe sie ins Leere).
  useEffect(() => () => { if (currentTracking()?.target.doc === props.doc) stopTracking() }, [props.doc])
  const { doc } = props
  const all = useTabs(doc)
  const ringV = useRingVersion(doc) // neu rechnen, wenn Schlüssel vertraulicher Spalten eintreffen
  const rights = useRights()
  // Ohne Leserecht sind Tabellen, abgeleitete Tabellen und Karten für diesen Betrachter nicht vorhanden (docs/RIGHTS.md)
  const { tables, views, maps, tabs } = useMemo(() => {
    if (!rights.active || rights.admin) return all
    const cols = new Map(all.tables.map((x) => [x.id, x.columns.map((c) => c.id)]))
    const see = (id: string) => rights.visible(id, cols.get(id) ?? [])
    return { tables: all.tables.filter((x) => see(x.id)), views: all.views.filter((x) => see(x.id)), maps: all.maps.filter((x) => see(x.id)), tabs: all.tabs.filter((x) => see(x.id)) }
  }, [all, rights])
  const structure = rights.structure
  const index = useLinkIndex(doc)
  const fileIndex = useFileIndex(doc)
  const [active, setActive] = useState<string | null>(null)
  const tab = tabs.find((t) => t.id === active) ?? tabs[0]
  // Zeilenzahl je Reiter: Tabellen kennt das Modell, abgeleitete Tabellen werden berechnet
  const shownTabs = useMemo(() => tabs.map((t) => {
    const v = t.kind === 'view' ? views.find((x) => x.id === t.id) : undefined
    return v ? { ...t, count: computeView(doc, v.def).rows.length } : t
  }), [tabs, views, doc, tables])
  const table = tab?.kind === 'table' ? tables.find((t) => t.id === tab.id) : undefined
  const view = tab?.kind === 'view' ? views.find((v) => v.id === tab.id) : undefined
  const mapTab = tab?.kind === 'map' ? maps.find((m) => m.id === tab.id) : undefined
  const writable = !props.asOf && !!table && rights.access(table.id) === 'write'
  // Spalten, die ein Betrachter ohne Leserecht an der Spalte nicht sehen darf (aller sichtbaren Tabellen, für Rollups)
  const unreadable = useMemo(() => new Set(tables.flatMap((x) => x.columns.filter((c) => rights.colAccess(x.id, c.id) === 'none').map((c) => c.id))), [tables, rights])
  const hiddenCols = useMemo(() => (table ? hiddenByRights(table, tables, unreadable) : new Set<string>()), [table, tables, unreadable])
  const canAdd = !props.asOf && !!table && rights.canAdd(table.id, table.columns.map((c) => c.id))
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
  const [syncOpen, setSyncOpen] = useState(false)
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
  const history = useUndo(doc)
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
  const reorderProps = (kind: ReorderKind, id: string, label: string) => !structure ? {} : ({
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
        t.columns.filter((c) => c.type === 'relation' && c.target === table.id && RELATION.config(c).backlink && !unreadable.has(c.id)).map((c) => ({ source: t, col: c })))
    : []

  // Sortierung ist nur eine Ansicht (pro Tabelle, nur auf diesem Gerät); die gespeicherte Reihenfolge bleibt unverändert.
  // Klick 1: aufsteigend, Klick 2: absteigend, Klick 3: wieder die gespeicherte Reihenfolge.
  const [sorts, setSorts] = useState<Record<string, { colId: string; dir: SortDir }>>({})
  // Ohne eigene Wahl gilt die Standardsortierung der Tabelle (Tabelleneinstellungen); nach dem dritten Klick kehrt man dorthin zurück.
  const sort = table ? sorts[table.id] ?? table.sort : undefined
  const cycleSort = (colId: string) => {
    if (!table) return
    setSorts((all) => {
      const cur = all[table.id] ?? table.sort
      const next = !cur || cur.colId !== colId ? { colId, dir: 'asc' as const } : cur.dir === 'asc' ? { colId, dir: 'desc' as const } : null
      const { [table.id]: _, ...rest } = all
      return next ? { ...rest, [table.id]: next } : rest
    })
  }
  // Während in der Tabelle getippt wird, bleibt die Reihenfolge stehen und wird erst beim Verlassen der Zelle neu sortiert.
  const [sortTick, setSortTick] = useState(0)
  const editingInGrid = useRef(false)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const bump = () => {
      // Folgen mehrere Änderungen dicht aufeinander (Synchronisation), wird nur einmal neu sortiert
      if (timer) return
      timer = setTimeout(() => { timer = undefined; setSortTick((n) => n + 1) }, 120)
    }
    const h = (tr: Y.Transaction) => {
      if (editingInGrid.current) return
      if (!sortRelevant(doc, tr, table?.id, sort?.colId)) return
      bump()
    }
    doc.on('afterTransaction', h)
    return () => { doc.off('afterTransaction', h); if (timer) clearTimeout(timer) }
  }, [doc, table?.id, sort?.colId])
  const rowIds = useMemo(
    () => (table && sort ? sortedRowIds(doc, table.id, sort.colId, sort.dir) : table?.rowIds ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, table?.id, sort?.colId, sort?.dir, sortTick, ringV, table && !sort ? table.rowIds : null],
  )

  // Berechnete Spalten (Rollup) und Spalten mit Summenzeile: je Spalte einmal für alle Zeilen ausgewertet
  const { cellData, reprs } = useMemo(() => {
    const m = new Map<string, Map<string, CellData>>()
    const r = new Map<string, Map<string, Repr>>()
    if (!table && !mapRecord) return { cellData: m, reprs: r }
    const ctx = newCtx() // gemeinsamer Zwischenspeicher: jede Spalte (auch von Formeln benutzte) wird nur einmal berechnet
    for (const c of table?.columns ?? []) if (isComputed(c) || c.type === 'autonumber' || c.type === 'stamp' || c.footer) m.set(c.id, columnCells(doc, tables, table!, c, ctx))
    // Darstellung der Zeilen für alles, was hier als Kachel erscheint: Ziele der Relationen, Quellen der Rückverweise, die Tabelle selbst
    // (auf der Karte gibt es keine Tabelle; dort braucht das Formular der angeklickten Zeile die Darstellung ihrer Tabelle und der Relationsziele)
    const wanted = new Set<string>(table ? [table.id] : [])
    if (mapRecord) wanted.add(mapRecord.tableId)
    for (const c of table?.columns ?? []) if (c.type === 'relation' && c.target) wanted.add(c.target)
    if (table) for (const t of tables) if (t.columns.some((c) => c.type === 'relation' && c.target === table.id)) wanted.add(t.id)
    // Formulare für neue Datensätze zeigen deren Relationen: auch die Ziele der Zieltabellen
    for (const id of [...wanted]) for (const c of tables.find((t) => t.id === id)?.columns ?? []) if (c.type === 'relation' && c.target) wanted.add(c.target)
    for (const t of tables) if (wanted.has(t.id)) r.set(t.id, reprMap(doc, tables, t, ctx))
    return { cellData: m, reprs: r }
    // `index` (Verknüpfungen), `fileIndex` (Bilder) und `tables` (Werte, Struktur) decken alle Änderungen ab, die das Ergebnis beeinflussen
  }, [doc, tables, table?.id, index, fileIndex, mapRecord?.tableId, ringV])
  const reprOf = useCallback((id: string) => reprs.get(id), [reprs])

  const [liveWidth, setLiveWidth] = useState<{ id: string; w: number } | null>(null)
  const startResize = (e: ReactMouseEvent | ReactPointerEvent, colId: string) => {
    e.preventDefault()
    e.stopPropagation()
    const th = (e.currentTarget as HTMLElement).parentElement!
    const startX = e.clientX
    const startW = th.getBoundingClientRect().width
    const pointerId = 'pointerId' in e ? e.pointerId : null // Touch und Stift laufen über Pointer-Ereignisse, die Maus wie bisher über Mausereignisse
    let w = startW
    const move = (ev: MouseEvent | PointerEvent) => {
      if (pointerId !== null && (ev as PointerEvent).pointerId !== pointerId) return
      w = Math.min(800, Math.max(80, Math.round(startW + ev.clientX - startX))); setLiveWidth({ id: colId, w })
    }
    const up = (ev?: Event) => {
      if (pointerId !== null && ev && (ev as PointerEvent).pointerId !== pointerId) return
      const [m, u] = pointerId !== null ? (['pointermove', 'pointerup'] as const) : (['mousemove', 'mouseup'] as const)
      document.removeEventListener(m, move as EventListener)
      document.removeEventListener(u, up)
      document.removeEventListener('pointercancel', up)
      document.body.classList.remove('resizing')
      if (w !== startW) setColumnWidth(doc, table!.id, colId, w)
      setLiveWidth(null)
    }
    document.body.classList.add('resizing')
    if (pointerId !== null) {
      document.addEventListener('pointermove', move as EventListener)
      document.addEventListener('pointerup', up)
      document.addEventListener('pointercancel', up)
    } else {
      document.addEventListener('mousemove', move as EventListener)
      document.addEventListener('mouseup', up)
    }
  }

  // Touch: Tippen auf den Spaltennamen wählt die Spalte aus (Sortierpfeil, Anfasser für die Breite, kleines Menü)
  const [selectedCol, setSelectedCol] = useState<string | null>(null)
  useEffect(() => { setSelectedCol(null) }, [table?.id])
  useEffect(() => {
    if (!selectedCol) return
    const away = (e: PointerEvent) => { if (!(e.target as Element).closest('.h.col-selected')) setSelectedCol(null) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelectedCol(null) }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc) }
  }, [selectedCol])

  const shownColumns = table ? table.columns.filter((c) => !c.hidden && !hiddenCols.has(c.id)) : [] // ausgeblendete Spalten bleiben für Formeln und Darstellung nutzbar

  // Suche: nur Zeilen, bei denen der Suchtext (ohne Beachtung der Groß-/Kleinschreibung) in einer sichtbaren Spalte vorkommt.
  // Wie die Sortierung wird sie während der Eingabe in der Tabelle nicht neu ausgewertet, damit Zeilen nicht unter dem Cursor verschwinden.
  const [searches, setSearches] = useState<Record<string, string>>({})
  const rawQuery = (table && searches[table.id]?.trim().toLowerCase()) || ''
  // Große Tabellen: erst suchen, wenn kurz nicht getippt wurde (sonst ruckelt jeder Tastendruck)
  const slowSearch = (table?.rowIds.length ?? 0) > 2000
  const [lateQuery, setLateQuery] = useState(rawQuery)
  useEffect(() => {
    if (!slowSearch) return
    const id = setTimeout(() => setLateQuery(rawQuery), rawQuery ? 200 : 0)
    return () => clearTimeout(id)
  }, [rawQuery, slowSearch])
  const query = slowSearch ? lateQuery : rawQuery
  // Tippen ohne Fokus (kein Feld, kein Dialog) landet in der Suche
  const searchRef = useRef<HTMLInputElement>(null)
  // Haftet die Kopfzeile am oberen Rand (Tabelle ist angescrollt), verliert sie ihre runden Ecken: sonst scheinen dahinter die Zeilen durch
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const check = () => {
      const wrap = wrapRef.current, head = wrap?.querySelector('.grid-head')
      if (wrap && head) wrap.classList.toggle('scrolled', head.getBoundingClientRect().top > wrap.getBoundingClientRect().top + 2)
    }
    document.addEventListener('scroll', check, { capture: true, passive: true })
    window.addEventListener('resize', check)
    check()
    return () => { document.removeEventListener('scroll', check, true); window.removeEventListener('resize', check) }
  }, [])
  const tableId = table?.id
  useEffect(() => {
    if (!tableId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.key.length !== 1 || e.key === ' ' || e.metaKey || e.ctrlKey || e.altKey) return
      const active = document.activeElement
      if (active && active !== document.body && active !== document.documentElement) return // etwas anderes hat den Fokus
      if (document.querySelector('.dialog, .datepop, .backdrop')) return // Dialog offen
      const input = searchRef.current
      if (!input) return
      e.preventDefault()
      setSearches((all) => ({ ...all, [tableId]: (all[tableId] ?? '') + e.key }))
      input.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [tableId])
  // Wird die Suche länger getippt, genügt es, die bisherigen Treffer zu prüfen (gleiche Daten vorausgesetzt)
  const lastSearch = useRef<{ key: unknown[]; query: string; hits: Set<string> } | null>(null)
  const matching = useMemo(() => {
    if (!table || !query) { lastSearch.current = null; return null }
    const key = [doc, table.id, sortTick, table.rowIds.length, index, fileIndex, tables]
    const prev = lastSearch.current
    const narrowing = !!prev && prev.query.length > 0 && query.startsWith(prev.query) && prev.key.length === key.length && prev.key.every((k, i) => k === key[i])
    const ctx = newCtx()
    const texts = shownColumns.map((c) => columnCells(doc, tables, table, c, ctx))
    const ok = new Set<string>()
    for (const rid of narrowing ? prev!.hits : table.rowIds) if (texts.some((m) => (m.get(rid)?.text ?? '').toLowerCase().includes(query))) ok.add(rid)
    lastSearch.current = { key, query, hits: ok }
    return ok
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, table?.id, query, sortTick, table?.rowIds.length, index, fileIndex, ringV])
  const visibleIds = useMemo(() => (matching ? rowIds.filter((id) => matching.has(id)) : rowIds), [rowIds, matching])
  // Große Tabellen: nur die Zeilen in und um den sichtbaren Bereich zeichnen
  const virt = useVirtualRows(visibleIds)
  // Neue und gelöschte Zeilen gleiten ein bzw. aus (auch wenn sie von einem Abgleich kommen)
  useRowTransitions(sectionRef, table?.id, table?.rowIds ?? NO_ROWS, visibleIds.slice(virt.start, virt.end).join('|'))

  // Nach „+ Zeile“: zur neuen Zeile scrollen und ihre erste Zelle fokussieren
  // `col`: Position der Spalte, deren Zelle den Fokus bekommt (ohne Angabe die erste)
  const [focusTarget, setFocusTarget] = useState<{ id: string; col?: number } | null>(null)
  const focusRow = focusTarget?.id ?? null
  const setFocusRow = (id: string | null, col?: number) => setFocusTarget(id ? { id, col } : null)
  useEffect(() => {
    if (!focusRow) return
    const row = sectionRef.current?.querySelector<HTMLElement>(`[data-row="${focusRow}"]`)
    if (!row) {
      // noch nicht gezeichnet (große Tabelle): hinscrollen, der Effekt läuft mit dem neuen Bereich erneut
      const i = visibleIds.indexOf(focusRow)
      if (i >= 0) virt.scrollToIndex(i)
      return
    }
    row.scrollIntoView({ block: 'nearest' })
    const focusable = 'input, textarea, button, select'
    const cell = focusTarget?.col != null ? row.querySelector<HTMLElement>(`.row-inner > :nth-child(${focusTarget.col + 1})`) : null
    ;(cell?.querySelector<HTMLElement>(focusable) ?? row.querySelector<HTMLElement>(focusable))?.focus({ preventScroll: true })
    setFocusRow(null)
  }, [focusRow, rowIds, visibleIds, virt.start, virt.end])
  const template = table
    ? [
        ...shownColumns.map((c, i) =>
          liveWidth?.id === c.id ? `${liveWidth.w}px` : c.width ? `${c.width}px` : i === 0 ? '200px' : c.type === 'relation' || c.type === 'file' ? '240px' : c.type === 'number' || c.type === 'autonumber' ? '120px' : c.type === 'duration' ? '110px' : c.type === 'stamp' ? '200px' : c.type === 'person' || c.type === 'link' ? '190px' : c.type === 'date' ? '170px' : c.type === 'checkbox' ? '110px' : isComputed(c) ? '150px' : c.type === 'geo' ? (c.config?.format === 'map' ? '240px' : '210px') : c.type === 'select' ? '160px' : '180px'),
        ...backlinks.map(() => '220px'),
        'minmax(120px, 1fr)',
      ].join(' ')
    : ''

  return (
    <ReprContext.Provider value={reprOf}>
    <section ref={sectionRef} className={`pane ${props.online === false ? 'offline' : ''}${props.asOf ? ' asof' : ''}`}>
      {/* Titel und Online-Schalter nur im Simulationsmodus (mehrere Clients) */}
      {props.onToggle && (
        <header>
          <h2>{props.title}</h2>
          <button onClick={props.onToggle} className={props.online ? 'on' : 'off'}>
            {props.online ? t('● online') : t('○ offline')}
          </button>
        </header>
      )}

      {/* Alles bis zur Tabelle scrollt gemeinsam; der Tabellenkopf bleibt oben stehen, die Leiste „+ Zeile“ unten. */}
      <div className="gridscroll">
      {(props.onHome || props.onAccount) && (
        <div className="topbar">
          {props.onHome ? <button type="button" className="home-btn" onClick={props.onHome} aria-label={t('Zurück zur Dokumentenliste')}>{t('‹ Dokumente')}</button> : <span />}
          <span className="topbar-right">
            <UndoButtons undo={history} />
            {props.onAccount && <AccountButton onClick={props.onAccount} />}
          </span>
        </div>
      )}
      <nav className="tabs">
        {shownTabs.map((tb) => {
          const current = tb.id === tab?.id
          return (
            <span key={tb.id} className={`tabgroup ${hintClass('table', tb.id)}${current && menuOpen ? ' menu-open' : ''}`}>
              <button className={current ? 'active' : ''} aria-haspopup={current ? 'menu' : undefined} aria-expanded={current ? menuOpen : undefined}
                onClick={() => { if (current && structure) setMenuOpen((o) => !o); else { setActive(tb.id); setMenuOpen(false) } }}
                title={structure ? (current ? t('Menü öffnen – Ziehen zum Umsortieren') : t('Ziehen zum Umsortieren')) : undefined}
                {...reorderProps('table', tb.id, tb.name)}>
                <SheetIcon icon={tb.icon} kind={tb.kind} />
                <span className="tab-name">{tb.name}</span>
                {current && structure && <span className="tab-caret">▾</span>}</button>
              {structure && current && menuOpen && (
                <div className="tab-popup" role="menu">
                  <button type="button" role="menuitem" autoFocus onClick={() => {
                    setMenuOpen(false)
                    if (tb.kind === 'table') setEditing({ kind: 'table', id: tb.id }); else if (tb.kind === 'map') setMapDialog({ mode: 'edit', id: tb.id }); else setViewDialog({ mode: 'edit', id: tb.id })
                  }}>{t('Bearbeiten …')}</button>
                  {tb.kind === 'table' && (
                    <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setViewDialog({ mode: 'new', sourceId: tb.id }) }}>{t('Abgeleitete Tabelle …')}</button>
                  )}
                  <button type="button" role="menuitem" className="danger-item" onClick={() => {
                    setMenuOpen(false)
                    if (tb.kind === 'table') setDeletingItem({ kind: 'table', id: tb.id }); else if (tb.kind === 'map') setDeletingMap(tb.id); else setDeletingView(tb.id)
                  }}>{t('Löschen …')}</button>
                </div>
              )}
            </span>
          )
        })}
        {structure && <span className={`tabgroup add-tab${addOpen ? ' menu-open' : ''}`}>
          <button aria-haspopup="menu" aria-expanded={addOpen} title={t('Tabelle oder Karte hinzufügen')} aria-label={t('Hinzufügen')}
            onClick={() => { setAddOpen((o) => !o); setMenuOpen(false) }}>+</button>
          {addOpen && (
            <div className="add-popup" role="menu">
              <button type="button" role="menuitem" autoFocus onClick={() => { setAddOpen(false); setDialog('table') }}>{t('Neue Tabelle …')}</button>
              <button type="button" role="menuitem" onClick={() => { setAddOpen(false); setMapDialog({ mode: 'new' }) }}>{t('Neue Karte …')}</button>
            </div>
          )}
        </span>}
      </nav>

      {!synced && <p className="hint">{t('Lade lokale Daten …')}</p>}
      {synced && !tab && <p className="hint">{rights.active && !rights.admin ? t('Noch keine Rechte: Ein Admin muss dir Zugriff auf Tabellen geben.') : t('Noch keine Tabelle. Lege eine an.')}</p>}
      {view && <ViewGrid key={view.id} doc={doc} view={view} tables={tables} writable={!props.asOf && rights.access(view.id) === 'write'} />}
      {mapTab && <MapView key={mapTab.id} doc={doc} map={mapTab} tables={tables} onOpenRecord={(tableId, rowId) => setMapRecord({ tableId, rowId })} />}

      {table && (
        <>
          <div className="gridwrap" ref={wrapRef}
            onKeyDown={(e) => {
              // Enter in einer Zelle springt in dieselbe Spalte der nächsten Zeile; nach der letzten Zeile entsteht eine neue
              const el = e.target as HTMLElement
              if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing || !(el instanceof HTMLInputElement)) return
              if (!el.classList.contains('cell') || (el.type !== 'text' && el.type !== 'number')) return
              const rowEl = el.closest<HTMLElement>('[data-row]'), cellEl = el.closest<HTMLElement>('.row-inner > *')
              if (!rowEl || !cellEl || !table) return
              e.preventDefault()
              const col = Array.from(cellEl.parentElement!.children).indexOf(cellEl)
              const next = visibleIds[visibleIds.indexOf(rowEl.dataset.row!) + 1]
              if (next) setFocusRow(next, col)
              else if (canAdd) { setSearches((s) => ({ ...s, [table.id]: '' })); setFocusRow(addRow(doc, table.id), col) }
            }}
            onFocus={() => { editingInGrid.current = true }}
            onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { editingInGrid.current = false; setSortTick((n) => n + 1) } }}>
            <div className="grid" style={{ ['--cols' as any]: template }}>
              <div className="grid-head">
                {shownColumns.map((c) => (
                  <div key={c.id} className={`h reorderable ${hintClass('column', c.id)}${isMobileUI && selectedCol === c.id ? ' col-selected' : ''}`} {...reorderProps('column', c.id, c.name)}>
                    <button type="button" className="h-name" title={structure ? t('Spalte konfigurieren') : undefined}
                      aria-expanded={isMobileUI ? selectedCol === c.id : undefined}
                      onClick={() => { if (!structure) return; if (isMobileUI) setSelectedCol((cur) => (cur === c.id ? null : c.id)); else setEditing({ kind: 'column', id: c.id }) }}>{c.name}</button>
                    {(!isMobileUI || selectedCol === c.id) && (
                      <button type="button" draggable={false} className={`h-sort${sort?.colId === c.id ? ' on' : ''}`}
                        title={sort?.colId === c.id ? (sort.dir === 'asc' ? t('Aufsteigend sortiert – klicken für absteigend') : t('Absteigend sortiert – klicken für die ursprüngliche Reihenfolge')) : t('Nach dieser Spalte sortieren')}
                        aria-label={t('Nach {name} sortieren', { name: c.name })}
                        onClick={() => cycleSort(c.id)}><SortIcon dir={sort?.colId === c.id ? sort.dir : null} /></button>
                    )}
                    {structure && <span className="col-resize" title={t('Ziehen: Breite ändern, Doppelklick: zurücksetzen')} draggable={false}
                      onMouseDown={(e) => startResize(e, c.id)}
                      onPointerDown={(e) => { if (e.pointerType !== 'mouse') startResize(e, c.id) }}
                      onDragStart={(e) => { e.preventDefault(); e.stopPropagation() }}
                      onDoubleClick={() => setColumnWidth(doc, table.id, c.id, undefined)} />}
                    {structure && isMobileUI && selectedCol === c.id && (
                      <div className="col-menu" role="menu">
                        <button type="button" role="menuitem" onClick={() => { setSelectedCol(null); setEditing({ kind: 'column', id: c.id }) }}>{t('Bearbeiten')}</button>
                      </div>
                    )}
                  </div>
                ))}
                {backlinks.map(({ source, col }) => (
                  <div key={col.id} className="h back-th">
                    ← {source.name}<small>{col.name}</small>
                  </div>
                ))}
                {structure ? <div className="h"><button className="add-col" onClick={() => setDialog('column')} title={t('Spalte hinzufügen')} aria-label={t('Spalte hinzufügen')}>+</button></div> : <div className="h" />}
              </div>
              {virt.virtual && <div ref={virt.anchorRef} style={{ height: virt.topPad }} aria-hidden />}
              <fieldset className="ro-fs" disabled={!writable && !canAdd}>
              {visibleIds.slice(virt.start, virt.end).map((rid) => (
                <div key={rid} className="row-outer" data-row={rid}>
                  <div className="row-inner">
                    {shownColumns.map((c, i) => {
                      const cell = ringOf(doc).locked(c.id)
                        ? <div key={c.id} className="c locked-cell" title={t('Vertraulich: Der Schlüssel fehlt noch. Ein Admin muss ihn senden.')}>🔒</div>
                        : isComputed(c) || c.type === 'autonumber' || c.type === 'stamp'
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
                        : <Cell key={c.id} doc={doc} table={table.id} rowId={rid} col={c} lead={i === 0} />
                      // Ohne Schreibrecht an der Spalte (bei sonst schreibbarer Tabelle) ist nur diese Zelle gesperrt
                      return writable || !canAdd || rights.colAccess(table.id, c.id) === 'write' ? cell : <fieldset key={c.id} className="ro-fs" disabled>{cell}</fieldset>
                    })}
                    {backlinks.map(({ source, col }) => (
                      <BacklinkCell key={col.id} doc={doc} tables={tables} source={source} rowId={rid} col={col} index={index} />
                    ))}
                    {writable ? <div className="c actions-c"><button className="del" title={t('Zeile löschen')} onClick={() => setDeleting(rid)}>✕</button></div> : <div className="c actions-c" />}
                  </div>
                </div>
              ))}
              </fieldset>
              {virt.virtual && <div style={{ height: virt.bottomPad }} aria-hidden />}
              <div className="grid-foot">
                <div className="row-inner">
                  {shownColumns.map((c) => (
                    <FooterCell key={c.id} locked={!structure} doc={doc} tableId={table.id} col={c} tables={tables} cells={cellData.get(c.id)} />
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
      {props.asOf && <AsOfTimeline info={props.asOf} />}
      {props.asOf && (
        <div className="addrow-bar asof-bar">
          {table && (
            <span className="rowsearch">
              <input ref={searchRef} type="search" placeholder={t('Suchen …')} aria-label={t('Tabelle durchsuchen')} value={searches[table.id] ?? ''}
                onChange={(e) => setSearches((s) => ({ ...s, [table.id]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Escape') { setSearches((s) => ({ ...s, [table.id]: '' })); e.currentTarget.blur() } }} />
              {matching && <small>{t('{shown} von {total}', { shown: visibleIds.length, total: table.rowIds.length })}</small>}
            </span>
          )}
          <AsOfPicker info={props.asOf} />
        </div>
      )}
      {!props.asOf && table && (
        <div className="addrow-bar">
          {canAdd && <button className="add-row" onClick={() => { setSearches((s) => ({ ...s, [table.id]: '' })); setFocusRow(addRow(doc, table.id)) }}>{t('+ Zeile')}</button>}
          <span className="rowsearch">
            <input ref={searchRef} type="search" placeholder={t('Suchen …')} aria-label={t('Tabelle durchsuchen')} value={searches[table.id] ?? ''}
              onChange={(e) => setSearches((s) => ({ ...s, [table.id]: e.target.value }))}
              onKeyDown={(e) => { if (e.key === 'Escape') { setSearches((s) => ({ ...s, [table.id]: '' })); e.currentTarget.blur() } }} />
            {matching && <small>{t('{shown} von {total}', { shown: visibleIds.length, total: table.rowIds.length })}</small>}
          </span>
          <TrackingChip doc={doc} />
          {props.sync && <SyncButton control={props.sync} onClick={() => setSyncOpen(true)} />}
        </div>
      )}
      {view && !props.asOf && (
        <div className="addrow-bar view-bar">
          <span>{t('Abgeleitete Tabelle aus „{name}“ – nur Lesen.', { name: tables.find((x) => x.id === view.def.source)?.name ?? '?' })}</span>
          <button type="button" onClick={() => setViewDialog({ mode: 'edit', id: view.id })}>{t('Bearbeiten …')}</button>
        </div>
      )}

      {syncOpen && props.sync && <SyncDialog control={{ ...props.sync, objects: tabs.map((x) => {
        const v = x.kind === 'view' ? views.find((y) => y.id === x.id) : undefined
        const columns = x.kind === 'table' ? tables.find((y) => y.id === x.id)?.columns.map((c) => ({ id: c.id, name: c.name, readOnly: isComputed(c) || c.type === 'autonumber' || c.type === 'stamp', encrypted: ringOf(doc).isProtected(c.id) })) : undefined
        const blockedWhy = v ? writeBlocker(v.def, tables.find((y) => y.id === v.def.source), tables, (c) => ringOf(doc).isProtected(c)) : null
        const src = v ? tables.find((y) => y.id === v.def.source) : undefined
        const filterNames = v && !blockedWhy && src ? [...new Set(v.def.filters.map((f) => src.columns.find((c) => c.id === f.col)?.name).filter(Boolean))] : []
        return { id: x.id, name: x.name, kind: x.kind, columns, note: filterNames.length ? t('Bedingungsspalten bleiben unverschlüsselt: {names}', { names: filterNames.join(', ') }) : undefined, blocked: v ? writeBlocker(v.def, tables.find((y) => y.id === v.def.source), tables, (c) => ringOf(doc).isProtected(c)) ?? undefined : undefined }
      }) }} onClose={() => setSyncOpen(false)} />}

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
          ? t('Spalte „{name}“ mit allen Werten, Verknüpfungen und Dateien dieser Spalte.', { name: col.name })
          : t('Tabelle „{name}“ mit {rows}. Verknüpfungen darauf werden entfernt.', { name: tbl!.name, rows: tn(tbl!.rowIds.length, '{n} Zeile', '{n} Zeilen') }) + (views.some((v) => v.def.source === tbl!.id) ? ' ' + t('Abgeleitete Tabellen daraus ({n}) werden ebenfalls gelöscht.', { n: views.filter((v) => v.def.source === tbl!.id).length }) : '')
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
          <ViewDialog doc={doc} source={source} tables={tables} initial={editing && { name: editing.name, def: editing.def, icon: editing.icon }}
            onClose={() => setViewDialog(null)}
            onSubmit={(name, def, icon) => {
              if (editing) updateView(doc, editing.id, { name, def, icon })
              else setActive(addView(doc, name, def, icon))
              setViewDialog(null)
            }} />
        )
      })()}
      {mapDialog && (() => {
        const editing = mapDialog.mode === 'edit' ? maps.find((m) => m.id === mapDialog.id) : undefined
        if (mapDialog.mode === 'edit' && !editing) return null
        return (
          <MapDialog tables={tables} initial={editing && { name: editing.name, layers: editing.layers, icon: editing.icon }}
            onClose={() => setMapDialog(null)}
            onDelete={editing && (() => { setDeletingMap(editing.id); setMapDialog(null) })}
            onSubmit={(name, layers, icon) => {
              if (editing) updateMap(doc, editing.id, { name, layers, icon })
              else setActive(addMap(doc, name, layers, icon))
              setMapDialog(null)
            }} />
        )
      })()}
      {deletingMap && (() => {
        const m = maps.find((x) => x.id === deletingMap)
        if (!m) return null
        return (
          <ConfirmDialog detail={t('Karte „{name}“ mit {objects}. Die Tabellen und ihre Daten bleiben unverändert.', { name: m.name, objects: tn(m.shapes.length, '{n} eigenem Objekt', '{n} eigenen Objekten') })}
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
          <ConfirmDialog detail={t('Abgeleitete Tabelle „{name}“. Die Quelltabelle und ihre Daten bleiben unverändert.', { name: v.name })}
            onCancel={() => setDeletingView(null)}
            onConfirm={() => { deleteView(doc, v.id); setActive(null); setDeletingView(null) }} />
        )
      })()}

      {deleting && table && (
        <ConfirmDialog detail={t('Zeile „{title}“', { title: summarize(doc, table, deleting).title })}
          onCancel={() => setDeleting(null)}
          onConfirm={() => { deleteRow(doc, table.id, deleting); setDeleting(null) }} />
      )}

      {dialog === 'table' && (
        <Dialog title={t('Neue Tabelle')} tables={tables} onClose={() => setDialog(null)}
          onSubmit={(f) => { setActive(addTable(doc, f.name)); setFocusFirst(true); setDialog(null) }} />
      )}
      {dialog === 'column' && table && (
        <Dialog title={t('Neue Spalte in „{name}“', { name: table.name })} withType tables={tables} table={table} defaultTarget={table.id}
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
            <option value="text">{t('Text')}</option>
            <option value="number">{t('Zahl')}</option>
            <option value="relation">{t('Relation (Verknüpfung)')}</option>
            <option value="file">{t('Datei / Bild')}</option>
            <option value="select">{t('Auswahl (z. B. Status)')}</option>
            <option value="date">{t('Datum')}</option>
            <option value="checkbox">{t('Checkbox')}</option>
            <option value="formula">{t('Formel (Berechnung aus anderen Spalten)')}</option>
            <option value="geo">{t('Geokoordinate')}</option>
            <option value="autonumber">{t('Aufsteigende Zahl (nicht bearbeitbar)')}</option>
            <option value="stamp">{t('Zeitstempel (erstellt / geändert, automatisch)')}</option>
            <option value="person">{t('Person (Mitglied des Dokuments)')}</option>
            <option value="link">{t('Link (Web, E-Mail, Telefon)')}</option>
            <option value="duration">{t('Dauer (Stunden:Minuten)')}</option>
            <option value="template">{t('Text mit Platzhaltern')} {'({{…}})'}</option>
            <option value="rollup" disabled={!props.table || relations.length === 0}>{t('Rollup (Summe u. a. über verknüpfte Zeilen)')}</option>
          </select>
        )}
        <input autoFocus placeholder={t('Name')} value={name} onChange={(e) => setName(e.target.value)} />
        {props.withType && type === 'relation' && (
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {props.tables.map((x) => <option key={x.id} value={x.id}>{t('auf Tabelle „{name}“', { name: x.name })}</option>)}
          </select>
        )}
        {props.withType && type === 'template' && (
          <>
            <textarea rows={3} spellCheck={false} className="formula-input" placeholder={t('z. B. {{Vorname}} {{Name}} – {{ {{Führer}} + {{Helfer}} }} Personen')}
              value={expr} onChange={(e) => setExpr(e.target.value)} />
            {exprError && <p className="formula-error" role="alert">{exprError}</p>}
          </>
        )}
        {props.withType && type === 'formula' && (
          <>
            <textarea rows={3} spellCheck={false} className="formula-input" placeholder={t('z. B. {{Führer}} + {{Unterführer}} + {{Helfer}}\noder SUMME({{Gruppen.Führer}})')}
              value={expr} onChange={(e) => setExpr(e.target.value)} />
            {exprError && <p className="formula-error" role="alert">{exprError}</p>}
          </>
        )}
        {props.withType && type === 'rollup' && (
          <>
            <select value={rel} onChange={(e) => { setRel(e.target.value); setRcol('') }}>
              {relations.map((c) => <option key={c.id} value={c.id}>{t('über Relation „{name}“', { name: c.name })}</option>)}
            </select>
            <select value={rcol} onChange={(e) => {
              const id = e.target.value
              setRcol(id)
              const ci = rollupTarget?.columns.find((c) => c.id === id)
              if (ci) setFn(defaultAgg(effectiveType(ci, props.tables)))
            }}>
              <option value="">{t('Spalte der verknüpften Zeilen …')}</option>
              {(rollupTarget?.columns ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select value={fn} disabled={!rcolInfo} onChange={(e) => setFn(e.target.value as AggFn)}>
              {rfns.map((f) => <option key={f} value={f}>{aggLabel(rcolInfo!.type, f)}</option>)}
            </select>
          </>
        )}
        {props.withType && type === 'select' && (
          <textarea rows={4} placeholder={t('Optionen, eine pro Zeile\nz. B. Entwurf\nIn Arbeit')} value={optionsText}
            onChange={(e) => setOptionsText(e.target.value)} />
        )}
        <div className="actions">
          <button type="button" onClick={props.onClose}>{t('Abbrechen')}</button>
          <button type="submit" className="primary" disabled={!name.trim() || (type === 'rollup' && !rollupReady) || ((type === 'formula' || type === 'template') && (!expr.trim() || !!exprError))}>{t('Anlegen')}</button>
        </div>
      </form>
    </Modal>
  )
}
