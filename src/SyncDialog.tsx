import { useEffect, useState } from 'react'
import { Modal } from './Modal'
import { exportAccount, fingerprint, getIdentity, importAccount, onIdentityChanged, type Identity } from './identity'
import { AuthError, listCloudDocs, normalizeServer, type CloudDoc, type SyncState } from './syncClient'

const LAST = 'grid-sync-last-server'
const lastServer = () => { try { return localStorage.getItem(LAST) ?? '' } catch { return '' } }
const rememberServer = (s: string) => { try { localStorage.setItem(LAST, s) } catch { /* egal */ } }

/** Was die Oberfläche über die Cloud-Anbindung des Dokuments wissen und tun darf. */
export interface SyncControl {
  state: SyncState | null
  server: string | null
  connect: (server: string) => void
  disconnect: () => void
}

export const syncLabel = (c: SyncControl) => {
  if (!c.server) return 'Nicht synchronisiert'
  switch (c.state?.status) {
    case 'online': return 'Synchronisiert'
    case 'offline': return 'Offline – wird später abgeglichen'
    case 'pending': return 'Wartet auf Freigabe des Kontos'
    case 'denied': return `Abgelehnt: ${c.state.reason ?? 'kein Zugriff'}`
    default: return 'Verbinde …'
  }
}

/** Das Konto dieses Geräts (wird beim ersten Mal angelegt). */
function useAccount(): Identity | null {
  const [me, setMe] = useState<Identity | null>(null)
  useEffect(() => {
    let alive = true
    const load = () => void getIdentity().then((i) => alive && setMe(i)).catch(() => {})
    load()
    const off = onIdentityChanged(load)
    return () => { alive = false; off() }
  }, [])
  return me
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

/** Zeile „Dein Konto“ mit Zugang zum Sichern/Übertragen. */
function AccountLine(props: { me: Identity | null; onManage: () => void }) {
  return (
    <p className="sync-account">
      <span>Dein Konto <code>{props.me ? fingerprint(props.me.publicKey) : '…'}</code></span>
      <button type="button" className="linklike" onClick={props.onManage}>Sichern oder übertragen …</button>
    </p>
  )
}

/** Dokument mit einem Server verbinden oder die Verbindung lösen. */
export function SyncDialog(props: { control: SyncControl; onClose: () => void }) {
  const c = props.control
  const me = useAccount()
  const [server, setServer] = useState(c.server ?? lastServer())
  const [account, setAccount] = useState(false)
  const connected = !!c.server
  const submit = () => {
    const url = normalizeServer(server)
    if (!url) return
    rememberServer(url)
    c.connect(url)
  }
  if (account) return <AccountDialog onClose={() => setAccount(false)} />
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
            {c.state?.status === 'pending'
              ? <p className="hint">Der Betreiber des Servers muss dein Konto freigeben. Nenne ihm die Kennung <code>{me?.id.slice(0, 8)}</code>
                  ({me ? fingerprint(me.publicKey) : ''}); danach verbindet sich Grid von selbst.</p>
              : <p className="hint">Änderungen werden laufend abgeglichen. Ohne Verbindung arbeitest du lokal weiter; beim nächsten Verbinden werden beide Seiten zusammengeführt.</p>}
            <AccountLine me={me} onManage={() => setAccount(true)} />
            <div className="actions split">
              <button type="button" className="danger-outline" onClick={() => { c.disconnect(); props.onClose() }}>Verbindung lösen</button>
              <button type="button" className="primary" onClick={props.onClose}>Fertig</button>
            </div>
          </>
        ) : (
          <>
            <Field label="Server" value={server} onChange={setServer} placeholder="https://townwork.eu/grid" autoFocus />
            <p className="hint">Du meldest dich mit deinem Grid-Konto an, ein Passwort gibt es nicht. Das Dokument bleibt auch lokal vollständig erhalten.</p>
            <AccountLine me={me} onManage={() => setAccount(true)} />
            <div className="actions">
              <button type="button" onClick={props.onClose}>Abbrechen</button>
              <button type="submit" className="primary" disabled={!server.trim()}>Verbinden</button>
            </div>
          </>
        )}
      </form>
    </Modal>
  )
}

