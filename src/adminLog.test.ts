import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { applyEntry, buildEntry, emptyState, entryHash, replay } from './adminLog'
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
})
