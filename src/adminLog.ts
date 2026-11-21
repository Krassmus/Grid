/**
 * Admin-Protokoll eines Dokuments: Kette signierter Einträge, aus der sich ergibt, wer Mitglied und wer Admin ist.
 * Dieselben Regeln prüft der Server (server/src/adminlog.rs); beide müssen dieselbe Signatur und denselben Hash
 * erzeugen (Testvektor in adminLog.test.ts und im Rust-Test `known_vector`).
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromHex, signMessage, toHex, type Identity } from './identity'

export type Role = 'admin' | 'member'
/** `move`: Umzug ankündigen (`name` = neue Server-Adresse, `subjectPub` = Schlüssel des neuen Servers, `subject` = `actor`) */
export type EntryType = 'genesis' | 'set' | 'remove' | 'move'

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
  len: number
  head: string
}

export const emptyState = (): AdminState => ({ members: new Map(), moved: null, len: 0, head: '' })

export const signingText = (e: Omit<AdminEntry, 'sig'>) =>
  ['grid-admin-v1', e.doc, String(e.seq), e.prev, e.type, e.actor, e.subject, e.subjectPub, e.role, e.name, String(e.time)].join('\n')

export const entryHash = (e: AdminEntry) => toHex(sha256(new TextEncoder().encode(`${signingText(e)}\n${e.sig}`)))

const validId = (s: string) => /^[0-9a-zA-Z-]{8,64}$/.test(s)

/** Wendet einen Eintrag an. Wirft mit einer Begründung, wenn er nicht gilt (dieselben Regeln wie auf dem Server). */
export function applyEntry(state: AdminState, doc: string, e: AdminEntry): AdminState {
  if (e.v !== 1 || e.doc !== doc) throw new Error('Eintrag gehört nicht zu diesem Dokument')
  if (e.seq !== state.len + 1) throw new Error('Nummer passt nicht')
  if (e.prev !== state.head) throw new Error('Verkettung passt nicht')
  if (e.name.length > 120 || e.name.includes('\n')) throw new Error('Name ungültig')
  if (e.role !== 'admin' && e.role !== 'member') throw new Error('Rolle ungültig')
  if (!validId(e.actor) || !validId(e.subject)) throw new Error('Kennung ungültig')
  if (!/^[0-9a-f]{64}$/.test(e.subjectPub)) throw new Error('Schlüssel ungültig')

  const members = new Map(state.members)
  let moved = state.moved
  let signer: string
  if (e.type === 'genesis') {
    if (state.len !== 0) throw new Error('Dokument hat schon einen Anfang')
    if (e.actor !== e.subject || e.role !== 'admin') throw new Error('Der Anfang gehört dem Ersteller als Admin')
    members.set(e.subject, { pub: e.subjectPub, role: 'admin', name: e.name })
    signer = e.subjectPub
  } else if (e.type === 'set' || e.type === 'remove' || e.type === 'move') {
    const actor = state.members.get(e.actor)
    if (!actor) throw new Error('Nur Mitglieder dürfen das')
    if (actor.role !== 'admin') throw new Error('Nur Admins dürfen das')
    if (e.type === 'move') {
      if (e.subject !== e.actor) throw new Error('Umzug: subject muss der Unterzeichner sein')
      if (!/^https?:\/\//.test(e.name)) throw new Error('Umzug: Server-Adresse ungültig')
      moved = { server: e.name, key: e.subjectPub }
    } else if (e.type === 'set') {
      const old = state.members.get(e.subject)
      if (old && old.pub !== e.subjectPub) throw new Error('Schlüssel passt nicht zum Mitglied')
      members.set(e.subject, { pub: e.subjectPub, role: e.role, name: e.name })
    } else if (!members.delete(e.subject)) throw new Error('Kein Mitglied')
    if (![...members.values()].some((m) => m.role === 'admin')) throw new Error('Es muss mindestens ein Admin bleiben')
    signer = actor.pub
  } else throw new Error('Unbekannter Eintragstyp')

  if (!/^[0-9a-f]{128}$/.test(e.sig) || !ed25519.verify(fromHex(e.sig), new TextEncoder().encode(signingText(e)), fromHex(signer))) {
    throw new Error('Signatur falsch')
  }
  return { members, moved, len: e.seq, head: entryHash(e) }
}

/** Spielt eine ganze Kette ab (wirft beim ersten ungültigen Eintrag). */
export const replay = (doc: string, entries: AdminEntry[]) => entries.reduce((s, e) => applyEntry(s, doc, e), emptyState())

/** Neuer, mit dem Konto unterschriebener Eintrag, der an `state` anschließt. */
export function buildEntry(
  me: Identity, state: AdminState, doc: string, type: EntryType,
  subject: { id: string; pub: string }, role: Role, name: string, time = Math.floor(Date.now() / 1000),
): AdminEntry {
  const e = { v: 1 as const, doc, seq: state.len + 1, prev: state.head, type, actor: me.id, subject: subject.id, subjectPub: subject.pub, role, name, time }
  return { ...e, sig: signMessage(me, signingText(e)) }
}
