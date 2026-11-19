import { useEffect, useState } from 'react'
import * as Y from 'yjs'
import { setColumnFooter, type ColumnInfo, type TableInfo } from './model'
import { allowedFooters, footerLabel, type FooterFn } from './aggregate'
import { footerText, type Cell } from './cells'
import { effectiveType } from './columnTypes'

/** Eine Zelle der Summenzeile: zeigt die gewählte Auswertung der Spalte, ein Klick öffnet die Auswahl. */
export function FooterCell(props: { doc: Y.Doc; tableId: string; col: ColumnInfo; tables: TableInfo[]; cells: Map<string, Cell> | undefined }) {
  const { doc, tableId, col, tables } = props
  const type = effectiveType(col, tables)
  const options = allowedFooters(type)
  const fn = options.includes(col.footer as FooterFn) ? (col.footer as FooterFn) : undefined
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { if (!(e.target as Element).closest('.foot-cell.open')) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [open])
  const value = fn && props.cells ? footerText([...props.cells.values()], col, fn) : ''
  const choose = (f: FooterFn | undefined) => { setColumnFooter(doc, tableId, col.id, f); setOpen(false) }
  return (
    <div className={`c foot-cell${open ? ' open' : ''}${type === 'number' ? ' num' : ''}`}>
      <button type="button" className={`foot-btn${fn ? ' set' : ''}`} aria-haspopup="menu" aria-expanded={open}
        title={fn ? `${footerLabel(type, fn)} – klicken zum Ändern` : 'Auswertung unter der Spalte wählen'}
        onClick={() => setOpen((o) => !o)}>
        {fn ? <><strong>{value || '–'}</strong>{(fn !== 'sum' || type === 'checkbox') && <small>{footerLabel(type, fn)}</small>}</> : <span className="foot-hint">Berechnen</span>}
      </button>
      {open && (
        <div className="foot-popup" role="menu">
          <button type="button" role="menuitem" className={!fn ? 'on' : ''} onClick={() => choose(undefined)}>Keine</button>
          {options.map((f) => (
            <button key={f} type="button" role="menuitem" className={f === fn ? 'on' : ''} onClick={() => choose(f)}>{footerLabel(type, f)}</button>
          ))}
        </div>
      )}
    </div>
  )
}
