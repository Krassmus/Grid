/** Rechte je Spalte (docs/RIGHTS.md): Schreiben nur in Spalten mit Schreibrecht, Anlegen mit erlaubten Spalten, kein Löschen, Sichtbarkeit. */
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { ed25519 } from '@noble/curves/ed25519.js'
import { applyEntry, buildEntry, buildGroupEntry, emptyState, type AdminEntry, type AdminState, type Level } from './adminLog'
import { toHex, type Identity } from './identity'
import { addColumn, addLink, addRow, addTable, createRecord, deleteRow, readTables, setCell, tablesOf } from './model'
import { rightsFor } from './rights'
import { hiddenByRights } from './rightsView'
import { seal } from './signedUpdate'
import { judge, RightsTimeline } from './updateGuard'

const DOC = 'd0c00000-0000-0000-0000-000000000001'
const person = (n: number): Identity => {
  const secretKey = new Uint8Array(32).fill(n)
  return { id: `aaaaaaaa-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`, secretKey, publicKey: toHex(ed25519.getPublicKey(secretKey)) }
}
const sub = (p: Identity) => ({ id: p.id, pub: p.publicKey })
const G = 'gggggggg-0000-0000-0000-000000000001'
const [A, B] = [person(1), person(2)]

/** Tabelle „Schüler“ (Name, Note Physik, Note Mathe, Bezug auf „Kurse“); Gruppe: Name schreiben, Note Physik lesen, sonst nichts. */
function setup(extra: (t: string, cols: Record<string, string>) => { object: string; level: Level }[] = () => []) {
  const live = new Y.Doc()
  const t = addTable(live, 'Schüler', { firstRow: false })
  const kurse = addTable(live, 'Kurse', { firstRow: false })
  const name = readTables(live).find((x) => x.id === t)!.columns[0].id
  const physik = addColumn(live, t, 'Note Physik', 'number')
  const mathe = addColumn(live, t, 'Note Mathe', 'number')
  const bezug = addColumn(live, t, 'Kurse', 'relation', kurse)
  const kname = readTables(live).find((x) => x.id === kurse)!.columns[0].id
  const r1 = createRecord(live, t, { [name]: 'Eva', [physik]: 2 })
  const r2 = createRecord(live, t, { [name]: 'Max', [physik]: 3 })
  const k1 = createRecord(live, kurse, { [kname]: 'Chor' })
  const cols = { name, physik, mathe, bezug }
  const log: AdminEntry[] = []
  let s: AdminState = emptyState()
  const add = (e: AdminEntry, at: number) => { s = applyEntry(s, DOC, e); log.push({ ...e, at }) }
  add(buildEntry(A, s, DOC, 'genesis', sub(A), 'admin', 'Anna'), 0)
  add(buildEntry(A, s, DOC, 'set', sub(B), 'member', 'Ben'), 0)
  add(buildGroupEntry(A, s, DOC, { type: 'group', group: G, name: 'Gruppe' }), 10)
  add(buildGroupEntry(A, s, DOC, { type: 'join-group', group: G, account: B.id, pub: B.publicKey }), 10)
  add(buildGroupEntry(A, s, DOC, { type: 'grant', group: G, object: name, level: 'write' }), 10)
  add(buildGroupEntry(A, s, DOC, { type: 'grant', group: G, object: physik, level: 'read' }), 10)
  for (const g of extra(t, cols)) add(buildGroupEntry(A, s, DOC, { type: 'grant', group: G, object: g.object, level: g.level }), 10)
  const timeline = new RightsTimeline(DOC, log)
  const change = (f: (d: Y.Doc) => void) => {
    const c = new Y.Doc(); Y.applyUpdate(c, Y.encodeStateAsUpdate(live))
    const sv = Y.encodeStateVector(c); f(c)
    return Y.encodeStateAsUpdate(c, sv)
  }
  const ok = (u: Uint8Array) => { const v = judge(timeline, DOC, live, 15, seal(B, DOC, u)); if (v.ok) Y.applyUpdate(live, v.update); return v.ok }
  return { live, t, kurse, k1, ...cols, r1, r2, s, change, ok }
}

