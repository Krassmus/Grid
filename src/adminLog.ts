/**
 * Admin-Protokoll eines Dokuments: Kette signierter Einträge, aus der sich ergibt, wer Mitglied und wer Admin ist.
 * Dieselben Regeln prüft der Server (server/src/adminlog.rs); beide müssen dieselbe Signatur und denselben Hash
 * erzeugen (Testvektor in adminLog.test.ts und im Rust-Test `known_vector`).
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromHex, signMessage, toHex, type Identity } from './identity'
import { t } from './i18n'

export type Role = 'admin' | 'member'
/** `encrypt`: Dokument als Ende-zu-Ende-verschlüsselt festlegen (`subject` = `actor`, einmalig; docs/E2E.md).
 * `move`: Umzug ankündigen (`name` = neue Server-Adresse, `subjectPub` = Schlüssel des neuen Servers, `subject` = `actor`) */
export type EntryType = 'genesis' | 'set' | 'remove' | 'move' | 'encrypt' | GroupEntryType
/** Rechte (docs/RIGHTS.md), nur von Admins:
 * `group`: Gruppe anlegen oder umbenennen (`subject` = Gruppen-ID, `name` = Name, `role` = `member`, `subjectPub` = 64 Nullen).
 * `ungroup`: Gruppe löschen (`subject` = Gruppen-ID).
 * `join-group` / `leave-group`: `subject` = Konto, `name` = Gruppen-ID.
 * `grant`: `subject` = Gruppen-ID, `name` = `<Objekt-ID>|<Stufe>`. */
export type GroupEntryType = 'group' | 'ungroup' | 'join-group' | 'leave-group' | 'grant'
const GROUP_TYPES: readonly string[] = ['group', 'ungroup', 'join-group', 'leave-group', 'grant']
/** Stufe einer Gruppe an einer Tabelle, Sicht oder Karte (`none` steht nur im Eintrag und löscht das Recht). */
export type Level = 'none' | 'read' | 'write'
export const NO_KEY = '0'.repeat(64)

export interface AdminEntry {
  v: 1
  doc: string
  seq: number
  prev: string
  type: EntryType
  actor: string
  subject: string
  subjectPub: string
  role: Role
  name: string
  time: number
  sig: string
}

export interface Member { pub: string; role: Role; name: string }
export interface AdminState {
  members: Map<string, Member>
  /** zuletzt angekündigter Umzug */
  moved: { server: string; key: string } | null
  /** Ein Admin hat das Dokument als verschlüsselt festgelegt */
  enc: boolean
  /** Gruppen: ID → Name */
  groups: Map<string, string>
  /** Konto → Gruppen, in denen es ist */
  memberGroups: Map<string, Set<string>>
  /** Gruppe → (Objekt-ID → `read` | `write`); fehlt der Eintrag, gibt es keinen Zugriff */
  grants: Map<string, Map<string, 'read' | 'write'>>
  len: number
  head: string
}

export const emptyState = (): AdminState => ({ members: new Map(), moved: null, enc: false, groups: new Map(), memberGroups: new Map(), grants: new Map(), len: 0, head: '' })

export const signingText = (e: Omit<AdminEntry, 'sig'>) =>
  ['grid-admin-v1', e.doc, String(e.seq), e.prev, e.type, e.actor, e.subject, e.subjectPub, e.role, e.name, String(e.time)].join('\n')

export const entryHash = (e: AdminEntry) => toHex(sha256(new TextEncoder().encode(`${signingText(e)}\n${e.sig}`)))

const validId = (s: string) => /^[0-9a-zA-Z-]{8,64}$/.test(s)

