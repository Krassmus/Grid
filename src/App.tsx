import { runUndoCommand } from './undo'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import { FakeHub } from './sync'
import { ClientPane } from './ClientPane'
import { setWindowTitle } from './windowTitle'
import { invoke } from '@tauri-apps/api/core'
import { baseName, isTauri, newMeta, readGrid, writeGrid, type OpenedGrid } from './gridFile'
import { FileSession } from './fileSession'
import { isThemeChoice, setTheme } from './theme'
import { CloudOpenDialog, type SyncControl } from './SyncDialog'
import { ProfileDialog } from './ProfileDialog'
import { useProfiles } from './useTables'
import { JoinDialog } from './MembersDialog'
import type { MembersInfo } from './members'
import type { Invite } from './invite'
import { type CloudDoc, type SyncState } from './syncClient'
import { DocumentList } from './DocumentList'
import { isMobileUI } from './platform'
import { uniqueName } from './documents'
import { forgetRecent, noteRecent, readRecent, writeRecent } from './recentFiles'

/** Normalfall: ein Dokument, ein Client. Mit ?sim in der URL: zwei simulierte Clients zum Testen von Merges. */
const SIM = new URLSearchParams(location.search).has('sim')

/** Dokument ohne Datei (Browser, erster Start): wird in der IndexedDB der WebView gehalten. */
const UNSAVED_TITLE = 'Mein Dokument'
const LAST_KEY = 'grid-last-file'
const FILTERS = [{ name: 'Grid-Dokument', extensions: ['grid'] }]
const withExt = (p: string) => (/\.grid$/i.test(p) ? p : `${p}.grid`)
const remember = (p: string | null) => {
  try { p ? localStorage.setItem(LAST_KEY, p) : localStorage.removeItem(LAST_KEY) } catch { /* egal */ }
  if (p) noteRecent(p)
}

const NO_DOC = new Y.Doc() // Platzhalter, solange kein Dokument offen ist

