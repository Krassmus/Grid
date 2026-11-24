import { useState } from 'react'
import type * as Y from 'yjs'
import { Modal } from './Modal'
import { auditSettings, DEFAULT_DAYS, DEFAULT_MAX, setAuditSettings } from './audit'
import { t } from './i18n'

/** Wie lange das Änderungsprotokoll dieses Dokuments aufbewahrt wird (gilt für alle, die das Dokument nutzen). */
export function RetentionDialog(props: { doc: Y.Doc; onClose: () => void }) {
  const cur = auditSettings(props.doc)
  const [keepDays, setKeepDays] = useState(cur.days > 0), [days, setDays] = useState(cur.days || DEFAULT_DAYS)
  const [keepMax, setKeepMax] = useState(cur.max > 0), [max, setMax] = useState(cur.max || DEFAULT_MAX)
  const save = () => { setAuditSettings(props.doc, { days: keepDays ? Math.max(1, days) : 0, max: keepMax ? Math.max(1, max) : 0 }); props.onClose() }
  return (
    <Modal onClose={props.onClose}>
      <form className="dialog" role="dialog" aria-label={t('Aufbewahrung des Protokolls')} onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); save() }} onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>{t('Aufbewahrung des Protokolls')}</h3>
        <p className="log-hint">{t('Ältere Einträge werden gelöscht, und damit lässt sich der Stand davor nicht mehr anzeigen. Für Dokumente, in denen das Protokoll zur Dokumentation dient, beides auf „unbegrenzt“ stellen (das Dokument wird dann mit der Zeit größer).')}</p>
        <label className="cfg-field">{t('Einträge nach Alter')}
          <span className="log-limit">
            <label><input type="checkbox" checked={!keepDays} onChange={(e) => setKeepDays(!e.target.checked)} /> {t('unbegrenzt')}</label>
            {keepDays && <><input type="number" min={1} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label={t('Tage')} /> {t('Tage')}</>}
          </span>
        </label>
        <label className="cfg-field">{t('Höchstzahl der Einträge')}
          <span className="log-limit">
            <label><input type="checkbox" checked={!keepMax} onChange={(e) => setKeepMax(!e.target.checked)} /> {t('unbegrenzt')}</label>
            {keepMax && <><input type="number" min={1} value={max} onChange={(e) => setMax(Number(e.target.value))} aria-label={t('Einträge')} /> {t('Einträge')}</>}
          </span>
        </label>
        <div className="actions">
          <button type="button" onClick={props.onClose}>{t('Abbrechen')}</button>
          <button type="submit" className="primary">{t('Speichern')}</button>
        </div>
      </form>
    </Modal>
  )
}