/** Wendet einen Eintrag an. Wirft mit einer Begründung, wenn er nicht gilt (dieselben Regeln wie auf dem Server). */
export function applyEntry(state: AdminState, doc: string, e: AdminEntry): AdminState {
  if (e.v !== 1 || e.doc !== doc) throw new Error(t('Eintrag gehört nicht zu diesem Dokument'))
  if (e.seq !== state.len + 1) throw new Error(t('Nummer passt nicht'))
  if (e.prev !== state.head) throw new Error(t('Verkettung passt nicht'))
  if (e.name.length > 120 || e.name.includes('\n')) throw new Error(t('Name ungültig'))
  if (e.role !== 'admin' && e.role !== 'member') throw new Error(t('Rolle ungültig'))
  if (!validId(e.actor) || !validId(e.subject)) throw new Error(t('Kennung ungültig'))
  if (!/^[0-9a-f]{64}$/.test(e.subjectPub)) throw new Error(t('Schlüssel ungültig'))

  const members = new Map(state.members)
  const groups = new Map(state.groups)
  const memberGroups = new Map([...state.memberGroups].map(([k, v]) => [k, new Set(v)]))
  const grants = new Map([...state.grants].map(([k, v]) => [k, new Map(v)]))
  let moved = state.moved
  let enc = state.enc
  let signer: string
  if (e.type === 'genesis') {
    if (state.len !== 0) throw new Error(t('Dokument hat schon einen Anfang'))
    if (e.actor !== e.subject || e.role !== 'admin') throw new Error(t('Der Anfang gehört dem Ersteller als Admin'))
    members.set(e.subject, { pub: e.subjectPub, role: 'admin', name: e.name })
    signer = e.subjectPub
  } else if (e.type === 'set' || e.type === 'remove' || e.type === 'move' || e.type === 'encrypt' || GROUP_TYPES.includes(e.type)) {
    const actor = state.members.get(e.actor)
    if (!actor) throw new Error(t('Nur Mitglieder dürfen das'))
    // Jedes Mitglied darf sich selbst entfernen (verlassen); alles andere dürfen nur Admins
    const leaving = e.type === 'remove' && e.subject === e.actor
    if (actor.role !== 'admin' && !leaving) throw new Error(t('Nur Admins dürfen das'))
    if (e.type === 'move') {
      if (e.subject !== e.actor) throw new Error(t('Umzug: subject muss der Unterzeichner sein'))
      if (!/^https?:\/\//.test(e.name)) throw new Error(t('Umzug: Server-Adresse ungültig'))
      moved = { server: e.name, key: e.subjectPub }
    } else if (e.type === 'encrypt') {
      if (e.subject !== e.actor || e.subjectPub !== actor.pub) throw new Error(t('Verschlüsseln: subject muss der Unterzeichner sein'))
      if (state.enc) throw new Error(t('Das Dokument ist schon verschlüsselt'))
      enc = true
    } else if (GROUP_TYPES.includes(e.type)) {
      // Das Format prüfen Server und Client gleich; Unstimmiges (unbekannte Gruppe, Konto ohne Mitgliedschaft) bewirkt nichts, damit eine Kette nie unlesbar wird
      if (actor.role !== 'admin') throw new Error(t('Nur Admins dürfen das'))
      if (e.type === 'group') {
        if (e.role !== 'member' || e.subjectPub !== NO_KEY || !e.name.trim()) throw new Error(t('Gruppe ungültig'))
        groups.set(e.subject, e.name)
      } else if (e.type === 'ungroup') {
        groups.delete(e.subject)
        grants.delete(e.subject)
        for (const g of memberGroups.values()) g.delete(e.subject)
      } else if (e.type === 'join-group' || e.type === 'leave-group') {
        if (!validId(e.name)) throw new Error(t('Gruppe ungültig'))
        if (e.type === 'join-group') {
          if (groups.has(e.name) && members.has(e.subject)) memberGroups.set(e.subject, (memberGroups.get(e.subject) ?? new Set()).add(e.name))
        } else memberGroups.get(e.subject)?.delete(e.name)
      } else {
        const m = /^([0-9a-zA-Z-]{8,64})\|(none|read|write)$/.exec(e.name)
        if (!m) throw new Error(t('Recht ungültig'))
        if (groups.has(e.subject)) {
          const g = grants.get(e.subject) ?? new Map()
          if (m[2] === 'none') g.delete(m[1]); else g.set(m[1], m[2] as 'read' | 'write')
          grants.set(e.subject, g)
        }
      }
    } else if (e.type === 'set') {
      const old = state.members.get(e.subject)
      if (old && old.pub !== e.subjectPub) throw new Error(t('Schlüssel passt nicht zum Mitglied'))
      members.set(e.subject, { pub: e.subjectPub, role: e.role, name: e.name })
    } else if (!members.delete(e.subject)) throw new Error(t('Kein Mitglied'))
    else memberGroups.delete(e.subject)
    if (![...members.values()].some((m) => m.role === 'admin')) throw new Error(t('Es muss mindestens ein Admin bleiben'))
    signer = actor.pub
  } else throw new Error(t('Unbekannter Eintragstyp'))

  if (!/^[0-9a-f]{128}$/.test(e.sig) || !ed25519.verify(fromHex(e.sig), new TextEncoder().encode(signingText(e)), fromHex(signer))) {
    throw new Error(t('Signatur falsch'))
  }
  return { members, moved, enc, groups, memberGroups, grants, len: e.seq, head: entryHash(e) }
}

/** Spielt eine ganze Kette ab (wirft beim ersten ungültigen Eintrag). */
export const replay = (doc: string, entries: AdminEntry[]) => entries.reduce((s, e) => applyEntry(s, doc, e), emptyState())

/** Eintrag für eine Gruppenänderung (nur Admins); die Felder sind je Typ belegt wie bei `GroupEntryType` beschrieben. */
export function buildGroupEntry(
  me: Identity, state: AdminState, doc: string,
  c: { type: 'group'; group: string; name: string } | { type: 'ungroup'; group: string }
    | { type: 'join-group' | 'leave-group'; group: string; account: string; pub: string }
    | { type: 'grant'; group: string; object: string; level: Level },
  time = Math.floor(Date.now() / 1000),
): AdminEntry {
  switch (c.type) {
    case 'group': return buildEntry(me, state, doc, 'group', { id: c.group, pub: NO_KEY }, 'member', c.name.trim().slice(0, 60), time)
    case 'ungroup': return buildEntry(me, state, doc, 'ungroup', { id: c.group, pub: NO_KEY }, 'member', '', time)
    case 'join-group': case 'leave-group': return buildEntry(me, state, doc, c.type, { id: c.account, pub: c.pub }, 'member', c.group, time)
    case 'grant': return buildEntry(me, state, doc, 'grant', { id: c.group, pub: NO_KEY }, 'member', `${c.object}|${c.level}`, time)
  }
}

/** Neuer, mit dem Konto unterschriebener Eintrag, der an `state` anschließt. */
export function buildEntry(
  me: Identity, state: AdminState, doc: string, type: EntryType,
  subject: { id: string; pub: string }, role: Role, name: string, time = Math.floor(Date.now() / 1000),
): AdminEntry {
  const e = { v: 1 as const, doc, seq: state.len + 1, prev: state.head, type, actor: me.id, subject: subject.id, subjectPub: subject.pub, role, name, time }
  return { ...e, sig: signMessage(me, signingText(e)) }
}
