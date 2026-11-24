import { useEffect, useMemo, useState } from 'react'
import type * as Y from 'yjs'
import { Modal } from './Modal'
import { auditOf, coalesce, kindLabel, type AuditEntry } from './audit'
import { personName } from './model'
import { t, tn, locale } from './i18n'

const PAGE = 300
const when = (ms: number) => new Date(ms).toLocaleString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })

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
  const who = (a: string) => (a ? personName(props.doc, a) || a.slice(0, 8) : t('Unbekannt'))
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const all = coalesce(entries).reverse()
    if (!needle) return all
    return all.filter((e) => [who(e.a), kindLabel(e.k), e.tb, e.r, e.ri, e.c, e.o, e.n].join(' ').toLowerCase().includes(needle))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, q])
  return (
    <Modal onClose={props.onClose}>
      <div className="dialog log-dialog" role="dialog" aria-label={t('Änderungsprotokoll')} onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>{t('Änderungsprotokoll')}</h3>
        <p className="log-hint">{t('Aufgezeichnet werden Änderungen ab Einführung des Protokolls. Wie lange sie bleiben, steht unter „Logs → Aufbewahrung“.')}</p>
        <input type="search" className="log-search" placeholder={t('Suchen …')} aria-label={t('Protokoll durchsuchen')} value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE) }} />
        <div className="log-scroll">
          {rows.length === 0 ? <p className="log-empty">{entries.length ? t('Nichts gefunden.') : t('Noch keine Einträge.')}</p> : (
            <table className="log-table">
              <thead><tr><th>{t('Zeit')}</th><th>{t('Wer')}</th><th>{t('Was')}</th><th>{t('Tabelle')}</th><th>{t('Zeile')}</th><th>{t('Spalte')}</th><th>{t('Vorher')}</th><th>{t('Nachher')}</th></tr></thead>
              <tbody>
                {rows.slice(0, shown).map((e, i) => (
                  <tr key={i}>
                    <td className="nowrap">{when(e.t)}</td>
                    <td>{who(e.a)}</td>
                    <td>{kindLabel(e.k)}{e.k === 'bulk' ? ` (${e.x})` : ''}</td>
                    <td>{e.tb}</td><td>{e.r}{e.ri && <small className="log-id" title={t('Kennung der Zeile: {id}', { id: e.ri })}> {e.ri.slice(0, 6)}</small>}</td><td>{e.c}</td><td className="log-val">{e.o}</td><td className="log-val">{e.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="actions">
          <small className="log-count">{tn(rows.length, '{n} Eintrag', '{n} Einträge')}</small>
          {rows.length > shown && <button type="button" onClick={() => setShown((n) => n + PAGE)}>{t('Mehr anzeigen')}</button>}
          <button type="button" autoFocus onClick={props.onClose}>{t('Fertig')}</button>
        </div>
      </div>
    </Modal>
  )
}
