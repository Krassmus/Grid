import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './gridFile'
import { ConfirmDialog } from './Modal'
import { ago, uniqueName } from './documents'
import { AccountButton } from './ProfileDialog'
import { isThemeChoice, readTheme, setTheme, type ThemeChoice } from './theme'
import { readZoom, setZoom, zoomLabel, ZOOM_STEPS } from './zoom'
import { t, language, useLanguageChoice, languageOptions, isLanguageChoice, setLanguage } from './i18n'

export interface DocFile { name: string; path: string; modified: number; size: number }

const fmtSize = (n: number) => (n < 1024 ** 2 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 ** 2).toFixed(1).replace('.', language() === 'de' ? ',' : '.')} MB`)

/** Dokumentenliste: Startbildschirm auf iPad und iPhone (dort gibt es keine Menüleiste). */
export function DocumentList(props: {
  /** Ändert sich, wenn die Liste neu geladen werden soll (z. B. nach dem Schließen eines Dokuments) */
  version: number
  onOpen: (path: string) => void
  onCreate: (name: string) => void
  onCloud: () => void
  onJoin: () => void
  /** Konto-Dialog öffnen (Name, Avatar, E-Mail) */
  onAccount?: () => void
  error?: string | null
}) {
  const lang = useLanguageChoice()
  const [files, setFiles] = useState<DocFile[] | null>(null)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [deleting, setDeleting] = useState<DocFile | null>(null)
  const [theme, setThemeState] = useState<ThemeChoice>(readTheme())
  const [zoom, setZoomState] = useState(readZoom)
  const [problem, setProblem] = useState<string | null>(null)

  const load = useCallback(async () => {
    try { setFiles(isTauri ? await invoke<DocFile[]>('list_documents') : []) } catch (e) { setProblem(String(e)); setFiles([]) }
  }, [])
  useEffect(() => { void load() }, [load, props.version])

  const create = () => {
    props.onCreate(uniqueName(name.trim() || t('Neues Dokument'), (files ?? []).map((f) => f.name)))
    setNaming(false)
    setName('')
  }
  const remove = async (f: DocFile) => {
    setDeleting(null)
    try { await invoke('delete_document', { path: f.path }) } catch (e) { setProblem(t('Löschen fehlgeschlagen: {e}', { e: String(e) })) }
    void load()
  }

  return (
    <div className="doclist">
      <header>
        <div className="doclist-title"><h1>{t('Dokumente')}</h1>{props.onAccount && <AccountButton onClick={props.onAccount} />}</div>
        <div className="doclist-actions">
          <button type="button" className="primary" onClick={() => setNaming(true)}>{t('+ Neues Dokument')}</button>
          <button type="button" onClick={props.onCloud}>{t('Aus Cloud …')}</button>
          <button type="button" onClick={props.onJoin}>{t('Einladung …')}</button>
        </div>
      </header>

      {naming && (
        <form className="doclist-new" onSubmit={(e) => { e.preventDefault(); create() }}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Name des Dokuments')} maxLength={80}
            autoCapitalize="sentences" aria-label={t('Name des Dokuments')} />
          <button type="button" onClick={() => { setNaming(false); setName('') }}>{t('Abbrechen')}</button>
          <button type="submit" className="primary">{t('Anlegen')}</button>
        </form>
      )}

      {(props.error || problem) && <p className="sync-error" role="alert">{props.error ?? problem}</p>}

      {files === null ? <p className="hint">{t('Wird geladen …')}</p>
        : files.length === 0
          ? <div className="doclist-empty">
              <p><strong>{t('Noch keine Dokumente.')}</strong></p>
              <p className="hint">{t('Lege ein neues Dokument an, hole eines aus der Cloud oder nimm eine Einladung an. Dokumente aus der Dateien-App kannst du mit „Öffnen mit → Grid“ übernehmen.')}</p>
            </div>
          : <ul className="doclist-items">
              {files.map((f) => (
                <li key={f.path}>
                  <button type="button" className="doclist-open" onClick={() => props.onOpen(f.path)}>
                    <strong>{f.name}</strong>
                    <small>{ago(f.modified)} · {fmtSize(f.size)}</small>
                  </button>
                  <button type="button" className="doclist-del" aria-label={t('„{name}“ löschen', { name: f.name })} onClick={() => setDeleting(f)}>{t('Löschen')}</button>
                </li>
              ))}
            </ul>}

      <footer>
        <span>{t('Erscheinungsbild')}</span>
        <div className="seg" role="group" aria-label={t('Erscheinungsbild')}>
          {([['system', t('System')], ['light', t('Hell')], ['dark', t('Dunkel')]] as [string, string][]).map(([v, label]) => (
            <button key={v} type="button" className={theme === v ? 'on' : ''} aria-pressed={theme === v}
              onClick={() => { if (isThemeChoice(v)) { setTheme(v); setThemeState(v) } }}>{label}</button>
          ))}
        </div>
        <label>
          {t('Größe')}
          <select value={zoom} aria-label={t('Größe der Oberfläche')} onChange={(e) => { const v = Number(e.target.value); setZoom(v); setZoomState(v) }}>
            {ZOOM_STEPS.map((v) => <option key={v} value={v}>{zoomLabel(v)}</option>)}
          </select>
        </label>
        <label>
          {t('Sprache')}
          <select value={lang} aria-label={t('Sprache')} onChange={(e) => { if (isLanguageChoice(e.target.value)) setLanguage(e.target.value) }}>
            {languageOptions().map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
        </label>
      </footer>

      {deleting && <ConfirmDialog detail={t('Dokument „{name}“ von diesem Gerät. Eine Kopie auf dem Server bleibt erhalten.', { name: deleting.name })}
        onConfirm={() => void remove(deleting)} onCancel={() => setDeleting(null)} />}
    </div>
  )
}