function Single() {
  const [session, setSession] = useState<FileSession | null>(null)
  const current = useRef<FileSession | null>(null)
  current.current = session
  const [error, setError] = useState<string | null>(null)
  const counter = useRef(0)
  const busy = useRef(false)
  const [syncState, setSyncState] = useState<SyncState | null>(null)
  const [, bump] = useState(0)
  const [cloudOpen, setCloudOpen] = useState(false)
  const [joinOpen, setJoinOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [members, setMembers] = useState<MembersInfo | null>(null)
  const profiles = useProfiles(session?.doc ?? NO_DOC)
  const [listVersion, setListVersion] = useState(0)

  const unsaved = () => new FileSession(++counter.current, new Y.Doc(), null, newMeta(), new Set(), setError)
  const fromFile = (path: string, o: OpenedGrid) => new FileSession(++counter.current, o.doc, path, o.meta, o.known, setError, o.legacy)
  const adopt = (s: FileSession) => { remember(s.path); setSession(s) }

  const openPath = async (p: string) => {
    await current.current?.flush()
    try { adopt(fromFile(p, await readGrid(p))) } catch (e) {
      forgetRecent(p) // Datei fehlt oder ist kaputt: nicht weiter im Menü anbieten
      setError(`„${baseName(p)}“ konnte nicht geöffnet werden: ${e}`)
    }
  }

  // ----- iPad/iPhone: Dokumente liegen im App-Ordner, es gibt eine Liste statt Menü -----
  const docsPath = async (name: string) => {
    const dir = await invoke<string>('docs_dir')
    const taken = (await invoke<{ name: string }[]>('list_documents')).map((f) => f.name)
    return `${dir}/${uniqueName(name, taken)}.grid`
  }
  const goHome = async () => {
    await current.current?.flush()
    setSession(null)
    setListVersion((n) => n + 1)
  }
  const createHere = async (name: string) => {
    if (!isTauri) { setSession(unsaved()); return } // Browser (Entwicklung): Dokument ohne Datei
    try {
      const p = await docsPath(name)
      const doc = new Y.Doc(), meta = newMeta()
      const known = await writeGrid(p, doc, meta, new Set())
      adopt(new FileSession(++counter.current, doc, p, meta, known, setError))
    } catch (e) { setError(`Anlegen fehlgeschlagen: ${e}`) }
  }

  /** Dokument aus der Cloud: Speicherort wählen, leere Datei mit der Anbindung anlegen; der Abgleich füllt sie. */
  const openFromCloud = async (d: CloudDoc, server: string, key?: string, enc = !!d.enc) => {
    setCloudOpen(false)
    let p: string
    if (isMobileUI) p = await docsPath(d.name || 'Cloud-Dokument')
    else {
      const dialog = await import('@tauri-apps/plugin-dialog')
      const chosen = await dialog.save({ defaultPath: `${d.name || 'Cloud-Dokument'}.grid`, filters: FILTERS })
      if (!chosen) return
      p = withExt(chosen)
    }
    await current.current?.flush()
    const doc = new Y.Doc(), meta = { ...newMeta(), docId: d.id, sync: { server, ...(key ? { key } : {}), ...(enc ? { enc: true } : {}) } }
    try {
      const known = await writeGrid(p, doc, meta, new Set())
      adopt(new FileSession(++counter.current, doc, p, meta, known, setError))
    } catch (e) { setError(`Anlegen fehlgeschlagen: ${e}`) }
  }

  // Beim Start das zuletzt geöffnete Dokument laden.
  useEffect(() => {
    let alive = true
    if (isTauri) writeRecent(readRecent()) // Menü „Zuletzt geöffnet“ füllen
    ;(async () => {
      // Vom Finder angeforderte Datei hat Vorrang vor dem zuletzt geöffneten Dokument.
      const requested = isTauri ? await invoke<string | null>('take_pending_open').catch(() => null) : null
      // iPad/iPhone starten mit der Dokumentenliste (außer eine Datei wurde zum Öffnen übergeben)
      const last = requested ?? (isTauri && !isMobileUI ? localStorage.getItem(LAST_KEY) : null)
      if (last) {
        try {
          const o = await readGrid(last)
          if (alive) { remember(last); setSession(fromFile(last, o)) }
          return
        } catch (e) {
          if (alive) setError(`„${baseName(last)}“ konnte nicht geöffnet werden: ${e}`)
        }
      }
      if (alive && !isMobileUI) setSession(unsaved())
    })()
    return () => { alive = false }
  }, [])

  useEffect(() => session?.attach(), [session])
  // iPad/iPhone können die App im Hintergrund beenden: beim Wegwechseln sofort sichern
  useEffect(() => {
    const hide = () => { if (document.visibilityState === 'hidden') void current.current?.flush() }
    document.addEventListener('visibilitychange', hide)
    return () => document.removeEventListener('visibilitychange', hide)
  }, [])
  useEffect(() => {
    if (!session) return
    session.onSyncState = setSyncState
    session.onMembers = setMembers
    setSyncState(session.syncState)
    setMembers(session.members)
    return () => { session.onSyncState = null; session.onMembers = null }
  }, [session])
  useEffect(() => { if (session) setWindowTitle(session.path ? baseName(session.path) : UNSAVED_TITLE) }, [session])

  // Befehle der Menüleiste (Rust sendet „menu“) und Fenster schließen: erst fertig speichern.
  useEffect(() => {
    if (!isTauri || isMobileUI) return // ohne Menüleiste gibt es keine Menübefehle
    const stops: Array<() => void> = []
    let gone = false
    ;(async () => {
      const [{ listen }, { getCurrentWindow }, dialog] = await Promise.all([
        import('@tauri-apps/api/event'), import('@tauri-apps/api/window'), import('@tauri-apps/plugin-dialog'),
      ])

      const open = async () => {
        const p = await dialog.open({ multiple: false, directory: false, filters: FILTERS })
        if (typeof p !== 'string') return
        await openPath(p)
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

      const actions: Record<string, () => Promise<void>> = { open, new: create, save, save_as: saveAs, open_cloud: async () => setCloudOpen(true), join: async () => setJoinOpen(true), account: async () => setProfileOpen(true) }
      const unlisten = await listen<string>('menu', (e) => {
        if (e.payload === 'clear_recent') { writeRecent([]); return }
        if (e.payload === 'undo' || e.payload === 'redo') { runUndoCommand(e.payload); return }
        const theme = /^theme:(.+)$/.exec(e.payload)
        if (theme) { if (isThemeChoice(theme[1])) setTheme(theme[1]); return }
        const recent = /^recent:(\d+)$/.exec(e.payload)
        const run = recent ? () => { const p = readRecent()[Number(recent[1])]; return p ? openPath(p) : Promise.resolve() } : actions[e.payload]
        if (!run || busy.current) return
        busy.current = true
        run().finally(() => { busy.current = false })
      })
      // Datei per Finder geöffnet, während die App läuft
      const unopen = await listen<string>('open-file', (e) => {
        void invoke('take_pending_open')
        void openPath(e.payload)
      })
      const unclose = await getCurrentWindow().onCloseRequested(async (ev) => {
        ev.preventDefault()
        await current.current?.flush()
        await getCurrentWindow().destroy()
      })
      if (gone) { unlisten(); unopen(); unclose() } else stops.push(unlisten, unopen, unclose)
    })()
    return () => { gone = true; stops.forEach((f) => f()) }
  }, [])

  const dialogs = (
    <>
      {joinOpen && <JoinDialog onClose={() => setJoinOpen(false)} onJoined={(i: Invite) => { setJoinOpen(false); void openFromCloud({ id: i.doc, name: i.name, updated: 0 }, i.server, i.key, !!i.enc) }} />}
      {profileOpen && <ProfileDialog onClose={() => setProfileOpen(false)} />}
      {cloudOpen && <CloudOpenDialog onOpen={(d, server) => void openFromCloud(d, server)} onClose={() => setCloudOpen(false)} />}
      {error && !(isMobileUI && !session) && <div className="file-error" role="alert">{error}<button type="button" onClick={() => setError(null)}>✕</button></div>}
    </>
  )
  if (!session) {
    if (!isMobileUI) return null
    return (
      <>
        <DocumentList version={listVersion} error={error} onOpen={(p) => { setError(null); void openPath(p) }} onCreate={(n) => { setError(null); void createHere(n) }}
          onCloud={() => setCloudOpen(true)} onJoin={() => setJoinOpen(true)} onAccount={() => setProfileOpen(true)} />
        {dialogs}
      </>
    )
  }
  const control: SyncControl = {
    state: syncState,
    members,
    profiles,
    accept: session.accept, reject: session.reject, remove: session.remove, changeRole: session.changeRole, invite: () => session.invite(),
    server: session.meta.sync?.server ?? null,
    enc: !!session.meta.sync?.enc,
    encryptDocument: async () => { await session.encryptDocument(); bump((n) => n + 1) },
    connect: (server, enc) => { session.connect(server, undefined, enc); bump((n) => n + 1) },
    disconnect: () => { session.disconnect(); bump((n) => n + 1) },
    trustServer: () => { session.trustServer(); bump((n) => n + 1) },
    resync: () => session.resync(),
    moveTo: async (server) => { await session.moveTo(server); bump((n) => n + 1) },
    moved: session.movedTo,
    followMove: () => { const m = session.movedTo; if (m) { session.connect(m.server, m.key, !!session.meta.sync?.enc); bump((n) => n + 1) } },
  }
  return (
    <>
      <ClientPane key={session.key} title={UNSAVED_TITLE} doc={session.doc}
        persist={session.path ? null : `grid-proto-${UNSAVED_TITLE}`} sync={control}
        onHome={isMobileUI ? () => void goHome() : undefined} onAccount={isMobileUI ? () => setProfileOpen(true) : undefined} />
      {dialogs}
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
    <main className={SIM ? undefined : 'single'}>
      {SIM && <h1>Grid – Simulation</h1>}
      {SIM && <p className="hint">Simulationsmodus: zwei Clients am selben Dokument. Einen offline schalten, beide bearbeiten, wieder online schalten.</p>}
      {SIM ? <Simulation /> : <Single />}
    </main>
  )
}