/** Konto sichern, auf ein anderes Gerät übertragen oder von dort übernehmen. */
export function AccountDialog(props: { onClose: () => void }) {
  const me = useAccount()
  const [pass, setPass] = useState('')
  const [exported, setExported] = useState('')
  const [incoming, setIncoming] = useState('')
  const [pass2, setPass2] = useState('')
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const make = async () => {
    try { setExported(await exportAccount(pass)); setMessage(null) } catch (e) { setMessage({ ok: false, text: String((e as Error).message ?? e) }) }
  }
  const [confirming, setConfirming] = useState(false)
  const take = async () => {
    setConfirming(false)
    try {
      await importAccount(incoming, pass2)
      setIncoming(''); setPass2('')
      setMessage({ ok: true, text: 'Konto übernommen.' })
    } catch (e) { setMessage({ ok: false, text: String((e as Error).message ?? e) }) }
  }
  return (
    <Modal onClose={props.onClose}>
      <div className="dialog sync-dialog account-dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>Grid-Konto</h3>
        <p className="sync-account"><span>Fingerabdruck <code>{me ? fingerprint(me.publicKey) : '…'}</code></span></p>
        <p className="hint">Das Konto liegt auf diesem Gerät im Schlüsselbund. Mit einem zweiten Gerät teilst du es über einen verschlüsselten Text. Wer ihn und das Passwort hat, kann sich als du anmelden.</p>

        <h4>Auf ein anderes Gerät übertragen</h4>
        <Field label="Passwort für den Text" value={pass} onChange={(v) => { setPass(v); setExported('') }} type="password" />
        {exported
          ? <>
              <textarea readOnly rows={3} value={exported} onFocus={(e) => e.target.select()} aria-label="Verschlüsseltes Konto" />
              <div className="actions"><button type="button" onClick={() => { void navigator.clipboard?.writeText(exported); setCopied(true) }}>{copied ? 'Kopiert' : 'Kopieren'}</button></div>
            </>
          : <div className="actions"><button type="button" disabled={pass.length < 6} onClick={() => void make()}>Text erzeugen</button></div>}

        <h4>Konto von einem anderen Gerät übernehmen</h4>
        <textarea rows={3} placeholder="grid-account:1:…" value={incoming} onChange={(e) => setIncoming(e.target.value)} aria-label="Übertragenes Konto" />
        <Field label="Passwort" value={pass2} onChange={setPass2} type="password" />
        {confirming
          ? <>
              <p className="sync-error">Das Konto dieses Geräts wird ersetzt. Sichere es vorher, falls du es noch brauchst.</p>
              <div className="actions"><button type="button" onClick={() => setConfirming(false)}>Abbrechen</button><button type="button" className="danger" onClick={() => void take()}>Konto ersetzen</button></div>
            </>
          : <div className="actions"><button type="button" disabled={!incoming.trim() || !pass2} onClick={() => setConfirming(true)}>Übernehmen</button></div>}

        {message && <p className={message.ok ? 'sync-ok' : 'sync-error'} role="status">{message.text}</p>}
        <div className="actions"><button type="button" className="primary" onClick={props.onClose}>Fertig</button></div>
      </div>
    </Modal>
  )
}

/** Dokument aus der Cloud wählen (Menü „Aus Cloud öffnen …“). */
export function CloudOpenDialog(props: { onOpen: (doc: CloudDoc, server: string) => void; onClose: () => void }) {
  const me = useAccount()
  const [server, setServer] = useState(lastServer())
  const [docs, setDocs] = useState<CloudDoc[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [busy, setBusy] = useState(false)
  const [account, setAccount] = useState(false)
  const load = async () => {
    const url = normalizeServer(server)
    if (!url) return
    setBusy(true); setError(null); setPending(false)
    try {
      setDocs(await listCloudDocs(url))
      rememberServer(url)
    } catch (e) {
      setDocs(null)
      if (e instanceof AuthError && e.kind === 'pending') setPending(true)
      else setError(String((e as Error).message ?? e))
    } finally { setBusy(false) }
  }
  if (account) return <AccountDialog onClose={() => { setAccount(false); setDocs(null); setPending(false) }} />
  return (
    <Modal onClose={props.onClose}>
      <form className="dialog sync-dialog" onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); void load() }}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>Aus Cloud öffnen</h3>
        <Field label="Server" value={server} onChange={(v) => { setServer(v); setDocs(null); setPending(false) }} placeholder="https://townwork.eu/grid" autoFocus={!server} />
        {pending && <p className="hint">Dein Konto ist auf diesem Server noch nicht freigegeben. Nenne dem Betreiber die Kennung <code>{me?.id.slice(0, 8)}</code>.</p>}
        {error && <p className="sync-error" role="alert">{error}</p>}
        {docs && (docs.length === 0
          ? <p className="hint">Für dein Konto liegen auf diesem Server noch keine Dokumente.</p>
          : <ul className="cloud-docs">
              {docs.map((d) => (
                <li key={d.id}>
                  <button type="button" onClick={() => props.onOpen(d, normalizeServer(server))}>
                    <strong>{d.name || 'Ohne Namen'}</strong>
                    <small>{new Date(d.updated * 1000).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}</small>
                  </button>
                </li>
              ))}
            </ul>)}
        <AccountLine me={me} onManage={() => setAccount(true)} />
        <div className="actions">
          <button type="button" onClick={props.onClose}>Schließen</button>
          <button type="submit" className="primary" disabled={busy || !server.trim()}>{docs ? 'Aktualisieren' : 'Dokumente anzeigen'}</button>
        </div>
      </form>
    </Modal>
  )
}
