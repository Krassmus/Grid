import { useState } from 'react'
import { Modal } from './Modal'
import { readTheme, setTheme, type ThemeChoice } from './theme'

const CHOICES: [ThemeChoice, string][] = [['system', 'Systemstandard'], ['light', 'Hell'], ['dark', 'Dunkel']]

/** Programmeinstellungen (derzeit: Erscheinungsbild). */
export function SettingsDialog(props: { onClose: () => void }) {
  const [theme, setThemeState] = useState<ThemeChoice>(readTheme())
  return (
    <Modal onClose={props.onClose}>
      <div className="dialog" role="dialog" aria-label="Einstellungen" onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>Einstellungen</h3>
        <label className="cfg-field">
          Erscheinungsbild
          <select value={theme} onChange={(e) => { const v = e.target.value as ThemeChoice; setTheme(v); setThemeState(v) }}>
            {CHOICES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        </label>
        <div className="actions"><button type="button" autoFocus onClick={props.onClose}>Fertig</button></div>
      </div>
    </Modal>
  )
}
