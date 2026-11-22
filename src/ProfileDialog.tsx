import { useEffect, useRef, useState } from 'react'
import { Modal } from './Modal'
import { Avatar } from './Avatar'
import { fingerprint, getIdentity, onIdentityChanged, type Identity } from './identity'
import { avatarFromFile, getProfile, onProfileChange, setProfile, type Profile } from './profile'
import { importAccount } from './identity'
import { confirmEmailCode, fetchRecoveryText, MIN_RECOVERY_PASSWORD, removeEmail, requestEmailCode, startRecovery, storeRecovery } from './recovery'
import { fetchAccountInfo, normalizeServer, type AccountInfo } from './syncClient'
import { AccountDialog, Field, lastServer, rememberServer } from './SyncDialog'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Aktueller Stand des Profils; aktualisiert sich bei Änderungen. */
export function useProfile(): Profile {
  const [p, setP] = useState(getProfile)
  useEffect(() => onProfileChange(() => setP(getProfile())), [])
  return p
}

/** Knopf mit dem Avatar (öffnet das Konto). */
export function AccountButton(props: { onClick: () => void }) {
  const profile = useProfile()
  return (
    <button type="button" className="account-btn" onClick={props.onClick} aria-label={`Konto${profile.name ? `: ${profile.name}` : ''}`} title={profile.name || 'Konto'}>
      <Avatar name={profile.name} avatar={profile.avatar} size={30} />
    </button>
  )
}

/** Globales Konto: Name, Avatar, E-Mail-Adresse mit Wiederherstellung, Sichern auf ein anderes Gerät. */
export function ProfileDialog(props: { onClose: () => void }) {
  const profile = useProfile()
  const [me, setMe] = useState<Identity | null>(null)
  const [server, setServer] = useState(lastServer())
  const [info, setInfo] = useState<AccountInfo | null>(null)
  const [email, setEmail] = useState(profile.email)
  const [code, setCode] = useState<string | null>(null) // gesetzt, sobald ein Code unterwegs ist
  const [codeInput, setCodeInput] = useState('')
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [sub, setSub] = useState<'backup' | 'recover' | null>(null)
  const file = useRef<HTMLInputElement>(null)
  useEffect(() => { void getIdentity().then(setMe).catch(() => {}); return onIdentityChanged(() => void getIdentity().then(setMe)) }, [])

  const url = normalizeServer(server)
  const run = async (what: () => Promise<void>) => {
    setBusy(true); setNote(null)
    try { await what() } catch (e) { setNote({ ok: false, text: message(e) }) } finally { setBusy(false) }
  }
  const load = () => run(async () => {
    if (!url) throw new Error('Gib den Server an, bei dem du dein Konto wiederherstellen können willst')
    rememberServer(url)
    setInfo(await fetchAccountInfo(url))
  })
  const verified = !!info?.emailVerified && info.email?.toLowerCase() === email.trim().toLowerCase()

  if (sub === 'backup') return <AccountDialog onClose={() => setSub(null)} />
  if (sub === 'recover') return <RecoverDialog server={server} onClose={() => setSub(null)} />
  return (
    <Modal onClose={props.onClose}>
      <div className="dialog sync-dialog profile-dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>Konto</h3>
        <div className="profile-head">
          <button type="button" className="avatar-pick" onClick={() => file.current?.click()} aria-label="Avatar-Bild wählen" title="Bild wählen">
            <Avatar name={profile.name} avatar={profile.avatar} size={64} />
          </button>
          <input ref={file} type="file" accept="image/*" hidden onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void avatarFromFile(f).then((a) => setProfile({ avatar: a }), (err) => setNote({ ok: false, text: message(err) }))
          }} />
          <div className="profile-fields">
            <Field label="Dein Name" value={profile.name} onChange={(v) => setProfile({ name: v })} placeholder="z. B. Anna Beispiel" autoFocus />
            {profile.avatar && <button type="button" className="linklike" onClick={() => setProfile({ avatar: '' })}>Bild entfernen</button>}
          </div>
        </div>
        <p className="hint">Den Namen sehen die Admins deiner Dokumente, wenn du anklopfst oder Mitglied bist. Name und Bild gelten für alle Dokumente und liegen nur auf diesem Gerät.</p>
        <p className="sync-account"><span>Kennung <code>{me ? fingerprint(me.publicKey) : '…'}</code></span></p>

        <h4>E-Mail und Wiederherstellung</h4>
        <p className="hint">Mit einer bestätigten Adresse kannst du dein Konto auf einem neuen Gerät wiederherstellen, falls dieses verloren geht. Der Server bewahrt nur einen mit deinem Passwort verschlüsselten Text auf; ohne das Passwort ist er wertlos, auch für den Betreiber.</p>
        <Field label="Server" value={server} onChange={(v) => { setServer(v); setInfo(null) }} placeholder="https://townwork.eu/grid" />
        <Field label="E-Mail-Adresse" value={email} onChange={(v) => { setEmail(v); setProfile({ email: v }); setCode(null) }} type="email" placeholder="anna@example.org" />
        {!info && <div className="actions"><button type="button" disabled={busy || !server.trim()} onClick={() => void load()}>Stand beim Server abfragen</button></div>}
        {info && !info.mail && <p className="sync-error">Dieser Server kann keine E-Mails senden. Wiederherstellung ist dort nicht möglich.</p>}
        {info?.mail && (
          <>
            {verified
              ? <p className="sync-status online"><span className="dot" />Adresse bestätigt{info.recovery ? ', Wiederherstellung eingerichtet' : ''}</p>
              : code === null
              ? <div className="actions"><button type="button" disabled={busy || !email.includes('@')} onClick={() => void run(async () => { await requestEmailCode(url, email.trim()); setCode('') })}>Bestätigungscode senden</button></div>
              : <>
                  <Field label="Code aus der E-Mail" value={codeInput} onChange={setCodeInput} placeholder="6 Ziffern" />
                  <div className="actions"><button type="button" className="primary" disabled={busy || codeInput.trim().length < 6} onClick={() => void run(async () => { await confirmEmailCode(url, codeInput.trim()); setCode(null); setCodeInput(''); setInfo(await fetchAccountInfo(url)) })}>Bestätigen</button></div>
                </>}
            {verified && (
              <>
                <Field label={`Passwort für die Wiederherstellung (mindestens ${MIN_RECOVERY_PASSWORD} Zeichen)`} value={pass} onChange={setPass} type="password" />
                <div className="actions split">
                  <button type="button" className="danger-outline" disabled={busy} onClick={() => void run(async () => { await removeEmail(url); setInfo(await fetchAccountInfo(url)) })}>Adresse beim Server entfernen</button>
                  <button type="button" className="primary" disabled={busy || pass.length < MIN_RECOVERY_PASSWORD} onClick={() => void run(async () => { await storeRecovery(url, pass); setPass(''); setInfo(await fetchAccountInfo(url)); setNote({ ok: true, text: 'Wiederherstellung eingerichtet. Merke dir das Passwort: ohne es geht es nicht.' }) })}>{info.recovery ? 'Passwort ändern' : 'Wiederherstellung einrichten'}</button>
                </div>
              </>
            )}
          </>
        )}
        {note && <p className={note.ok ? 'hint' : 'sync-error'} role={note.ok ? 'status' : 'alert'}>{note.text}</p>}

        <div className="actions split">
          <span className="profile-links">
            <button type="button" className="linklike" onClick={() => setSub('backup')}>Sichern oder übertragen …</button>
            <button type="button" className="linklike" onClick={() => setSub('recover')}>Per E-Mail wiederherstellen …</button>
          </span>
          <button type="button" className="primary" onClick={props.onClose}>Fertig</button>
        </div>
      </div>
    </Modal>
  )
}

