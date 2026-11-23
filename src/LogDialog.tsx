import { useEffect, useMemo, useState } from 'react'
import type * as Y from 'yjs'
import { Modal } from './Modal'
import { auditOf, coalesce, KIND_LABEL, type AuditEntry } from './audit'
import { personName } from './model'

const PAGE = 300
const when = (t: number) => new Date(t).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** Alle protokollierten Änderungen des Dokuments, neueste zuerst. */
export function LogDialog(props: { doc: Y.Doc; onClose: () => void }) {
  const [entries, setEntries] = useState<AuditEntry[]>(() => auditOf(props.doc).toArray())
  const [q, setQ] = useState('')
  const [shown, setShown] = useState(PAGE)
  useEffect(() => {
    const log = auditOf(props.doc)
    const h = () => setEntries(log.toArray())
    log.observe(h)
    return () => log.unobserve(h)
  }, [props.doc])
  const who = (a: string) => (a ? personName(props.doc, a) || a.slice(0, 8) : 'Unbekannt')
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const all = coalesce(entries).reverse()
    if (!needle) return all
    return all.filter((e) => [who(e.a), KIND_LABEL[e.k], e.tb, e.r, e.ri, e.c, e.o, e.n].join(' ').toLowerCase().includes(needle))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, q])
  return (
    <Modal onClose={props.onClose}>
      <div className="dialog log-dialog" role="dialog" aria-label="Änderungsprotokoll" onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>Änderungsprotokoll</h3>
        <p className="log-hint">Aufgezeichnet werden Änderungen ab Einführung des Protokolls; es behält die letzten 90 Tage (höchstens 20.000 Einträge).</p>
        <input type="search" className="log-search" placeholder="Suchen …" aria-label="Protokoll durchsuchen" value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE) }} />
        <div className="log-scroll">
          {rows.length === 0 ? <p className="log-empty">{entries.length ? 'Nichts gefunden.' : 'Noch keine Einträge.'}</p> : (
            <table className="log-table">
              <thead><tr><th>Zeit</th><th>Wer</th><th>Was</th><th>Tabelle</th><th>Zeile</th><th>Spalte</th><th>Vorher</th><th>Nachher</th></tr></thead>
              <tbody>
                {rows.slice(0, shown).map((e, i) => (
                  <tr key={i}>
                    <td className="nowrap">{when(e.t)}</td>
                    <td>{who(e.a)}</td>
                    <td>{KIND_LABEL[e.k]}{e.k === 'bulk' ? ` (${e.x})` : ''}</td>
                    <td>{e.tb}</td><td>{e.r}{e.ri && <small className="log-id" title={`Kennung der Zeile: ${e.ri}`}> {e.ri.slice(0, 6)}</small>}</td><td>{e.c}</td><td className="log-val">{e.o}</td><td className="log-val">{e.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="actions">
          <small className="log-count">{rows.length} Einträge</small>
          {rows.length > shown && <button type="button" onClick={() => setShown((n) => n + PAGE)}>Mehr anzeigen</button>}
          <button type="button" autoFocus onClick={props.onClose}>Fertig</button>
        </div>
      </div>
    </Modal>
  )
}
