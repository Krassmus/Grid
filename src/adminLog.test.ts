import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { applyEntry, buildEntry, buildGroupEntry, emptyState, entryHash, replay } from './adminLog'
import { rightsFor } from './rights'
import { toHex, type Identity } from './identity'

const DOC = 'd0c00000-0000-0000-0000-000000000001'
const person = (n: number): Identity => {
  const secretKey = new Uint8Array(32).fill(n)
  return { id: `aaaaaaaa-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`, secretKey, publicKey: toHex(ed25519.getPublicKey(secretKey)) }
}
const sub = (p: Identity) => ({ id: p.id, pub: p.publicKey })
const T = 1_700_000_000

describe('Admin-Protokoll', () => {
  it('erzeugt dieselbe Signatur und denselben Hash wie der Server (Testvektor)', () => {
    const a = person(1)
    const e = buildEntry(a, emptyState(), DOC, 'genesis', sub(a), 'admin', 'Anna', T)
    expect(e.sig).toBe('6e8b04c65ba83556eb4d627cda89d4f63bc14418feb4c6f1a5b0e676f0c0dbcddcf4aacf444d6bd5c45595cf2981efb295162c1c38adb01acebbe549bcfd190b')
    expect(entryHash(e)).toBe('dcda78d27c72cca9a6ea023cb83a5ff3fbf6da46b6346f62c65878ddc6d5c9d3')
  })

  it('spielt eine Kette aus Admins und Mitgliedern ab', () => {
    const [a, b, c] = [person(1), person(2), person(3)]
    let s = emptyState()
    const add = (signer: Identity, type: 'genesis' | 'set' | 'remove', who: Identity, role: 'admin' | 'member', name = '') => {
      const e = buildEntry(signer, s, DOC, type, sub(who), role, name, T)
      s = applyEntry(s, DOC, e)
      return e
    }
    const log = [add(a, 'genesis', a, 'admin', 'Anna'), add(a, 'set', b, 'member', 'Ben'), add(a, 'set', b, 'admin', 'Ben'), add(b, 'set', c, 'member', 'Cora')]
    expect(replay(DOC, log).members.size).toBe(3)
    expect(s.members.get(b.id)?.role).toBe('admin')
    log.push(add(b, 'remove', a, 'admin'))
    expect([...replay(DOC, log).members.keys()].sort()).toEqual([b.id, c.id].sort())
  })

  it('lehnt Fälschungen und Regelverstöße ab', () => {
    const [a, b, c] = [person(1), person(2), person(3)]
    const s0 = emptyState()
    const s1 = applyEntry(s0, DOC, buildEntry(a, s0, DOC, 'genesis', sub(a), 'admin', 'Anna', T))
    const s2 = applyEntry(s1, DOC, buildEntry(a, s1, DOC, 'set', sub(b), 'member', 'Ben', T))
    // Mitglieder dürfen nichts ändern
    expect(() => applyEntry(s2, DOC, buildEntry(b, s2, DOC, 'set', sub(c), 'member', 'Cora', T))).toThrow('Nur Admins')
    // Fremde schon gar nicht
    expect(() => applyEntry(s2, DOC, buildEntry(c, s2, DOC, 'set', sub(c), 'admin', 'Cora', T))).toThrow('Nur Mitglieder')
    // Verfälschter Inhalt
    const forged = { ...buildEntry(a, s1, DOC, 'set', sub(b), 'member', 'Ben', T), role: 'admin' as const }
    expect(() => applyEntry(s1, DOC, forged)).toThrow('Signatur falsch')
    // Letzter Admin bleibt
    expect(() => applyEntry(s2, DOC, buildEntry(a, s2, DOC, 'remove', sub(a), 'admin', '', T))).toThrow('mindestens ein Admin')
    // Verkettung
    expect(() => applyEntry(s1, DOC, { ...buildEntry(a, s1, DOC, 'set', sub(b), 'member', 'Ben', T), prev: 'x' })).toThrow('Verkettung')
    // Schlüssel eines Mitglieds lässt sich nicht austauschen
    expect(() => applyEntry(s2, DOC, buildEntry(a, s2, DOC, 'set', { id: b.id, pub: person(9).publicKey }, 'member', 'Ben', T))).toThrow('Schlüssel passt nicht')
  })

  it('kündigt einen Umzug an, ohne Mitglieder zu ändern', () => {
    const [a, b] = [person(1), person(2)]
    const s0 = emptyState()
    const s1 = applyEntry(s0, DOC, buildEntry(a, s0, DOC, 'genesis', sub(a), 'admin', 'Anna', T))
    const s2 = applyEntry(s1, DOC, buildEntry(a, s1, DOC, 'set', sub(b), 'member', 'Ben', T))
    const key = person(9).publicKey
    const s3 = applyEntry(s2, DOC, buildEntry(a, s2, DOC, 'move', { id: a.id, pub: key }, 'admin', 'https://neu.example/grid', T))
    expect(s3.moved).toEqual({ server: 'https://neu.example/grid', key })
    expect(s3.members).toEqual(s2.members)
    expect(() => applyEntry(s3, DOC, buildEntry(b, s3, DOC, 'move', { id: b.id, pub: key }, 'member', 'https://evil.example', T))).toThrow('Nur Admins')
    expect(() => applyEntry(s3, DOC, buildEntry(a, s3, DOC, 'move', { id: a.id, pub: key }, 'admin', 'ftp://x', T))).toThrow('Server-Adresse')
  })

  it('hält die Verschlüsselung fest: nur Admins, nur einmal, nur für sich selbst', () => {
    const [a, b] = [person(1), person(2)]
    let s = replay(DOC, [])
    const g = buildEntry(a, s, DOC, 'genesis', sub(a), 'admin', 'Anna', T)
    s = applyEntry(s, DOC, g)
    const m = buildEntry(a, s, DOC, 'set', sub(b), 'member', 'Ben', T)
    s = applyEntry(s, DOC, m)
    expect(s.enc).toBe(false)
    expect(() => applyEntry(s, DOC, buildEntry(b, s, DOC, 'encrypt', sub(b), 'admin', '', T))).toThrow() // kein Admin
    expect(() => applyEntry(s, DOC, buildEntry(a, s, DOC, 'encrypt', sub(b), 'admin', '', T))).toThrow() // fremdes subject
    s = applyEntry(s, DOC, buildEntry(a, s, DOC, 'encrypt', sub(a), 'admin', '', T))
    expect(s.enc).toBe(true)
    expect(s.members.size).toBe(2) // Mitglieder unverändert
    expect(() => applyEntry(s, DOC, buildEntry(a, s, DOC, 'encrypt', sub(a), 'admin', '', T))).toThrow() // schon verschlüsselt
  })

  it('jedes Mitglied darf sich selbst entfernen, andere nur Admins, und der letzte Admin bleibt', () => {
    const [a, b, c] = [person(1), person(2), person(3)]
    let s = emptyState()
    s = applyEntry(s, DOC, buildEntry(a, s, DOC, 'genesis', sub(a), 'admin', 'Anna', T))
    s = applyEntry(s, DOC, buildEntry(a, s, DOC, 'set', sub(b), 'member', 'Ben', T))
    s = applyEntry(s, DOC, buildEntry(a, s, DOC, 'set', sub(c), 'member', 'Cleo', T))
    expect(() => applyEntry(s, DOC, buildEntry(b, s, DOC, 'remove', sub(c), 'member', '', T))).toThrow() // Ben darf Cleo nicht entfernen
    expect(() => applyEntry(s, DOC, buildEntry(a, s, DOC, 'remove', sub(a), 'admin', '', T))).toThrow() // der einzige Admin bleibt
    s = applyEntry(s, DOC, buildEntry(b, s, DOC, 'remove', sub(b), 'member', '', T)) // Ben verlässt das Dokument
    expect([...s.members.keys()]).toEqual([a.id, c.id])
  })
})

