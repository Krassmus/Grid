import { useEffect, useMemo, useState, type FocusEvent, type MouseEvent, type ReactNode } from 'react'
import * as Y from 'yjs'
import { tablesOf, type CellValue, type TableInfo, type ViewInfo } from './model'
import { orderByKeys, type SortDir } from './sorting'
import { computeView, type ViewRow } from './viewEngine'
import { allowedOptions, isValueColumn, presetValues, rowMatches, viewEditable, writeBlocker } from './viewWrite'
import { RecordForm, commitRecord, formColumns, updateRecord } from './RecordForm'
import { ConfirmDialog } from './Modal'
import { deleteRow } from './model'
import { t } from './i18n'
import { plainOf, ringOf } from './colCrypt'
import { useVirtualRows } from './virtualRows'

const widthOf = (type: string, w?: number) =>
  w ? `${w}px` : type === 'relation' || type === 'file' ? '240px' : type === 'number' || type === 'duration' ? '120px' : type === 'stamp' ? '200px' : type === 'person' || type === 'link' ? '190px' : type === 'date' ? '170px' : type === 'checkbox' ? '110px' : type === 'select' ? '160px' : '180px'

/**
 * Darstellung einer abgeleiteten Tabelle; Zellen sehen aus wie in der Tabelle und sind dort, wo man schreiben darf, direkt bearbeitbar
 * (`renderCell`); gruppierte Sichten zeigen Text.
 * Sortieren ist möglich (nur Ansicht, wie bei normalen Tabellen).
 * Mit Schreibrecht (und wenn die Sicht dafür taugt, viewWrite.ts) lassen sich Zeilen über ein Formular anlegen, ändern und löschen,
 * das nur Werte annimmt, die den Bedingungen der Sicht genügen.
 */
export function ViewGrid({ doc, view, source, allTables = [], writable = false, renderCell }: { doc: Y.Doc; view: ViewInfo; writable?: boolean
  /** Quelltabelle und alle Tabellen, auch solche, die der Betrachter nicht selbst sehen darf: Wer nur an der Sicht schreibt, braucht sie */
  source?: TableInfo; allTables?: TableInfo[]
  /** Die Zelle wie in der Tabelle (bearbeitbar in einem Element `.vedit`); `null`: als Text zeigen */
  renderCell?: (colId: string, rowId: string, index: number) => ReactNode }) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const h = () => setTick((n) => n + 1)
    doc.on('update', h)
    return () => { doc.off('update', h) }
  }, [doc])
  const result = useMemo(() => computeView(doc, view.def), [doc, view.def, tick])
  const [sort, setSort] = useState<{ colId: string; dir: SortDir } | null>(null)
  const [form, setForm] = useState<{ row: string | null } | null>(null) // null = geschlossen, row null = neue Zeile
  const [deleting, setDeleting] = useState<string | null>(null)
  const canWrite = writable && !!source && !writeBlocker(view.def, source, allTables, (c) => ringOf(doc).isProtected(c))
  const active = sort && result.columns.some((c) => c.id === sort.colId) ? sort : null
  const rows = useMemo(() => {
    if (!active) return result.rows
    const keys = new Map(result.rows.map((r) => [r.id, r.cells[active.colId]?.key ?? null]))
    const order = orderByKeys(result.rows.map((r) => r.id), keys, active.dir)
    const byId = new Map(result.rows.map((r) => [r.id, r]))
    return order.map((id) => byId.get(id)!)
  }, [result, active])
  // Während getippt wird, bleiben Zeilen und Reihenfolge stehen: Sonst verschwände oder verrutschte die Zeile unter den Fingern
  const [held, setHeld] = useState<ViewRow[] | null>(null)
  const shown = useMemo(() => {
    if (!held) return rows
    const now = new Map(result.rows.map((r) => [r.id, r])), was = new Set(held.map((r) => r.id))
    const present: Y.Map<unknown> | undefined = tablesOf(doc).get(view.def.source)?.get('rows')
    return [...held.filter((r) => present?.has(r.id)).map((r) => now.get(r.id) ?? r), ...rows.filter((r) => !was.has(r.id))]
  }, [held, rows, result, doc, view.def.source])
  const cycle = (colId: string) =>
    (setHeld(null), setSort((cur) => (!cur || cur.colId !== colId ? { colId, dir: 'asc' } : cur.dir === 'asc' ? { colId, dir: 'desc' } : null)))

  const rowIds = useMemo(() => shown.map((r) => r.id), [shown])
  const virt = useVirtualRows(rowIds)
  const grouped = view.def.group.mode !== 'none'

  /** Klick auf die Zeile öffnet das Formular – außer er gilt etwas in der Zelle (Bild, Kachel, Link) oder kommt aus einem Dialog daraus. */
  const openForm = (e: MouseEvent<HTMLDivElement>, row: string) => {
    const el = e.target as Element
    if (!e.currentTarget.contains(el) || el.closest('.vedit, .filechip, .tile.clickable, a, .link-open')) return
    setForm({ row })
  }

  const typing = (el: EventTarget | null) => el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !['checkbox', 'radio', 'file'].includes(el.type))
  const hold = (e: FocusEvent<HTMLDivElement>) => { if (typing(e.target) && e.currentTarget.contains(e.target) && e.target.closest('.vedit')) setHeld((h) => h ?? shown) }
  const release = (e: FocusEvent<HTMLDivElement>) => { if (!(typing(e.relatedTarget) && e.currentTarget.contains(e.relatedTarget))) setHeld(null) }

  if (result.missing) return <p className="hint">{t('Die Quelltabelle dieser abgeleiteten Tabelle existiert nicht mehr.')}</p>
  const template = [...result.columns.map((c) => widthOf(c.type, c.width)), ...(canWrite ? ['36px'] : [])].join(' ')
  return (
    <div className="gridwrap viewgrid" onFocus={hold} onBlur={release}>
      <div className="grid" style={{ ['--cols' as any]: template }}>
        <div className="grid-head">
          {result.columns.map((c) => (
            <div key={c.id} className="h">
              <span className="h-name static" title={c.name}>{c.name}</span>
              <button type="button" className={`h-sort${active?.colId === c.id ? ' on' : ''}`} aria-label={t('Nach {name} sortieren', { name: c.name })}
                title={active?.colId === c.id ? (active.dir === 'asc' ? t('Aufsteigend sortiert – klicken für absteigend') : t('Absteigend sortiert – klicken für die ursprüngliche Reihenfolge')) : t('Nach dieser Spalte sortieren')}
                onClick={() => cycle(c.id)}>{active?.colId === c.id ? (active.dir === 'asc' ? '↑' : '↓') : '↕'}</button>
            </div>
          ))}
          {canWrite && <div className="h" />}
        </div>
        {virt.virtual && <div ref={virt.anchorRef} style={{ height: virt.topPad }} aria-hidden />}
        {shown.slice(virt.start, virt.end).map((r) => (
          <div key={r.id} className="row-outer" data-row={r.id}>
            <div className="row-inner" style={canWrite ? { cursor: 'pointer' } : undefined} onClick={canWrite ? (e) => openForm(e, r.id) : undefined}>
              {result.columns.map((c, i) => (!grouped && renderCell?.(c.id, r.id, i)) || (
                <div key={c.id} className={`c vcell ${c.type === 'number' ? 'num' : ''}`}>
                  <span title={r.cells[c.id]?.text}>{r.cells[c.id]?.text}</span>
                </div>
              ))}
              {canWrite && <div className="c actions-c"><button className="del" title={t('Zeile löschen')} onClick={(e) => { e.stopPropagation(); setDeleting(r.id) }}>✕</button></div>}
            </div>
          </div>
        ))}
        {virt.virtual && <div style={{ height: virt.bottomPad }} aria-hidden />}
        {shown.length === 0 && <p className="hint view-empty">{t('Keine Zeilen entsprechen den Bedingungen.')}</p>}
      </div>
      {canWrite && <button className="add-row" onClick={() => setForm({ row: null })}>{t('+ Zeile')}</button>}
      {canWrite && form && source && (
        <ViewRecordDialog doc={doc} view={view} source={source} tables={allTables} rowId={form.row} onClose={() => setForm(null)} />
      )}
      {canWrite && deleting && source && (
        <ConfirmDialog onCancel={() => setDeleting(null)} onConfirm={() => { deleteRow(doc, source.id, deleting); setDeleting(null) }} />
      )}
    </div>
  )
}

