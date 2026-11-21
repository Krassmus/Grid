import { useEffect, useState } from 'react'
import { Modal } from './Modal'
import { fingerprint, getAccountName, getIdentity, setAccountName } from './identity'
import { parseInvite, type Invite } from './invite'
import { requestJoin } from './members'
import { AuthError, pinServer, pinnedKey } from './syncClient'
import type { Role } from './adminLog'
import type { JoinRequest, MembersInfo } from './members'

/** Was die Oberfläche über die Mitglieder des Dokuments wissen und tun darf. */
export interface MembersControl {
  members: MembersInfo | null
  accept: (req: JoinRequest, role?: Role) => Promise<void>
  reject: (account: string) => Promise<void>
  remove: (account: string) => Promise<void>
  changeRole: (account: string, role: Role) => Promise<void>
  invite: () => Promise<string>
}

const message = (e: unknown) => String((e as Error).message ?? e)
const who = (name: string) => name || 'Ohne Namen'

/** Mitglieder verwalten: Anfragen zulassen oder ablehnen, Rollen ändern, Mitglieder entfernen, Einladung erzeugen. */
export function MembersDialog(props: { control: MembersControl; onClose: () => void }) {
  const { members } = props.control
  const [me, setMe] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [invite, setInvite] = useState('')
  const [copied, setCopied] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  useEffect(() => { void getIdentity().then((i) => setMe(i.id)).catch(() => {}) }, [])
  const admin = members?.role === 'admin'
  const act = async (f: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await f() } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  const list = members?.state ? [...members.state.members.entries()] : []
  return (
    <Modal onClose={props.onClose}>
      <div className="dialog sync-dialog members-dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>Mitglieder</h3>
        {!members && <p className="hint">Wird geladen …</p>}
        {members && !members.state && <p className="hint">Die Mitgliederliste wird beim nächsten Verbinden angelegt.</p>}

        {admin && members.requests.length > 0 && (
          <>
            <h4>Möchten beitreten</h4>
            {members.requests.map((r) => (
              <div key={r.account} className="member-row request">
                <div>
                  <strong>{who(r.name)}</strong>
                  <small>Prüfnummer <code>{fingerprint(r.pub)}</code></small>
                </div>
                <span className="member-actions">
                  <button type="button" disabled={busy} onClick={() => void act(() => props.control.reject(r.account))}>Ablehnen</button>
                  <button type="button" className="primary" disabled={busy} onClick={() => void act(() => props.control.accept(r))}>Zulassen</button>
                </span>
              </div>
            ))}
            <p className="hint">Vergleiche die Prüfnummer mit der, die die Person in Grid sieht (am besten am Telefon oder im Gespräch), bevor du zulässt.</p>
          </>
        )}

        {list.length > 0 && <h4>Im Dokument</h4>}
        {list.map(([id, m]) => (
          <div key={id} className="member-row">
            <div>
              <strong>{who(m.name)}{id === me && ' (du)'}</strong>
              <small><code>{fingerprint(m.pub)}</code> · {m.role === 'admin' ? 'Admin' : 'Mitglied'}</small>
            </div>
            {admin && (removing === id
              ? <span className="member-actions">
                  <button type="button" onClick={() => setRemoving(null)}>Abbrechen</button>
                  <button type="button" className="danger" disabled={busy} onClick={() => { setRemoving(null); void act(() => props.control.remove(id)) }}>Entfernen</button>
                </span>
              : <span className="member-actions">
                  <button type="button" className="linklike" disabled={busy} onClick={() => void act(() => props.control.changeRole(id, m.role === 'admin' ? 'member' : 'admin'))}>
                    {m.role === 'admin' ? 'Zum Mitglied machen' : 'Zum Admin machen'}
                  </button>
                  <button type="button" className="linklike danger-text" disabled={busy} onClick={() => setRemoving(id)}>{id === me ? 'Verlassen' : 'Entfernen'}</button>
                </span>)}
          </div>
        ))}

        {admin && (
          <>
            <h4>Person einladen</h4>
            {invite
              ? <>
                  <textarea readOnly rows={3} value={invite} onFocus={(e) => e.target.select()} aria-label="Einladung" />
                  <div className="actions"><button type="button" onClick={() => { void navigator.clipboard?.writeText(invite); setCopied(true) }}>{copied ? 'Kopiert' : 'Kopieren'}</button></div>
                  <p className="hint">Schicke den Text der Person. Sie fügt ihn in Grid unter „Ablage → Einladung annehmen …“ ein und klopft damit an; hier erscheint dann ihre Anfrage.</p>
                </>
              : <div className="actions"><button type="button" onClick={() => void act(async () => { setInvite(await props.control.invite()); setCopied(false) })}>Einladung erzeugen</button></div>}
          </>
        )}

        {error && <p className="sync-error" role="alert">{error}</p>}
        <div className="actions"><button type="button" className="primary" onClick={props.onClose}>Fertig</button></div>
      </div>
    </Modal>
  )
}

