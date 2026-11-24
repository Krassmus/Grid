import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { ed25519 } from '@noble/curves/ed25519.js'
import { buildEntry, buildGroupEntry, emptyState, applyEntry, type AdminEntry, type AdminState } from './adminLog'
import { toHex, type Identity } from './identity'
import { addColumn, addLink, addRow, addTable, addView, createRecord, deleteRow, emptyViewDef, readTables, setCell, setColumnHidden, tablesOf, type ViewDef } from './model'
import { seal } from './signedUpdate'
import { judge, RightsTimeline } from './updateGuard'
import { allowedOptions, presetValues, rowMatches, writeBlocker } from './viewWrite'
import { columnCells, simpleCell } from './cells'

const DOC = 'd0c00000-0000-0000-0000-000000000001'
const person = (n: number): Identity => {
  const secretKey = new Uint8Array(32).fill(n)
  return { id: `aaaaaaaa-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`, secretKey, publicKey: toHex(ed25519.getPublicKey(secretKey)) }
}
const sub = (p: Identity) => ({ id: p.id, pub: p.publicKey })
const G = 'gggggggg-0000-0000-0000-000000000001'
const [A, B] = [person(1), person(2)]

/** Tabelle „Einheiten“ (Name, Typ X/Y/Z, Notiz [ausgeblendet]) mit Sicht „Nur X oder Y“; Gruppe mit Schreibrecht nur an der Sicht ab Strom 10. */
function setup(def?: (t: string, typ: string) => ViewDef, level: 'write' | 'read' = 'write') {
  const live = new Y.Doc()
  const t = addTable(live, 'Einheiten', { firstRow: false })
  const name = readTables(live).find((x) => x.id === t)!.columns[0].id
  const typ = addColumn(live, t, 'Typ', 'select', undefined, ['X', 'Y', 'Z'])
  const note = addColumn(live, t, 'Notiz', 'text')
  setColumnHidden(live, t, note, true)
  const opt = (n: string) => readTables(live).find((x) => x.id === t)!.columns.find((c) => c.id === typ)!.options!.find((o) => o.name === n)!.id
  const [X, Y_, Z] = [opt('X'), opt('Y'), opt('Z')]
  const d: ViewDef = def?.(t, typ) ?? { ...emptyViewDef(t), match: 'any', filters: [{ col: typ, op: 'eq', value: X }, { col: typ, op: 'eq', value: Y_ }] }
  const view = addView(live, 'Nur X oder Y', d)
  const rx = createRecord(live, t, { [name]: 'a', [typ]: X })
  const rz = createRecord(live, t, { [name]: 'z', [typ]: Z })
  const log: AdminEntry[] = []
  let s: AdminState = emptyState()
  const add = (e: AdminEntry, at: number) => { s = applyEntry(s, DOC, e); log.push({ ...e, at }) }
  add(buildEntry(A, s, DOC, 'genesis', sub(A), 'admin', 'Anna'), 0)
  add(buildEntry(A, s, DOC, 'set', sub(B), 'member', 'Ben'), 0)
  add(buildGroupEntry(A, s, DOC, { type: 'group', group: G, name: 'Gruppe' }), 10)
  add(buildGroupEntry(A, s, DOC, { type: 'join-group', group: G, account: B.id, pub: B.publicKey }), 10)
  add(buildGroupEntry(A, s, DOC, { type: 'grant', group: G, object: view, level }), 10)
  const timeline = new RightsTimeline(DOC, log)
  const change = (f: (d: Y.Doc) => void) => {
    const c = new Y.Doc(); Y.applyUpdate(c, Y.encodeStateAsUpdate(live))
    const sv = Y.encodeStateVector(c); f(c)
    return Y.encodeStateAsUpdate(c, sv)
  }
  /** wie der Client: Angenommenes wird anschließend angewendet */
  const ok = (u: Uint8Array, who = B) => { const v = judge(timeline, DOC, live, 15, seal(who, DOC, u)); if (v.ok) Y.applyUpdate(live, v.update); return v.ok }
  return { live, t, name, typ, note, X, Y: Y_, Z, view, rx, rz, change, ok, timeline }
}

