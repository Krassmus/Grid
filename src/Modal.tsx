import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { t } from './i18n'

/** Rendert direkt in <body>, damit clip-path/transform der Zeilen den Dialog nicht beschneiden. */
export function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return createPortal(<div className="backdrop" onMouseDown={onClose}>{children}</div>, document.body)
}

/** Einfache Rückfrage vor dem Löschen. Fokus liegt bewusst auf „Abbrechen“. */
export function ConfirmDialog(props: { detail?: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Modal onClose={props.onCancel}>
      <div className="dialog confirm" role="alertdialog" aria-label={t('Wirklich löschen?')}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && props.onCancel()}>
        <h3>{t('Wirklich löschen?')}</h3>
        {props.detail && <p className="confirm-detail">{props.detail}</p>}
        <div className="actions">
          <button type="button" autoFocus onClick={props.onCancel}>{t('Abbrechen')}</button>
          <button type="button" className="danger" onClick={props.onConfirm}>{t('Löschen')}</button>
        </div>
      </div>
    </Modal>
  )
}

/** Umbenennen mit Löschen-Schaltfläche (für Tabellen und Spalten). */
export function RenameDialog(props: {
  title: string
  name: string
  onSave: (name: string) => void
  onDelete: () => void
  onClose: () => void
}) {
  const [name, setName] = useState(props.name)
  const save = () => { const n = name.trim(); if (n) { if (n !== props.name) props.onSave(n); props.onClose() } }
  return (
    <Modal onClose={props.onClose}>
      <form className="dialog" onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); save() }}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>{props.title}</h3>
        <input autoFocus value={name} onFocus={(e) => e.target.select()} onChange={(e) => setName(e.target.value)} />
        <div className="actions split">
          <button type="button" className="danger-outline" onClick={props.onDelete}>{t('Löschen …')}</button>
          <span className="actions-right">
            <button type="button" onClick={props.onClose}>{t('Abbrechen')}</button>
            <button type="submit" className="primary" disabled={!name.trim()}>{t('Speichern')}</button>
          </span>
        </div>
      </form>
    </Modal>
  )
}