describe('Gruppen und Rechte', () => {
  const [a, b, c] = [person(1), person(2), person(3)]
  const G1 = 'gggggggg-0000-0000-0000-000000000001', G2 = 'gggggggg-0000-0000-0000-000000000002'
  const build = () => {
    let s = emptyState()
    const log: ReturnType<typeof buildEntry>[] = []
    const add = (e: ReturnType<typeof buildEntry>) => { s = applyEntry(s, DOC, e); log.push(e) }
    add(buildEntry(a, s, DOC, 'genesis', sub(a), 'admin', 'Anna', T))
    add(buildEntry(a, s, DOC, 'set', sub(b), 'member', 'Ben', T))
    add(buildEntry(a, s, DOC, 'set', sub(c), 'member', 'Cora', T))
    const g = (c: Parameters<typeof buildGroupEntry>[3]) => add(buildGroupEntry(a, s, DOC, c, T))
    return { get s() { return s }, log, g }
  }

  it('legt Gruppen an, ordnet Mitglieder zu und vergibt Rechte', () => {
    const w = build()
    w.g({ type: 'group', group: G1, name: 'Redaktion' })
    w.g({ type: 'group', group: G2, name: 'Gäste' })
    w.g({ type: 'join-group', group: G1, account: b.id, pub: b.publicKey })
    w.g({ type: 'join-group', group: G2, account: b.id, pub: b.publicKey })
    w.g({ type: 'grant', group: G1, object: 'tab00001', level: 'write' })
    w.g({ type: 'grant', group: G2, object: 'tab00001', level: 'read' })
    w.g({ type: 'grant', group: G2, object: 'tab00002', level: 'read' })
    const s = replay(DOC, w.log)
    expect([...s.groups.values()]).toEqual(['Redaktion', 'Gäste'])
    expect(rightsFor(s, b.id).access('tab00001')).toBe('write') // höchste Stufe der Gruppen
    expect(rightsFor(s, b.id).access('tab00002')).toBe('read')
    expect(rightsFor(s, b.id).access('tab00003')).toBe('none')
    expect(rightsFor(s, b.id).structure).toBe(false)
    expect(rightsFor(s, c.id).access('tab00001')).toBe('none') // ohne Gruppe nichts
    expect(rightsFor(s, a.id)).toMatchObject({ admin: true, structure: true })
    expect(rightsFor(s, a.id).access('irgendwas')).toBe('write')
  })

  it('vor der ersten Gruppe gilt wie bisher alles für alle; ohne Protokoll ebenso', () => {
    const w = build()
    expect(rightsFor(w.s, b.id)).toMatchObject({ active: false, structure: true })
    expect(rightsFor(w.s, b.id).access('x')).toBe('write')
    expect(rightsFor(null, b.id).access('x')).toBe('write')
  })

  it('Rechte entfallen mit Austritt aus der Gruppe, Löschen der Gruppe, Entfernen des Mitglieds und Stufe „none“', () => {
    const w = build()
    w.g({ type: 'group', group: G1, name: 'Redaktion' })
    w.g({ type: 'join-group', group: G1, account: b.id, pub: b.publicKey })
    w.g({ type: 'grant', group: G1, object: 'tab00001', level: 'write' })
    expect(rightsFor(w.s, b.id).access('tab00001')).toBe('write')
    w.g({ type: 'grant', group: G1, object: 'tab00001', level: 'none' })
    expect(rightsFor(w.s, b.id).access('tab00001')).toBe('none')
    w.g({ type: 'grant', group: G1, object: 'tab00001', level: 'read' })
    w.g({ type: 'leave-group', group: G1, account: b.id, pub: b.publicKey })
    expect(rightsFor(w.s, b.id).access('tab00001')).toBe('none')
    w.g({ type: 'join-group', group: G1, account: b.id, pub: b.publicKey })
    w.g({ type: 'ungroup', group: G1 })
    expect(w.s.groups.size).toBe(0)
    expect(w.s.grants.size).toBe(0)
    expect(rightsFor(w.s, b.id).active).toBe(false) // keine Gruppe mehr: wieder wie bisher
  })

  it('ein entferntes Mitglied verliert seine Gruppen; Unstimmiges bewirkt nichts', () => {
    const w = build()
    w.g({ type: 'group', group: G1, name: 'Redaktion' })
    w.g({ type: 'join-group', group: G1, account: b.id, pub: b.publicKey })
    w.g({ type: 'join-group', group: G2, account: c.id, pub: c.publicKey }) // unbekannte Gruppe
    w.g({ type: 'grant', group: G2, object: 'tab00001', level: 'read' }) // unbekannte Gruppe
    expect(w.s.memberGroups.get(c.id)).toBeUndefined()
    expect(w.s.grants.size).toBe(0)
    w.log.push(buildEntry(a, w.s, DOC, 'remove', sub(b), 'member', '', T))
    expect(replay(DOC, w.log).memberGroups.has(b.id)).toBe(false)
  })

  it('nur Admins dürfen Gruppen verwalten; Format wird geprüft', () => {
    const w = build()
    const bad = buildGroupEntry(b, w.s, DOC, { type: 'group', group: G1, name: 'Hack' }, T)
    expect(() => applyEntry(w.s, DOC, bad)).toThrow()
    expect(() => applyEntry(w.s, DOC, buildGroupEntry(a, w.s, DOC, { type: 'group', group: G1, name: '   ' }, T))).toThrow()
    expect(() => applyEntry(w.s, DOC, buildEntry(a, w.s, DOC, 'grant', { id: G1, pub: '0'.repeat(64) }, 'member', 'tab00001|admin', T))).toThrow()
    expect(() => applyEntry(w.s, DOC, buildEntry(a, w.s, DOC, 'join-group', sub(b), 'member', 'x', T))).toThrow()
  })
})
