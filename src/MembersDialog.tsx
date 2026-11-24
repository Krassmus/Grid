import { useEffect, useState } from 'react'
import { Modal } from './Modal'
import { GroupsDialog } from './GroupsDialog'
import { Avatar } from './Avatar'
import { fingerprint, getAccountName, getIdentity, setAccountName } from './identity'
import { Field as ProfileField } from './SyncDialog'
import { parseInvite, type Invite } from './invite'
import { requestJoin } from './members'
import { AuthError, pinServer, pinnedKey } from './syncClient'
import type { Role } from './adminLog'
import type { GroupChange, JoinRequest, MembersInfo } from './members'
import { t } from './i18n'

/** Was die Oberfläche über die Mitglieder des Dokuments wissen und tun darf. */
export interface MembersControl {
  members: MembersInfo | null
  /** Namen und Avatare, die die Mitglieder in das Dokument eingetragen haben (Konto-ID → Profil) */
  profiles?: Record<string, { name: string; avatar: string }>
  accept: (req: JoinRequest, role?: Role) => Promise<void>
  reject: (account: string) => Promise<void>
  remove: (account: string) => Promise<void>
  changeRole: (account: string, role: Role) => Promise<void>
  changeGroups: (changes: GroupChange[]) => Promise<void>
  invite: () => Promise<string>
  /** Tabellen, abgeleitete Tabellen und Karten des Dokuments (für die Rechte) */
  objects?: { id: string; name: string; kind: 'table' | 'view' | 'map' }[]
}

const message = (e: unknown) => String((e as Error).message ?? e)
const who = (name: string) => name || t('Ohne Namen')

