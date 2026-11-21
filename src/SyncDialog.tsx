import { useState } from 'react'
import { Modal } from './Modal'
import { listCloudDocs, normalizeServer, tokenFor, type CloudDoc, type SyncState } from './syncClient'

const LAST = 'grid-sync-last-server'
const lastServer = () => { try { return localStorage.getItem(LAST) ?? '' } catch { return '' } }
const rememberServer = (s: string) => { try { localStorage.setItem(LAST, s) } catch { /* egal */ } }

/** Was die Oberfläche über die Cloud-Anbindung des Dokuments wissen und tun darf. */
export interface SyncControl {
  state: SyncState | null
  server: string | null
  connect: (server: string, token: string) => void
  disconnect: () => void
}

export const syncLabel = (c: SyncControl) => {
  if (!c.server) return 'Nicht synchronisiert'
  switch (c.state?.status) {
    case 'online': return 'Synchronisiert'
    case 'offline': return 'Offline – wird später abgeglichen'
    case 'denied': return `Abgelehnt: ${c.state.reason ?? 'kein Zugriff'}`
    default: return 'Verbinde …'
  }
}

function Field(props: { label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string; autoFocus?: boolean }) {
  return (
    <label className="sync-field">
      <span>{props.label}</span>
      <input type={props.type ?? 'text'} value={props.value} placeholder={props.placeholder} autoFocus={props.autoFocus}
        autoCapitalize="off" autoCorrect="off" spellCheck={false}
        onChange={(e) => props.onChange(e.target.value)} />
    </label>
  )
}

/** Dokument mit einem Server verbinden oder die Verbindung lösen. */
export function SyncDialog(props: { control: SyncControl; onClose: () => void }) {
  const c = props.control
  const [server, setServer] = useState(c.server ?? lastServer())
  const [token, setToken] = useState(() => tokenFor(c.server ?? lastServer()))
  const connected = !!c.server
  const submit = () => {
    const url = normalizeServer(server)
    if (!url || !token.trim()) return
    rememberServer(url)
    c.connect(url, token.trim())
  }
  return (
    <Modal onClose={props.onClose}>
      <form className="dialog sync-dialog" onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (!connected) submit() }}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>Cloud-Synchronisation</h3>
        {connected ? (
          <>
            <p className={`sync-status ${c.state?.status ?? 'connecting'}`}><span className="dot" />{syncLabel(c)}</p>
            <p className="sync-server">{c.server}</p>
            <p className="hint">Änderungen werden laufend abgeglichen. Ohne Verbindung arbeitest du lokal weiter; beim nächsten Verbinden werden beide Seiten zusammengeführt.</p>
            <div className="actions split">
              <button type="button" className="danger-outline" onClick={() => { c.disconnect(); props.onClose() }}>Verbindung lösen</button>
              <button type="button" className="primary" onClick={props.onClose}>Fertig</button>
            </div>
          </>
        ) : (
          <>
            <Field label="Server" value={server} onChange={(v) => { setServer(v); setToken(tokenFor(v)) }} placeholder="https://townwork.eu/grid" autoFocus />
            <Field label="Zugangsschlüssel" value={token} onChange={setToken} type="password" />
            <p className="hint">Das Dokument bleibt auch lokal vollständig erhalten.</p>
            <div className="actions">
              <button type="button" onClick={props.onClose}>Abbrechen</button>
              <button type="submit" className="primary" disabled={!server.trim() || !token.trim()}>Verbinden</button>
            </div>
          </>
        )}
      </form>
    </Modal>
  )
}

/** Dokument aus der Cloud wählen (Menü „Aus Cloud öffnen …“). */
export function CloudOpenDialog(props: { onOpen: (doc: CloudDoc, server: string, token: string) => void; onClose: () => void }) {
  const [server, setServer] = useState(lastServer())
  const [token, setToken] = useState(() => tokenFor(lastServer()))
  const [docs, setDocs] = useState<CloudDoc[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = async () => {
    const url = normalizeServer(server)
    if (!url || !token.trim()) return
    setBusy(true); setError(null)
    try {
      setDocs(await listCloudDocs(url, token.trim()))
      rememberServer(url)
    } catch (e) {
      setDocs(null)
      setError(e instanceof TypeError ? 'Server nicht erreichbar' : String((e as Error).message ?? e))
    } finally { setBusy(false) }
  }
  return (
    <Modal onClose={props.onClose}>
      <form className="dialog sync-dialog" onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); void load() }}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>Aus Cloud öffnen</h3>
        <Field label="Server" value={server} onChange={(v) => { setServer(v); setToken(tokenFor(v)); setDocs(null) }} placeholder="https://townwork.eu/grid" autoFocus={!server} />
        <Field label="Zugangsschlüssel" value={token} onChange={(v) => { setToken(v); setDocs(null) }} type="password" />
        {error && <p className="sync-error" role="alert">{error}</p>}
        {docs && (docs.length === 0
          ? <p className="hint">Auf diesem Server liegen noch keine Dokumente.</p>
          : <ul className="cloud-docs">
              {docs.map((d) => (
                <li key={d.id}>
                  <button type="button" onClick={() => props.onOpen(d, normalizeServer(server), token.trim())}>
                    <strong>{d.name || 'Ohne Namen'}</strong>
                    <small>{new Date(d.updated * 1000).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}</small>
                  </button>
                </li>
              ))}
            </ul>)}
        <div className="actions">
          <button type="button" onClick={props.onClose}>Schließen</button>
          <button type="submit" className="primary" disabled={busy || !server.trim() || !token.trim()}>{docs ? 'Aktualisieren' : 'Dokumente anzeigen'}</button>
        </div>
      </form>
    </Modal>
  )
}
