/** Vertrauliche Spalten (docs/RIGHTS.md): Schlüssel verteilen, ver- und entschlüsseln, Klartext ablehnen, Abgleich. */
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { ed25519 } from '@noble/curves/ed25519.js'
import { applyEntry, buildEntry, buildGroupEntry, emptyState, type AdminEntry, type AdminState } from './adminLog'
import { colKeysOf, ringOf } from './colCrypt'
import { planColumns, reconcileColumns } from './colKeys'
import { toHex, type Identity } from './identity'
import { addColumn, addTable, addView, createRecord, emptyViewDef, readTables, setCell, tablesOf } from './model'
import { seal } from './signedUpdate'
import { judge, RightsTimeline } from './updateGuard'

const DOC = 'd0c00000-0000-0000-0000-000000000001'
const person = (n: number): Identity => {
  const secretKey = new Uint8Array(32).fill(n)
  return { id: `aaaaaaaa-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`, secretKey, publicKey: toHex(ed25519.getPublicKey(secretKey)) }
}
const sub = (p: Identity) => ({ id: p.id, pub: p.publicKey })
const G = 'gggggggg-0000-0000-0000-000000000001'
const [A, B, C] = [person(1), person(2), person(3)]

/** Anna (Admin), Ben (Gruppe: Name lesen, Note lesen+schreiben), Cora (Gruppe: nur Name lesen). */
function setup() {
  const live = new Y.Doc()
  const t = addTable(live, 'Schüler', { firstRow: false })
  const name = readTables(live).find((x) => x.id === t)!.columns[0].id
  const note = addColumn(live, t, 'Note', 'number')
  const log: AdminEntry[] = []
  let s: AdminState = emptyState()
  const add = (e: AdminEntry, at: number) => { s = applyEntry(s, DOC, e); log.push({ ...e, at }) }
  const G2 = 'gggggggg-0000-0000-0000-000000000002'
  add(buildEntry(A, s, DOC, 'genesis', sub(A), 'admin', 'Anna'), 0)
  add(buildEntry(A, s, DOC, 'set', sub(B), 'member', 'Ben'), 0)
  add(buildEntry(A, s, DOC, 'set', sub(C), 'member', 'Cora'), 0)
  add(buildGroupEntry(A, s, DOC, { type: 'group', group: G, name: 'Noten' }), 10)
  add(buildGroupEntry(A, s, DOC, { type: 'group', group: G2, name: 'Lesen' }), 10)
  add(buildGroupEntry(A, s, DOC, { type: 'join-group', group: G, account: B.id, pub: B.publicKey }), 10)
  add(buildGroupEntry(A, s, DOC, { type: 'join-group', group: G2, account: C.id, pub: C.publicKey }), 10)
  add(buildGroupEntry(A, s, DOC, { type: 'grant', group: G, object: name, level: 'read' }), 10)
  add(buildGroupEntry(A, s, DOC, { type: 'grant', group: G, object: note, level: 'write' }), 10)
  add(buildGroupEntry(A, s, DOC, { type: 'grant', group: G2, object: name, level: 'read' }), 10)
  const timeline = new RightsTimeline(DOC, log)
  return { live, t, name, note, s, timeline }
}