/** Mitglieder verwalten: Anfragen zulassen oder ablehnen, Rollen ändern, Mitglieder entfernen, Einladung erzeugen. */
export function MembersDialog(props: { control: MembersControl; onClose: () => void }) {
  const { members } = props.control
  const [me, setMe] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [invite, setInvite] = useState('')
  const [inviting, setInviting] = useState(false)
  const [copied, setCopied] = useState(false)
  const [open, setOpen] = useState<string | null>(null) // Mitglied, dessen Aktionen aufgeklappt sind
  const [removing, setRemoving] = useState<string | null>(null)
  const [groupsOpen, setGroupsOpen] = useState(false)
  useEffect(() => { void getIdentity().then((i) => setMe(i.id)).catch(() => {}) }, [])
  const admin = members?.role === 'admin'
  const act = async (f: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await f() } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  const list = members?.state ? [...members.state.members.entries()] : []
  const requests = admin ? members?.requests ?? [] : []
  const admins = list.filter(([, m]) => m.role === 'admin').length
  if (groupsOpen) return <GroupsDialog control={props.control} onClose={() => setGroupsOpen(false)} />
  return (
    <Modal onClose={props.onClose}>
      <div className="dialog sync-dialog members-dialog cloud-dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>{t('Mitglieder')}</h3>
        {!members && <p className="cloud-lead">{t('Wird geladen …')}</p>}
        {members && !members.state && <p className="cloud-lead">{t('Die Mitgliederliste wird beim nächsten Verbinden angelegt.')}</p>}

        {requests.length > 0 && (
          <section className="member-requests">
            <h4>{t('Möchten beitreten')}</h4>
            {requests.map((r) => (
              <div key={r.account} className="member-card request">
                <Avatar name={r.name} size={36} />
                <div className="member-who"><strong>{who(r.name)}</strong><small>{t('Prüfnummer')} <code>{fingerprint(r.pub)}</code></small></div>
                <span className="member-actions">
                  <button type="button" disabled={busy} onClick={() => void act(() => props.control.reject(r.account))}>{t('Ablehnen')}</button>
                  <button type="button" className="primary" disabled={busy} onClick={() => void act(() => props.control.accept(r))}>{t('Zulassen')}</button>
                </span>
              </div>
            ))}
            <p className="cloud-note">{t('Vergleiche die Prüfnummer mit der, die die Person in Grid sieht (am besten am Telefon), bevor du zulässt.')}</p>
          </section>
        )}

        {(list.length > 0 || admin) && (
          <section className="member-list">
            {list.map(([id, m]) => {
              const mine = id === me
              const name = m.name || props.control.profiles?.[id]?.name || ''
              const onlyAdmin = mine && m.role === 'admin' && admins === 1
              const hasMenu = mine || admin // das eigene Konto kann jeder verlassen; andere verwalten nur Admins
              return (
                <div key={id} className={`member-item${open === id ? ' open' : ''}`}>
                  <div className="member-line">
                    <Avatar name={name} avatar={props.control.profiles?.[id]?.avatar} size={36} />
                    <div className="member-who">
                      <strong>{who(name)}{mine && <span className="you"> {t('· du')}</span>}</strong>
                      <small><code>{fingerprint(m.pub)}</code></small>
                    </div>
                    <span className={`chip role ${m.role}`}>{m.role === 'admin' ? t('Admin') : t('Mitglied')}</span>
                    {hasMenu && (
                      <button type="button" className="more" aria-label={t('Aktionen für {name}', { name: who(name) })} aria-expanded={open === id}
                        onClick={() => { setOpen(open === id ? null : id); setRemoving(null) }}>⋯</button>
                    )}
                  </div>
                  {hasMenu && open === id && (
                    <div className="member-more">
                      {removing === id
                        ? <>
                            <span>{mine ? t('Dieses Dokument wirklich verlassen? Es bleibt auf diesem Gerät, wird aber nicht mehr mit dem Server abgeglichen.') : t('{name} wirklich entfernen?', { name: who(name) })}</span>
                            <span className="member-actions">
                              <button type="button" onClick={() => setRemoving(null)}>{t('Abbrechen')}</button>
                              <button type="button" className="danger" disabled={busy} onClick={() => { setRemoving(null); setOpen(null); void act(async () => { await props.control.remove(id); if (mine) props.onClose() }) }}>{mine ? t('Verlassen') : t('Entfernen')}</button>
                            </span>
                          </>
                        : onlyAdmin
                        ? <span className="hint">{t('Du bist der einzige Admin. Ernenne zuerst jemand anderen zum Admin, um das Dokument zu verlassen.')}</span>
                        : <>
                            {!mine ? (
                              <button type="button" className="linklike" disabled={busy} onClick={() => void act(() => props.control.changeRole(id, m.role === 'admin' ? 'member' : 'admin'))}>
                                {m.role === 'admin' ? t('Zum Mitglied machen') : t('Zum Admin machen')}
                              </button>
                            ) : <span />}
                            <button type="button" className="linklike danger-text" disabled={busy} onClick={() => setRemoving(id)}>{mine ? t('Verlassen') : t('Entfernen')}</button>
                          </>}
                    </div>
                  )}
                </div>
              )
            })}
            {admin && (
              <div className={`member-item invite${inviting ? ' open' : ''}`}>
                <button type="button" className="member-line invite-row" disabled={busy && !inviting} aria-expanded={inviting}
                  onClick={() => { if (inviting) { setInviting(false); return } setInviting(true); setCopied(false); setInvite(''); void act(async () => setInvite(await props.control.invite())) }}>
                  <span className="plus-avatar" aria-hidden>+</span>
                  <span className="member-who"><strong>{t('Person einladen')}</strong><small>{t('Erzeugt einen Einladungstext zum Weitergeben')}</small></span>
                </button>
                {inviting && (
                  <div className="member-invite">
                    {invite
                      ? <>
                          <textarea readOnly rows={3} value={invite} onFocus={(e) => e.target.select()} aria-label={t('Einladung')} />
                          <p>{t('Schicke den Text der Person. Sie fügt ihn in Grid unter „Einladung annehmen“ ein und klopft damit an; hier erscheint dann ihre Anfrage.')}</p>
                          <div className="actions"><button type="button" className="primary" onClick={() => { void navigator.clipboard?.writeText(invite); setCopied(true) }}>{copied ? t('Kopiert') : t('Kopieren')}</button></div>
                        </>
                      : <p>{t('Wird erzeugt …')}</p>}
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {admin && members?.state && (
          <button type="button" className="member-line groups-row" onClick={() => setGroupsOpen(true)}>
            <span className="member-who"><strong>{t('Gruppen und Rechte …')}</strong><small>{members.state.groups.size === 0 ? t('Noch keine Gruppen: alle dürfen alles') : t('{n} Gruppen', { n: members.state.groups.size })}</small></span>
            <span className="chev" aria-hidden>›</span>
          </button>
        )}
        {error && <p className="sync-error" role="alert">{error}</p>}
        <div className="actions"><button type="button" className="primary" onClick={props.onClose}>{t('Fertig')}</button></div>
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
      if (name.trim() && !getAccountName()) setAccountName(name) // einmalig fürs Konto, nicht je Dokument
      // Der Schlüssel aus der Einladung legt fest, welcher Server der richtige ist (außer Grid kennt für die Adresse schon einen anderen)
      if (invite.key) {
        const known = pinnedKey(invite.server)
        if (known && known !== invite.key) throw new Error(t('Der Server dieser Einladung hat einen anderen Schlüssel als der, den Grid für diese Adresse kennt. Bitte beim Einladenden nachfragen.'))
        pinServer(invite.server, invite.key)
      }
      await requestJoin(invite.server, invite.doc)
      props.onJoined(invite)
    } catch (e) {
      setError(e instanceof AuthError && e.kind === 'pending'
        ? t('Dein Konto ist auf diesem Server noch nicht freigegeben. Der Betreiber muss es zuerst freigeben.')
        : message(e))
    } finally { setBusy(false) }
  }
  return (
    <Modal onClose={props.onClose}>
      <form className="dialog sync-dialog cloud-dialog" onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); void join() }} onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>{t('Einladung annehmen')}</h3>
        <textarea rows={3} placeholder={t('grid-invite:1:…')} value={text} onChange={(e) => setText(e.target.value)} aria-label={t('Einladung')} autoFocus />
        {parseError && <p className="sync-error" role="alert">{parseError}</p>}
        {invite && (
          <>
            <p className="invite-info">{t('Du wirst zu')} <strong>„{invite.name || t('Dokument')}“</strong> {t('eingeladen')}<br /><small>{t('Server')} {invite.server}{invite.key && <> ({t('Schlüssel')} <code>{fingerprint(invite.key)}</code>)</>}{invite.admin && <> · {t('eingeladen von Konto')} <code>{invite.admin}</code></>}</small></p>
            {getAccountName()
              ? <p className="hint">{t('Du trittst als')} <strong>{getAccountName()}</strong> {t('bei (Name und Bild änderst du unter „Konto“).')}</p>
              : <ProfileField label={t('Dein Name (sehen die Admins; gilt künftig für alle Dokumente)')} value={name} onChange={setName} placeholder={t('z. B. Anna Beispiel')} />}
            <p className="hint">{t('Deine Prüfnummer:')} <code>{fp}</code><br />{t('Nenne sie dem Admin, damit er dich erkennt. Er muss dich danach zulassen.')}</p>
          </>
        )}
        {error && <p className="sync-error" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" onClick={props.onClose}>{t('Abbrechen')}</button>
          <button type="submit" className="primary" disabled={!invite || busy}>{t('Beitritt anfragen')}</button>
        </div>
      </form>
    </Modal>
  )
}
