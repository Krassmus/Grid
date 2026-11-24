/**
 * Mitglieder eines Dokuments: Abfrage und Änderungen über das signierte Admin-Protokoll (siehe adminLog.ts).
 * Der Server entscheidet über den Zugriff; die Kette wird hier zusätzlich selbst geprüft.
 */
import { applyEntry, buildEntry, buildGroupEntry, emptyState, replay, type AdminEntry, type AdminState, type Level, type Role } from './adminLog'
import { getAccountName, getIdentity } from './identity'
import { authedFetch } from './syncClient'
import { t } from './i18n'

export interface JoinRequest { account: string; pub: string; name: string; time: number }

export interface MembersInfo {
  /** Rolle des angemeldeten Kontos */
  role: Role
  entries: AdminEntry[]
  /** geprüfter Stand der Kette; `null`, solange es noch kein Protokoll gibt (Dokument aus der Zeit davor) */
  state: AdminState | null
  /** offene Beitrittsanfragen (nur für Admins) */
  requests: JoinRequest[]
  /** Das Dokument ist auf dem Server als Ende-zu-Ende-verschlüsselt angelegt. */
  enc: boolean
}

const fail = async (r: Response, what: string) => {
  const text = (await r.text().catch(() => '')).trim()
  return new Error(text || t('{what}: Server antwortet mit {status}', { what, status: r.status }))
}

export async function fetchMembers(server: string, doc: string): Promise<MembersInfo> {
  const r = await authedFetch(server, `/docs/${doc}/members`)
  if (!r.ok) throw await fail(r, t('Mitglieder'))
  const b = await r.json()
  return { role: b.role, entries: b.entries, requests: b.requests, enc: !!b.enc, state: b.entries.length ? replay(doc, b.entries) : null }
}

async function post(server: string, doc: string, e: AdminEntry, enc = false) {
  const r = await authedFetch(server, `/docs/${doc}/admin`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(enc ? { 'X-Grid-Enc': '1' } : {}) }, body: JSON.stringify(e) })
  if (r.status === 409) return false // zwischendurch hat jemand anderes etwas eingetragen
  if (!r.ok) throw await fail(r, t('Eintrag'))
  return true
}

/** Hängt einen Eintrag an die aktuelle Kette an; bei Gleichzeitigkeit einmal mit dem neuen Stand wiederholen. */
async function append(server: string, doc: string, make: (state: AdminState) => AdminEntry | null): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const info = await fetchMembers(server, doc)
    const entry = make(info.state ?? emptyState())
    if (!entry) return
    applyEntry(info.state ?? emptyState(), doc, entry) // eigene Prüfung vor dem Senden
    if (await post(server, doc, entry)) return
  }
  throw new Error(t('Das Protokoll ändert sich gerade, bitte noch einmal versuchen'))
}

/** Der Ersteller eines Dokuments gründet das Protokoll (einmalig, beim ersten Verbinden). */
export async function ensureGenesis(server: string, doc: string, info: MembersInfo): Promise<boolean> {
  if (info.entries.length > 0 || info.role !== 'admin') return false
  const me = await getIdentity()
  await append(server, doc, (state) => (state.len === 0 ? buildEntry(me, state, doc, 'genesis', { id: me.id, pub: me.publicKey }, 'admin', getAccountName()) : null))
  return true
}

export async function acceptRequest(server: string, doc: string, req: JoinRequest, role: Role = 'member') {
  const me = await getIdentity()
  await append(server, doc, (state) => buildEntry(me, state, doc, 'set', { id: req.account, pub: req.pub }, role, req.name))
}

export async function setRole(server: string, doc: string, account: string, role: Role) {
  const me = await getIdentity()
  await append(server, doc, (state) => {
    const m = state.members.get(account)
    return m ? buildEntry(me, state, doc, 'set', { id: account, pub: m.pub }, role, m.name) : null
  })
}

export async function removeMember(server: string, doc: string, account: string) {
  const me = await getIdentity()
  await append(server, doc, (state) => {
    const m = state.members.get(account)
    return m ? buildEntry(me, state, doc, 'remove', { id: account, pub: m.pub }, m.role, '') : null
  })
}