/** Einladung annehmen: Text einfügen, Name und Prüfnummer ansehen, anklopfen. */
export function JoinDialog(props: { onJoined: (invite: Invite) => void; onClose: () => void }) {
  const [text, setText] = useState('')
  const [name, setName] = useState(getAccountName())
  const [fp, setFp] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { void getIdentity().then((i) => setFp(fingerprint(i.publicKey))).catch(() => {}) }, [])
  let invite: Invite | null = null
  let parseError: string | null = null
  if (text.trim()) { try { invite = parseInvite(text) } catch (e) { parseError = message(e) } }
  const join = async () => {
    if (!invite) return
    setBusy(true); setError(null)
    try {
      setAccountName(name)
      // Der Schlüssel aus der Einladung legt fest, welcher Server der richtige ist (außer Grid kennt für die Adresse schon einen anderen)
      if (invite.key) {
        const known = pinnedKey(invite.server)
        if (known && known !== invite.key) throw new Error('Der Server dieser Einladung hat einen anderen Schlüssel als der, den Grid für diese Adresse kennt. Bitte beim Einladenden nachfragen.')
        pinServer(invite.server, invite.key)
      }
      await requestJoin(invite.server, invite.doc)
      props.onJoined(invite)
    } catch (e) {
      setError(e instanceof AuthError && e.kind === 'pending'
        ? 'Dein Konto ist auf diesem Server noch nicht freigegeben. Der Betreiber muss es zuerst freigeben.'
        : message(e))
    } finally { setBusy(false) }
  }
  return (
    <Modal onClose={props.onClose}>
      <form className="dialog sync-dialog" onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); void join() }} onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>Einladung annehmen</h3>
        <textarea rows={3} placeholder="grid-invite:1:…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Einladung" autoFocus />
        {parseError && <p className="sync-error" role="alert">{parseError}</p>}
        {invite && (
          <>
            <p className="invite-info">Du wirst zu <strong>„{invite.name || 'Dokument'}“</strong> eingeladen<br /><small>Server {invite.server}{invite.key && <> (Schlüssel <code>{fingerprint(invite.key)}</code>)</>}{invite.admin && <> · eingeladen von Konto <code>{invite.admin}</code></>}</small></p>
            <label className="sync-field">
              <span>Dein Name (sehen die Admins)</span>
              <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="z. B. Anna Beispiel" />
            </label>
            <p className="hint">Deine Prüfnummer: <code>{fp}</code><br />Nenne sie dem Admin, damit er dich erkennt. Er muss dich danach zulassen.</p>
          </>
        )}
        {error && <p className="sync-error" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" onClick={props.onClose}>Abbrechen</button>
          <button type="submit" className="primary" disabled={!invite || busy}>Beitritt anfragen</button>
        </div>
      </form>
    </Modal>
  )
}