/** Formular zum Anlegen oder Ändern einer Zeile über die Sicht: nur Wertspalten, die die Sicht zeigt, und nur Werte, die ihren Bedingungen genügen. */
function ViewRecordDialog(props: { doc: Y.Doc; view: ViewInfo; source: TableInfo; tables: TableInfo[]; rowId: string | null; onClose: () => void }) {
  const { doc, view, source, tables, rowId } = props
  const def = view.def
  const [snap] = useState(() => {
    const row: Y.Map<any> | undefined = rowId ? tablesOf(doc).get(source.id)?.get('rows').get(rowId) : undefined
    if (!rowId) return presetValues(def, source, tables) as Record<string, CellValue>
    const values: Record<string, CellValue> = {}
    for (const c of formColumns(source)) if (isValueColumn(c)) values[c.id] = (plainOf(doc, c.id, row?.get(c.id)) as CellValue | undefined) ?? null
    return values
  })
  const validate = (values: Record<string, CellValue>) => {
    const all: Record<string, unknown> = { ...snap, ...values }
    return rowMatches(def, source, tables, (id) => all[id] ?? null) ? null : t('Die Zeile würde den Bedingungen der abgeleiteten Tabelle nicht genügen.')
  }
  return (
    <RecordForm doc={doc} table={source} title={rowId ? t('Datensatz bearbeiten') : t('Neuer Datensatz in „{name}“', { name: view.name })}
      submitLabel={rowId ? t('Speichern') : undefined} initial={snap}
      only={(c) => viewEditable(c)}
      limitOptions={(c) => allowedOptions(def, source, tables, c)}
      validate={validate}
      onClose={props.onClose}
      onSubmit={async (values, extras) => {
        if (rowId) await updateRecord(doc, source.id, rowId, values, snap, { ...extras, files: {}, relations: {} }, {})
        else await commitRecord(doc, source.id, values, { ...extras, files: {}, relations: {} })
        props.onClose()
      }} />
  )
}