describe('Schreiben über abgeleitete Tabellen', () => {
  it('anlegen: nur Zeilen, die schon beim Anlegen den Bedingungen genügen', () => {
    const w = setup()
    expect(w.ok(w.change((d) => { createRecord(d, w.t, { [w.name]: 'neu', [w.typ]: w.X }) }))).toBe(true)
    expect(w.ok(w.change((d) => { createRecord(d, w.t, { [w.name]: 'neu', [w.typ]: w.Y }) }))).toBe(true)
    expect(w.ok(w.change((d) => { createRecord(d, w.t, { [w.name]: 'neu', [w.typ]: w.Z }) }))).toBe(false)
    expect(w.ok(w.change((d) => { addRow(d, w.t) }))).toBe(false) // leere Zeile genügt „Typ ist X oder Y“ nicht
  })

  it('ändern: Zeile muss vorher und nachher zur Sicht gehören', () => {
    const w = setup()
    expect(w.ok(w.change((d) => { setCell(d, w.t, w.rx, w.name, 'anders') }))).toBe(true)
    expect(w.ok(w.change((d) => { setCell(d, w.t, w.rx, w.typ, w.Y) }))).toBe(true) // Bedingungsspalte ändern, solange es passt
    expect(w.ok(w.change((d) => { setCell(d, w.t, w.rx, w.typ, w.Z) }))).toBe(false) // würde die Sicht verlassen
    expect(w.ok(w.change((d) => { setCell(d, w.t, w.rz, w.name, 'anders') }))).toBe(false) // gehört nicht zur Sicht
    expect(w.ok(w.change((d) => { setCell(d, w.t, w.rz, w.typ, w.X) }))).toBe(false) // fremde Zeile nicht hereinholen
  })

  it('löschen: nur Zeilen der Sicht', () => {
    const w = setup()
    expect(w.ok(w.change((d) => { deleteRow(d, w.t, w.rx) }))).toBe(true)
    expect(w.ok(w.change((d) => { deleteRow(d, w.t, w.rz) }))).toBe(false)
  })

  it('ausgeblendete Spalten, Verknüpfungen, Reihenfolge, andere Tabellen bleiben tabu', () => {
    const w = setup()
    expect(w.ok(w.change((d) => { setCell(d, w.t, w.rx, w.note, 'geheim') }))).toBe(false)
    expect(w.ok(w.change((d) => { createRecord(d, w.t, { [w.name]: 'n', [w.typ]: w.X, [w.note]: 'geheim' }) }))).toBe(false)
    expect(w.ok(w.change((d) => { const o = tablesOf(d).get(w.t)!.get('rowOrder'); o.delete(0, 1); o.push([w.rx]) }))).toBe(false) // nur umsortieren
    expect(w.ok(w.change((d) => { const t2 = addTable(d, 'Andere'); void t2 }))).toBe(false)
    const other = w.change((d) => { setCell(d, w.t, w.rx, w.name, 'x') })
    expect(w.ok(other, A)).toBe(true) // Admin
  })

  it('nur lesen oder gruppierte Sicht genügt nicht', () => {
    expect(setup(undefined, 'read').ok(setup().change(() => undefined))).toBe(true) // leeres Update ändert nichts
    const r = setup(undefined, 'read')
    expect(r.ok(r.change((d) => { setCell(d, r.t, r.rx, r.name, 'x') }))).toBe(false)
    const g = setup((t, typ) => ({ ...emptyViewDef(t), group: { mode: 'column', col: typ } }))
    expect(g.ok(g.change((d) => { setCell(d, g.t, g.rx, g.name, 'x') }))).toBe(false)
  })

  it('Probeabbild bleibt nach Abgelehntem und Angenommenem im Gleichschritt', () => {
    const w = setup()
    const bad = w.change((d) => { createRecord(d, w.t, { [w.name]: 'bad', [w.typ]: w.Z }) })
    expect(w.ok(bad)).toBe(false)
    let id = ''
    const good = w.change((d) => { id = createRecord(d, w.t, { [w.name]: 'gut', [w.typ]: w.X }) })
    expect(w.ok(good)).toBe(true)
    Y.applyUpdate(w.live, good)
    // das nächste Update baut auf dem angenommenen auf
    const next = w.change((d) => { setCell(d, w.t, id, w.name, 'gut2') })
    expect(w.ok(next)).toBe(true)
  })

  it('Verknüpfungen und Dateien an der Tabelle verlangen Tabellenrecht', () => {
    const w = setup()
    const rel = addColumn(w.live, w.t, 'Bezug', 'relation', w.t)
    expect(w.ok(w.change((d) => { addLink(d, w.t, w.rx, rel, w.rz) }))).toBe(false)
  })
})