export async function rejectRequest(server: string, doc: string, account: string) {
  const r = await authedFetch(server, `/docs/${doc}/join/${account}`, { method: 'DELETE' })
  if (!r.ok) throw await fail(r, t('Ablehnen'))
}

/** „Anklopfen“. Liefert `member`, wenn das Konto schon dazugehört, sonst `requested`. */
export async function requestJoin(server: string, doc: string): Promise<'member' | 'requested'> {
  const r = await authedFetch(server, `/docs/${doc}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: getAccountName() }) })
  if (r.status === 404) throw new Error(t('Dieses Dokument gibt es auf dem Server nicht (mehr)'))
  if (!r.ok) throw await fail(r, t('Beitritt'))
  return (await r.json()).status
}

/**
 * Dokument auf diesem Server anlegen. Ist das Admin-Protokoll aus einem früheren Zuhause bekannt (steht in der Datei),
 * zieht es komplett um, damit Mitglieder und Rollen bleiben; sonst gründet der Ersteller ein neues.
 */
export async function claimDocument(server: string, doc: string, localLog?: AdminEntry[], enc = false): Promise<void> {
  const me = await getIdentity()
  if (localLog && localLog.length > 0) {
    let state: AdminState
    try { state = replay(doc, localLog) } catch { throw new Error(t('Das gespeicherte Mitgliederprotokoll ist ungültig')) }
    if (state.members.get(me.id)?.role !== 'admin') {
      throw new Error(t('Das Dokument ist auf diesem Server noch nicht angelegt. Ein Admin muss es zuerst hierher umziehen.'))
    }
    const r = await authedFetch(server, `/docs/${doc}/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries: localLog }) })
    if (!r.ok) throw await fail(r, t('Umzug'))
    return
  }
  const genesis = buildEntry(me, emptyState(), doc, 'genesis', { id: me.id, pub: me.publicKey }, 'admin', getAccountName())
  if (!(await post(server, doc, genesis, enc))) throw new Error(t('Das Dokument konnte nicht angelegt werden'))
  if (enc) await markEncrypted(server, doc) // der Beschluss steht auch signiert im Protokoll (Umzug, Mitglieder)
}

/** Hält im Admin-Protokoll fest, dass das Dokument Ende-zu-Ende-verschlüsselt ist (einmalig; ein Server kann das nicht fälschen). */
export async function markEncrypted(server: string, doc: string): Promise<void> {
  const me = await getIdentity()
  await append(server, doc, (state) => (state.enc ? null : buildEntry(me, state, doc, 'encrypt', { id: me.id, pub: me.publicKey }, 'admin', '')))
}

/** Umzug auf einen anderen Server ankündigen (Eintrag im Admin-Protokoll, damit alle Mitglieder es sehen und prüfen können). */
export async function announceMove(server: string, doc: string, newServer: string, newKey: string) {
  const me = await getIdentity()
  await append(server, doc, (state) => buildEntry(me, state, doc, 'move', { id: me.id, pub: newKey }, 'admin', newServer))
}

/** Änderungen an Gruppen und Rechten (nur Admins, docs/RIGHTS.md). */
export type GroupChange =
  | { type: 'group'; group: string; name: string }
  | { type: 'ungroup'; group: string }
  | { type: 'join-group' | 'leave-group'; group: string; account: string }
  | { type: 'grant'; group: string; object: string; level: Level }

export async function changeGroups(server: string, doc: string, changes: GroupChange[]): Promise<void> {
  const me = await getIdentity()
  for (const c of changes) {
    await append(server, doc, (state) => {
      if (c.type === 'join-group' || c.type === 'leave-group') {
        const m = state.members.get(c.account)
        return m ? buildGroupEntry(me, state, doc, { ...c, pub: m.pub }) : null
      }
      return buildGroupEntry(me, state, doc, c as Exclude<GroupChange, { type: 'join-group' | 'leave-group' }>)
    })
  }
}