/** Neues Gerät: Konto per E-Mail-Code und Passwort zurückholen. */
function RecoverDialog(props: { server: string; onClose: () => void }) {
  const [server, setServer] = useState(props.server)
  const [email, setEmail] = useState(getProfile().email)
  const [sent, setSent] = useState(false)
  const [code, setCode] = useState('')
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [text, setText] = useState<string | null>(null) // der schon geholte, verschlüsselte Kontotext
  const run = async (what: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await what() } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  if (done) {
    return (
      <Modal onClose={props.onClose}>
        <div className="dialog sync-dialog" onMouseDown={(e) => e.stopPropagation()}>
          <h3>Konto wiederhergestellt</h3>
          <p className="hint">Dein Konto ist auf diesem Gerät wieder da. Verschlüsselte Dokumente öffnest du über „Aus Cloud öffnen“.</p>
          <div className="actions"><button type="button" className="primary" onClick={props.onClose}>Fertig</button></div>
        </div>
      </Modal>
    )
  }
  return (
    <Modal onClose={props.onClose}>
      <div className="dialog sync-dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>Konto per E-Mail wiederherstellen</h3>
        <p className="hint">Das ersetzt das Konto, das jetzt auf diesem Gerät ist. Du brauchst die Adresse, die du bestätigt hast, und das Passwort der Wiederherstellung.</p>
        <Field label="Server" value={server} onChange={setServer} placeholder="https://townwork.eu/grid" autoFocus />
        <Field label="E-Mail-Adresse" value={email} onChange={setEmail} type="email" />
        {!sent
          ? <div className="actions"><button type="button" disabled={busy || !server.trim() || !email.includes('@')} onClick={() => void run(async () => { await startRecovery(server, email.trim()); setSent(true); rememberServer(normalizeServer(server)) })}>Code senden</button></div>
          : <>
              <p className="hint">Wenn zu dieser Adresse eine Wiederherstellung eingerichtet ist, kommt gleich eine E-Mail mit einem Code.</p>
              <Field label="Code aus der E-Mail" value={code} onChange={setCode} placeholder="6 Ziffern" />
              <Field label="Passwort der Wiederherstellung" value={pass} onChange={setPass} type="password" />
              <div className="actions"><button type="button" className="primary" disabled={busy || (text === null && code.trim().length < 6) || !pass} onClick={() => void run(async () => { const t = text ?? await fetchRecoveryText(server, email.trim(), code.trim()); setText(t); await importAccount(t, pass); setDone(true) })}>Wiederherstellen</button></div>
            </>}
        {error && <p className="sync-error" role="alert">{error}</p>}
        <div className="actions"><button type="button" onClick={props.onClose}>Abbrechen</button></div>
      </div>
    </Modal>
  )
}