describe('Rechte je Spalte: Schreiben', () => {
  it('ändern: nur in Spalten mit Schreibrecht', () => {
    const w = setup()
    expect(w.ok(w.change((d) => setCell(d, w.t, w.r1, w.name, 'Eva K.')))).toBe(true)
    expect(w.ok(w.change((d) => setCell(d, w.t, w.r1, w.physik, 1)))).toBe(false) // nur lesen
    expect(w.ok(w.change((d) => setCell(d, w.t, w.r1, w.mathe, 1)))).toBe(false) // kein Zugriff
    expect(w.ok(w.change((d) => { setCell(d, w.t, w.r1, w.name, 'X'); setCell(d, w.t, w.r1, w.mathe, 1) }))).toBe(false) // eine unerlaubte Spalte genügt
  })

  it('anlegen geht mit erlaubten Spalten, löschen nicht, Umsortieren nicht', () => {
    const w = setup()
    expect(w.ok(w.change((d) => createRecord(d, w.t, { [w.name]: 'Neu' })))).toBe(true)
    expect(w.ok(w.change((d) => addRow(d, w.t)))).toBe(true) // leere Zeile
    expect(w.ok(w.change((d) => createRecord(d, w.t, { [w.name]: 'Neu', [w.mathe]: 4 })))).toBe(false)
    expect(w.ok(w.change((d) => deleteRow(d, w.t, w.r2)))).toBe(false)
    expect(w.ok(w.change((d) => { const o = tablesOf(d).get(w.t)!.get('rowOrder'); const id = o.get(0); o.delete(0, 1); o.push([id]) }))).toBe(false)
  })

  it('Verknüpfungen brauchen Schreibrecht an der Relationsspalte', () => {
    const w = setup()
    expect(w.ok(w.change((d) => addLink(d, w.t, w.r1, w.bezug, w.k1)))).toBe(false)
    const v = setup((t, c) => [{ object: c.bezug, level: 'write' }])
    expect(v.ok(v.change((d) => addLink(d, v.t, v.r1, v.bezug, v.k1)))).toBe(true)
    expect(v.ok(v.change((d) => setCell(d, v.t, v.r1, v.mathe, 1)))).toBe(false)
  })

  it('Tabelle lesen plus Spalte schreiben: die höhere Stufe gilt', () => {
    const w = setup((t, c) => [{ object: t, level: 'read' }, { object: c.mathe, level: 'write' }])
    expect(w.ok(w.change((d) => setCell(d, w.t, w.r1, w.mathe, 5)))).toBe(true)
    expect(w.ok(w.change((d) => setCell(d, w.t, w.r1, w.physik, 5)))).toBe(false)
    expect(w.ok(w.change((d) => deleteRow(d, w.t, w.r2)))).toBe(false)
  })

  it('volles Schreibrecht an der Tabelle bleibt unberührt', () => {
    const w = setup((t) => [{ object: t, level: 'write' }])
    expect(w.ok(w.change((d) => { setCell(d, w.t, w.r1, w.mathe, 1); deleteRow(d, w.t, w.r2) }))).toBe(true)
  })

  it('Struktur bleibt Admin-Sache, auch mit Spaltenrechten', () => {
    const w = setup()
    expect(w.ok(w.change((d) => addColumn(d, w.t, 'Neu', 'text')))).toBe(false)
  })
})

describe('Rechte je Spalte: Sicht', () => {
  it('Stufen, Sichtbarkeit und Anlegen', () => {
    const w = setup()
    const r = rightsFor(w.s, B.id)
    const ids = readTables(w.live).find((x) => x.id === w.t)!.columns.map((c) => c.id)
    expect(r.access(w.t)).toBe('none')
    expect(r.colAccess(w.t, w.name)).toBe('write')
    expect(r.colAccess(w.t, w.physik)).toBe('read')
    expect(r.colAccess(w.t, w.mathe)).toBe('none')
    expect(r.visible(w.t, ids)).toBe(true)
    expect(r.visible(w.kurse, [])).toBe(false)
    expect(r.canAdd(w.t, ids)).toBe(true)
    const lesen = rightsFor(setup((_t, c) => []).s, B.id)
    expect(lesen.canAdd(w.kurse, [])).toBe(false)
    expect(rightsFor(w.s, A.id).colAccess(w.t, w.mathe)).toBe('write')
  })

  it('Spalten ohne Leserecht verschwinden samt dem, was auf ihnen aufbaut', () => {
    const doc = new Y.Doc()
    const a = addTable(doc, 'Schüler', { firstRow: false })
    const b = addTable(doc, 'Kurse', { firstRow: false })
    const note = addColumn(doc, a, 'Note', 'number')
    const f = addColumn(doc, a, 'Doppelt', 'formula', undefined, undefined, { expr: '{{Note}} * 2' })
    const rel = addColumn(doc, b, 'Teilnehmer', 'relation', a)
    const roll = addColumn(doc, b, 'Summe', 'rollup', undefined, undefined, { rel, col: note, fn: 'sum', sep: ', ' })
    const tables = readTables(doc)
    const unreadable = new Set([note])
    expect([...hiddenByRights(tables.find((x) => x.id === a)!, tables, unreadable)].sort()).toEqual([note, f].sort())
    expect([...hiddenByRights(tables.find((x) => x.id === b)!, tables, unreadable)]).toEqual([roll])
  })
})
