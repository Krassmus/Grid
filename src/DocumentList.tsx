import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './gridFile'
import { ConfirmDialog } from './Modal'
import { ago, uniqueName } from './documents'
import { isThemeChoice, readTheme, setTheme, type ThemeChoice } from './theme'

export interface DocFile { name: string; path: string; modified: number; size: number }

const fmtSize = (n: number) => (n < 1024 ** 2 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 ** 2).toFixed(1).replace('.', ',')} MB`)

/** Dokumentenliste: Startbildschirm auf iPad und iPhone (dort gibt es keine Menüleiste). */
export function DocumentList(props: {
  /** Ändert sich, wenn die Liste neu geladen werden soll (z. B. nach dem Schließen eines Dokuments) */
  version: number
  onOpen: (path: string) => void
  onCreate: (name: string) => void
  onCloud: () => void
  onJoin: () => void
  error?: string | null
}) {
  const [files, setFiles] = useState<DocFile[] | null>(null)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [deleting, setDeleting] = useState<DocFile | null>(null)
  const [theme, setThemeState] = useState<ThemeChoice>(readTheme())
  const [problem, setProblem] = useState<string | null>(null)

  const load = useCallback(async () => {
    try { setFiles(isTauri ? await invoke<DocFile[]>('list_documents') : []) } catch (e) { setProblem(String(e)); setFiles([]) }
  }, [])
  useEffect(() => { void load() }, [load, props.version])

  const create = () => {
    props.onCreate(uniqueName(name.trim() || 'Neues Dokument', (files ?? []).map((f) => f.name)))
    setNaming(false)
    setName('')
  }
  const remove = async (f: DocFile) => {
    setDeleting(null)
    try { await invoke('delete_document', { path: f.path }) } catch (e) { setProblem(`Löschen fehlgeschlagen: ${e}`) }
    void load()
  }

  return (
    <div className="doclist">
      <header>
        <h1>Dokumente</h1>
        <div className="doclist-actions">
          <button type="button" className="primary" onClick={() => setNaming(true)}>+ Neues Dokument</button>
          <button type="button" onClick={props.onCloud}>Aus Cloud …</button>
          <button type="button" onClick={props.onJoin}>Einladung …</button>
        </div>
      </header>

      {naming && (
        <form className="doclist-new" onSubmit={(e) => { e.preventDefault(); create() }}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name des Dokuments" maxLength={80}
            autoCapitalize="sentences" aria-label="Name des Dokuments" />
          <button type="button" onClick={() => { setNaming(false); setName('') }}>Abbrechen</button>
          <button type="submit" className="primary">Anlegen</button>
        </form>
      )}

      {(props.error || problem) && <p className="sync-error" role="alert">{props.error ?? problem}</p>}

      {files === null ? <p className="hint">Wird geladen …</p>
        : files.length === 0
          ? <div className="doclist-empty">
              <p><strong>Noch keine Dokumente.</strong></p>
              <p className="hint">Lege ein neues Dokument an, hole eines aus der Cloud oder nimm eine Einladung an. Dokumente aus der Dateien-App kannst du mit „Öffnen mit → Grid“ übernehmen.</p>
            </div>
          : <ul className="doclist-items">
              {files.map((f) => (
                <li key={f.path}>
                  <button type="button" className="doclist-open" onClick={() => props.onOpen(f.path)}>
                    <strong>{f.name}</strong>
                    <small>{ago(f.modified)} · {fmtSize(f.size)}</small>
                  </button>
                  <button type="button" className="doclist-del" aria-label={`„${f.name}“ löschen`} onClick={() => setDeleting(f)}>Löschen</button>
                </li>
              ))}
            </ul>}

      <footer>
        <span>Erscheinungsbild</span>
        <div className="seg" role="group" aria-label="Erscheinungsbild">
          {([['system', 'System'], ['light', 'Hell'], ['dark', 'Dunkel']] as [string, string][]).map(([v, label]) => (
            <button key={v} type="button" className={theme === v ? 'on' : ''} aria-pressed={theme === v}
              onClick={() => { if (isThemeChoice(v)) { setTheme(v); setThemeState(v) } }}>{label}</button>
          ))}
        </div>
      </footer>

      {deleting && <ConfirmDialog detail={`Dokument „${deleting.name}“ von diesem Gerät. Eine Kopie auf dem Server bleibt erhalten.`}
        onConfirm={() => void remove(deleting)} onCancel={() => setDeleting(null)} />}
    </div>
  )
}