describe('Vertrauliche Spalten', () => {
  it('Plan: geschützt wird, was nicht jedes Mitglied lesen darf; Leser sind Admins und Berechtigte', () => {
    const w = setup()
    const plan = planColumns(w.live, w.s)
    const byCol = (c: string) => plan.find((p) => p.col === c)!
    expect(byCol(w.name).wanted).toBe(false) // alle dürfen lesen
    expect(byCol(w.note).wanted).toBe(true)
    expect([...byCol(w.note).readers].sort()).toEqual([A.id, B.id].sort())
  })

  it('Plan: Bedingungsspalten einer schreibbaren Sicht bleiben Klartext; eine lesbare Sicht gibt ihre Spalten frei', () => {
    const w = setup()
    const view = addView(w.live, 'Nach Note', { ...emptyViewDef(w.t), filters: [{ col: w.note, op: 'eq', value: '1' }] })
    // Cora liest die Sicht: ihre Spalten (Name, Note) gelten als freigegeben
    let s = w.s
    s = applyEntry(s, DOC, buildGroupEntry(A, s, DOC, { type: 'grant', group: 'gggggggg-0000-0000-0000-000000000002', object: view, level: 'read' }))
    const read = planColumns(w.live, s).find((p) => p.col === w.note)!
    expect(read.readers.has(C.id)).toBe(true)
    expect(read.wanted).toBe(false)
    // Schreibrecht an der Sicht (Ben): die Bedingungsspalte bleibt Klartext
    const s2 = applyEntry(w.s, DOC, buildGroupEntry(A, w.s, DOC, { type: 'grant', group: G, object: view, level: 'write' }))
    expect(planColumns(w.live, s2).find((p) => p.col === w.note)!.wanted).toBe(false)
  })

  it('Schlüssel anlegen, für Leser verpacken, öffnen, ver- und entschlüsseln', async () => {
    const w = setup()
    const annaRing = ringOf(w.live)
    const kid = await annaRing.createKey(DOC, A, w.s, w.note, [A.id, B.id])
    const sealed = annaRing.encrypt(w.note, 4.5)
    expect(sealed).toMatch(/^gce1:/)
    expect(annaRing.decrypt(w.note, sealed)).toBe(4.5)
    // Ben und Cora bekommen dieselben Daten
    const ben = new Y.Doc(), cora = new Y.Doc()
    for (const d of [ben, cora]) Y.applyUpdate(d, Y.encodeStateAsUpdate(w.live))
    expect(await ringOf(ben).openBoxes(DOC, B, w.s)).toBe(true)
    expect(ringOf(ben).has(kid)).toBe(true)
    expect(ringOf(ben).decrypt(w.note, sealed)).toBe(4.5)
    expect(await ringOf(cora).openBoxes(DOC, C, w.s)).toBe(false) // für Cora liegt keine Kiste
    expect(ringOf(cora).locked(w.note)).toBe(true)
    expect(ringOf(cora).decrypt(w.note, sealed)).toBeNull()
    // eine Kiste von einem Nicht-Admin zählt nicht
    const fake = new Y.Doc()
    Y.applyUpdate(fake, Y.encodeStateAsUpdate(w.live))
    colKeysOf(fake).set(`${w.note}|${kid}|${C.id}`, { from: B.id, box: 'x' })
    expect(await ringOf(fake).openBoxes(DOC, C, w.s)).toBe(false)
  })

  it('Abgleich: verschlüsselt vorhandene Werte, wechselt den Schlüssel, wenn jemand nicht mehr lesen darf', async () => {
    const w = setup()
    const r1 = createRecord(w.live, w.t, { [w.name]: 'Eva', [w.note]: 2 })
    await reconcileColumns(w.live, DOC, A, w.s)
    const ring = ringOf(w.live)
    expect(ring.isProtected(w.note)).toBe(true)
    expect(ring.isProtected(w.name)).toBe(false)
    expect(tablesOf(w.live).get(w.t)!.get('rows').get(r1).get(w.note)).toMatch(/^gce1:/)
    expect(tablesOf(w.live).get(w.t)!.get('rows').get(r1).get(w.name)).toBe('Eva')
    const kid1 = ring.current(w.note)!
    expect(ring.boxedFor(w.note, kid1)).toEqual(new Set([A.id, B.id]))
    // Schreiben über die Zelle verschlüsselt
    setCell(w.live, w.t, r1, w.note, 5)
    expect(tablesOf(w.live).get(w.t)!.get('rows').get(r1).get(w.note)).toMatch(/^gce1:/)
    // Ben verliert das Leserecht an der Note: neuer Schlüssel ohne ihn, alles neu verschlüsselt
    const s2 = applyEntry(w.s, DOC, buildGroupEntry(A, w.s, DOC, { type: 'grant', group: G, object: w.note, level: 'none' }))
    await reconcileColumns(w.live, DOC, A, s2)
    const kid2 = ring.current(w.note)!
    expect(kid2).not.toBe(kid1)
    expect(ring.boxedFor(w.note, kid2)).toEqual(new Set([A.id]))
    expect(ring.kidOf(tablesOf(w.live).get(w.t)!.get('rows').get(r1).get(w.note))).toBe(kid2)
    expect(ring.decrypt(w.note, tablesOf(w.live).get(w.t)!.get('rows').get(r1).get(w.note))).toBe(5)
  })

  it('Prüfung beim Empfang: in vertrauliche Spalten darf nur Chiffretext', async () => {
    const w = setup()
    const r1 = createRecord(w.live, w.t, { [w.name]: 'Eva', [w.note]: 2 })
    await reconcileColumns(w.live, DOC, A, w.s)
    const ben = new Y.Doc()
    Y.applyUpdate(ben, Y.encodeStateAsUpdate(w.live))
    await ringOf(ben).openBoxes(DOC, B, w.s)
    const change = (d: Y.Doc, f: () => void) => { const sv = Y.encodeStateVector(d); f(); return Y.encodeStateAsUpdate(d, sv) }
    const good = change(ben, () => setCell(ben, w.t, r1, w.note, 3))
    expect(judge(w.timeline, DOC, w.live, 15, seal(B, DOC, good))).toMatchObject({ ok: true })
    const clear = change(ben, () => tablesOf(ben).get(w.t)!.get('rows').get(r1).set(w.note, 3)) // am Schutz vorbei
    expect(judge(w.timeline, DOC, w.live, 15, seal(B, DOC, clear))).toMatchObject({ ok: false })
    const bogus = change(ben, () => tablesOf(ben).get(w.t)!.get('rows').get(r1).set(w.note, 'gce1:00000000:AAAA'))
    expect(judge(w.timeline, DOC, w.live, 15, seal(B, DOC, bogus))).toMatchObject({ ok: false })
    // Schlüssel ablegen können nur Admins
    const keys = change(ben, () => colKeysOf(ben).set(`${w.note}|ffff|${B.id}`, { from: B.id, box: 'x' }))
    expect(judge(w.timeline, DOC, w.live, 15, seal(B, DOC, keys))).toMatchObject({ ok: false })
  })
})
