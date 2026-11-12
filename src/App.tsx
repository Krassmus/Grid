import { useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import { FakeHub } from './sync'
import { ClientPane } from './ClientPane'
import { setWindowTitle } from './windowTitle'
import { baseName, isTauri, newMeta, readGrid, writeGrid, type OpenedGrid } from './gridFile'
import { FileSession } from './fileSession'

/** Normalfall: ein Dokument, ein Client. Mit ?sim in der URL: zwei simulierte Clients zum Testen von Merges. */
const SIM = new URLSearchParams(location.search).has('sim')

/** Dokument ohne Datei (Browser, erster Start): wird in der IndexedDB der WebView gehalten. */
const UNSAVED_TITLE = 'Mein Dokument'
const LAST_KEY = 'grid-last-file'
const FILTERS = [{ name: 'Grid-Dokument', extensions: ['grid'] }]
const withExt = (p: string) => (/\.grid$/i.test(p) ? p : `${p}.grid`)
const remember = (p: string | null) => { try { p ? localStorage.setItem(LAST_KEY, p) : localStorage.removeItem(LAST_KEY) } catch { /* egal */ } }

function Single() {
  const [session, setSession] = useState<FileSession | null>(null)
  const current = useRef<FileSession | null>(null)
  current.current = session
  const [error, setError] = useState<string | null>(null)
  const counter = useRef(0)
  const busy = useRef(false)

  const unsaved = () => new FileSession(++counter.current, new Y.Doc(), null, newMeta(), new Set(), setError)
  const fromFile = (path: string, o: OpenedGrid) => new FileSession(++counter.current, o.doc, path, o.meta, o.known, setError)
  const adopt = (s: FileSession) => { remember(s.path); setSession(s) }

  // Beim Start das zuletzt geöffnete Dokument laden.
  useEffect(() => {
    let alive = true
    ;(async () => {
      const last = isTauri ? localStorage.getItem(LAST_KEY) : null
      if (last) {
        try {
          const o = await readGrid(last)
          if (alive) setSession(fromFile(last, o))
          return
        } catch (e) {
          if (alive) setError(`„${baseName(last)}“ konnte nicht geöffnet werden: ${e}`)
        }
      }
      if (alive) setSession(unsaved())
    })()
    return () => { alive = false }
  }, [])

  useEffect(() => session?.attach(), [session])
  useEffect(() => { if (session) setWindowTitle(session.path ? baseName(session.path) : UNSAVED_TITLE) }, [session])

  // Befehle der Menüleiste (Rust sendet „menu“) und Fenster schließen: erst fertig speichern.
  useEffect(() => {
    if (!isTauri) return
    const stops: Array<() => void> = []
    let gone = false
    ;(async () => {
      const [{ listen }, { getCurrentWindow }, dialog] = await Promise.all([
        import('@tauri-apps/api/event'), import('@tauri-apps/api/window'), import('@tauri-apps/plugin-dialog'),
      ])

      const open = async () => {
        const p = await dialog.open({ multiple: false, directory: false, filters: FILTERS })
        if (typeof p !== 'string') return
        await current.current?.flush()
        try { adopt(fromFile(p, await readGrid(p))) } catch (e) { setError(`„${baseName(p)}“ konnte nicht geöffnet werden: ${e}`) }
      }
      const create = async () => {
        const chosen = await dialog.save({ defaultPath: 'Unbenannt.grid', filters: FILTERS })
        if (!chosen) return
        const p = withExt(chosen)
        await current.current?.flush()
        const doc = new Y.Doc(), meta = newMeta()
        try {
          const known = await writeGrid(p, doc, meta, new Set())
          adopt(new FileSession(++counter.current, doc, p, meta, known, setError))
        } catch (e) { setError(`Anlegen fehlgeschlagen: ${e}`) }
      }
      const saveAs = async () => {
        const cur = current.current
        if (!cur) return
        const chosen = await dialog.save({ defaultPath: `${cur.path ? baseName(cur.path) : UNSAVED_TITLE}.grid`, filters: FILTERS })
        if (!chosen) return
        const p = withExt(chosen)
        await cur.flush()
        const meta = { ...newMeta() } // eine Kopie ist ein eigenes Dokument
        try {
          const known = await writeGrid(p, cur.doc, meta, new Set())
          adopt(new FileSession(cur.key, cur.doc, p, meta, known, setError)) // gleicher key: Oberfläche bleibt stehen
        } catch (e) { setError(`Speichern fehlgeschlagen: ${e}`) }
      }
      const save = async () => {
        const cur = current.current
        if (!cur) return
        if (!cur.path) return saveAs()
        cur.schedule()
        await cur.flush()
      }

      const actions: Record<string, () => Promise<void>> = { open, new: create, save, save_as: saveAs }
      const unlisten = await listen<string>('menu', (e) => {
        const run = actions[e.payload]
        if (!run || busy.current) return
        busy.current = true
        run().finally(() => { busy.current = false })
      })
      const unclose = await getCurrentWindow().onCloseRequested(async (ev) => {
        ev.preventDefault()
        await current.current?.flush()
        await getCurrentWindow().destroy()
      })
      if (gone) { unlisten(); unclose() } else stops.push(unlisten, unclose)
    })()
    return () => { gone = true; stops.forEach((f) => f()) }
  }, [])

  if (!session) return null
  return (
    <>
      <ClientPane key={session.key} title={UNSAVED_TITLE} doc={session.doc}
        persist={session.path ? null : `grid-proto-${UNSAVED_TITLE}`} />
      {error && <div className="file-error" role="alert">{error}<button type="button" onClick={() => setError(null)}>✕</button></div>}
    </>
  )
}

function Simulation() {
  const { hub, a, b } = useMemo(() => {
    const hub = new FakeHub()
    const a = new Y.Doc(), b = new Y.Doc()
    hub.join('Client A', a); hub.join('Client B', b)
    return { hub, a, b }
  }, [])
  const [, force] = useState(0)
  const toggle = (id: string) => { hub.setOnline(id, !hub.isOnline(id)); force((n) => n + 1) }
  return (
    <div className="panes">
      {(['Client A', 'Client B'] as const).map((id) => (
        <ClientPane key={id} title={id} doc={id === 'Client A' ? a : b}
          online={hub.isOnline(id)} onToggle={() => toggle(id)} />
      ))}
    </div>
  )
}

export function App() {
  return (
    <main>
      {SIM && <h1>Grid – Simulation</h1>}
      {SIM && <p className="hint">Simulationsmodus: zwei Clients am selben Dokument. Einen offline schalten, beide bearbeiten, wieder online schalten.</p>}
      {SIM ? <Simulation /> : <Single />}
    </main>
  )
}
