import { useEffect, useMemo, useState } from 'react'
import * as Y from 'yjs'
import type { ViewInfo } from './model'
import { orderByKeys, type SortDir } from './sorting'
import { computeView } from './viewEngine'

const widthOf = (type: string, w?: number) =>
  w ? `${w}px` : type === 'relation' || type === 'file' ? '240px' : type === 'number' ? '120px' : type === 'date' ? '170px' : type === 'checkbox' ? '110px' : type === 'select' ? '160px' : '180px'

/** Schreibgeschützte Darstellung einer abgeleiteten Tabelle; Sortieren ist möglich (nur Ansicht, wie bei normalen Tabellen). */
export function ViewGrid({ doc, view }: { doc: Y.Doc; view: ViewInfo }) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const h = () => setTick((n) => n + 1)
    doc.on('update', h)
    return () => { doc.off('update', h) }
  }, [doc])
  const result = useMemo(() => computeView(doc, view.def), [doc, view.def, tick])
  const [sort, setSort] = useState<{ colId: string; dir: SortDir } | null>(null)
  const active = sort && result.columns.some((c) => c.id === sort.colId) ? sort : null
  const rows = useMemo(() => {
    if (!active) return result.rows
    const keys = new Map(result.rows.map((r) => [r.id, r.cells[active.colId]?.key ?? null]))
    const order = orderByKeys(result.rows.map((r) => r.id), keys, active.dir)
    const byId = new Map(result.rows.map((r) => [r.id, r]))
    return order.map((id) => byId.get(id)!)
  }, [result, active])
  const cycle = (colId: string) =>
    setSort((cur) => (!cur || cur.colId !== colId ? { colId, dir: 'asc' } : cur.dir === 'asc' ? { colId, dir: 'desc' } : null))

  if (result.missing) return <p className="hint">Die Quelltabelle dieser abgeleiteten Tabelle existiert nicht mehr.</p>
  const template = result.columns.map((c) => widthOf(c.type, c.width)).join(' ')
  return (
    <div className="gridwrap viewgrid">
      <div className="grid" style={{ ['--cols' as any]: template }}>
        <div className="grid-head">
          {result.columns.map((c) => (
            <div key={c.id} className="h">
              <span className="h-name static" title={c.name}>{c.name}</span>
              <button type="button" className={`h-sort${active?.colId === c.id ? ' on' : ''}`} aria-label={`Nach ${c.name} sortieren`}
                title={active?.colId === c.id ? (active.dir === 'asc' ? 'Aufsteigend sortiert – klicken für absteigend' : 'Absteigend sortiert – klicken für die ursprüngliche Reihenfolge') : 'Nach dieser Spalte sortieren'}
                onClick={() => cycle(c.id)}>{active?.colId === c.id ? (active.dir === 'asc' ? '↑' : '↓') : '↕'}</button>
            </div>
          ))}
        </div>
        {rows.map((r) => (
          <div key={r.id} className="row-outer">
            <div className="row-inner">
              {result.columns.map((c) => (
                <div key={c.id} className={`c vcell ${c.type === 'number' ? 'num' : ''}`}>
                  <span title={r.cells[c.id]?.text}>{r.cells[c.id]?.text}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
        {rows.length === 0 && <p className="hint view-empty">Keine Zeilen entsprechen den Bedingungen.</p>}
      </div>
    </div>
  )
}