describe('Bedingungen für die Oberfläche', () => {
  it('writeBlocker: Relation, Rollup oder Gruppierung blockieren, einfache Spalten nicht', () => {
    const w = setup()
    const tables = readTables(w.live)
    const table = tables.find((x) => x.id === w.t)!
    expect(writeBlocker({ ...emptyViewDef(w.t) }, table, tables)).toBeNull()
    expect(writeBlocker({ ...emptyViewDef(w.t), group: { mode: 'all' } }, table, tables)).not.toBeNull()
    const rel = addColumn(w.live, w.t, 'Bezug', 'relation', w.t)
    const t2 = readTables(w.live), tb2 = t2.find((x) => x.id === w.t)!
    expect(writeBlocker({ ...emptyViewDef(w.t), filters: [{ col: rel, op: 'nempty', value: '' }] }, tb2, t2)).not.toBeNull()
  })

  it('allowedOptions und presetValues', () => {
    const w = setup()
    const tables = readTables(w.live), table = tables.find((x) => x.id === w.t)!
    const typ = table.columns.find((c) => c.id === w.typ)!
    const viewDef: ViewDef = { ...emptyViewDef(w.t), match: 'any', filters: [{ col: w.typ, op: 'eq', value: w.X }, { col: w.typ, op: 'eq', value: w.Y }] }
    expect(allowedOptions(viewDef, table, tables, typ)).toEqual([w.X, w.Y])
    expect(presetValues(viewDef, table, tables)).toEqual({}) // „eine der Bedingungen“ legt nichts fest
    const one: ViewDef = { ...emptyViewDef(w.t), filters: [{ col: w.typ, op: 'eq', value: w.X }] }
    expect(presetValues(one, table, tables)).toEqual({ [w.typ]: w.X })
    expect(rowMatches(one, table, tables, (c) => (c === w.typ ? w.X : null))).toBe(true)
    expect(rowMatches(one, table, tables, (c) => (c === w.typ ? w.Z : null))).toBe(false)
  })

  it('simpleCell stimmt mit den Zellen der Tabelle überein', () => {
    const w = setup()
    const d = new Y.Doc()
    const t = addTable(d, 'T', { firstRow: false })
    const cols = [addColumn(d, t, 'Z', 'number'), addColumn(d, t, 'D', 'date'), addColumn(d, t, 'K', 'checkbox'), addColumn(d, t, 'S', 'select', undefined, ['A', 'B'])]
    const tb = readTables(d).find((x) => x.id === t)!
    const opt = tb.columns.find((c) => c.name === 'S')!.options![1].id
    const r1 = createRecord(d, t, { [tb.columns[0].id]: 'Anna', [cols[0]]: 12.5, [cols[1]]: '2026-11-24', [cols[2]]: 1, [cols[3]]: opt })
    const r2 = createRecord(d, t, {})
    const tables = readTables(d), table = tables.find((x) => x.id === t)!
    for (const c of table.columns) for (const rid of [r1, r2]) {
      const real = columnCells(d, tables, table, c).get(rid)!
      const raw = tablesOf(d).get(t)!.get('rows').get(rid).get(c.id)
      expect(simpleCell(c, raw)).toEqual({ raw: real.raw, text: real.text, key: real.key })
    }
    void w
  })
})
