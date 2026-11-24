import { useState } from 'react'
import { Modal } from './Modal'
import { readTheme, setTheme, type ThemeChoice } from './theme'
import { languageOptions, isLanguageChoice, setLanguage, t, useLanguageChoice } from './i18n'

const choices = (): [ThemeChoice, string][] => [['system', t('Systemstandard')], ['light', t('Hell')], ['dark', t('Dunkel')]]

/** Programmeinstellungen: Sprache und Erscheinungsbild. */
export function SettingsDialog(props: { onClose: () => void }) {
  const [theme, setThemeState] = useState<ThemeChoice>(readTheme())
  const lang = useLanguageChoice()
  return (
    <Modal onClose={props.onClose}>
      <div className="dialog" role="dialog" aria-label={t('Einstellungen')} onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>{t('Einstellungen')}</h3>
        <label className="cfg-field">
          {t('Sprache')}
          <select value={lang} onChange={(e) => { if (isLanguageChoice(e.target.value)) setLanguage(e.target.value) }}>
            {languageOptions().map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
        </label>
        <label className="cfg-field">
          {t('Erscheinungsbild')}
          <select value={theme} onChange={(e) => { const v = e.target.value as ThemeChoice; setTheme(v); setThemeState(v) }}>
            {choices().map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        </label>
        <div className="actions"><button type="button" autoFocus onClick={props.onClose}>{t('Fertig')}</button></div>
      </div>
    </Modal>
  )
}
