import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addRow, addTable, addView, deleteRow, emptyViewDef, moveRow, POSITION, readTables, setCell, setTableManualSort, setTableSort, tablesOf } from './model'
import { auditOf, installAudit } from './audit'
import { buildAsOf, isVisible } from './timeTravel'
import { computeView } from './viewEngine'
import { createUndoManager } from './undo'
import { rightsFor } from './rights'
import { judgeViaViews } from './viewJudge'
import { scopeOf } from './updateScope'

function setup(names = ['A', 'B', 'C', 'D']) {
  const doc = new Y.Doc()
  const table = addTable(doc, 'Aufgaben', { firstRow: false })
  const name = readTables(doc)[0].columns[0].id
  const ids = names.map((n) => { const r = addRow(doc, table); setCell(doc, table, r, name, n); return r })
  const info = () => readTables(doc)[0]
  const order = () => info().rowIds.map((r) => tablesOf(doc).get(table)!.get('rows').get(r).get(name)).join('')
  return { doc, table, name, ids, info, order }
}
const clone = (doc: Y.Doc) => { const c = new Y.Doc(); Y.applyUpdate(c, Y.encodeStateAsUpdate(doc)); return c }
const sync = (a: Y.Doc, b: Y.Doc) => { Y.applyUpdate(b, Y.encodeStateAsUpdate(a)); Y.applyUpdate(a, Y.encodeStateAsUpdate(b)) }

describe('Manuelle Reihenfolge', () => {
  it('verschiebt Zeilen und hängt neue unten an', () => {
    const { doc, table, ids: [a, , c, d], name, order, info } = setup()
    setTableManualSort(doc, table)
    expect(info().manual).toBe(true)
    expect(order()).toBe('ABCD')
    moveRow(doc, table, d, a)
    expect(order()).toBe('DABC')
    moveRow(doc, table, a, null)
    expect(order()).toBe('DBCA')
    const e = addRow(doc, table)
    setCell(doc, table, e, name, 'E')
    expect(order()).toBe('DBCAE')
    moveRow(doc, table, e, c)
    expect(order()).toBe('DBECA')
    const f = addRow(doc, table)
    setCell(doc, table, f, name, 'F')
    expect(order()).toBe('DBECAF')
  })
  it('ändert beim Verschieben nur die eine Zeile, sobald alle eine Position haben', () => {
    const { doc, table, ids: [a, b, c, d] } = setup()
    setTableManualSort(doc, table, [a, b, c, d])
    const changed: string[] = []
    tablesOf(doc).get(table)!.get('rows').observeDeep((events: Y.YEvent<any>[]) => events.forEach((e) => changed.push(String(e.path[0]))))
    moveRow(doc, table, d, b)
    expect(changed).toEqual([d])
  })
  it('beginnt mit der gerade gezeigten Reihenfolge und merkt sich die eigene', () => {
    const { doc, table, ids: [a, b, c, d], name, order } = setup()
    setTableSort(doc, table, name, 'desc')
    setTableManualSort(doc, table, [d, c, b, a])
    expect(order()).toBe('DCBA')
    moveRow(doc, table, a, d)
    setTableSort(doc, table, name, 'asc')
    expect(order()).toBe('ABCD') // ohne „Manuell“ gilt die Reihenfolge des Anlegens
    setTableManualSort(doc, table, [a, b, c, d])
    expect(order()).toBe('ADCB')
  })
  it('verträgt sehr viele Einfügungen an derselben Stelle', () => {
    const { doc, table, ids: [a, b, c, d], order } = setup()
    setTableManualSort(doc, table, [a, b, c, d])
    for (let i = 0; i < 200; i++) moveRow(doc, table, i % 2 ? c : d, i % 2 ? d : c)
    expect(order()).toBe('ABCD')
  })
  it('verliert und verdoppelt keine Zeile, wenn zwei Geräte gleichzeitig umsortieren', () => {
    const { doc, table, ids: [a, , c, d] } = setup()
    setTableManualSort(doc, table)
    const other = clone(doc)
    moveRow(doc, table, d, a)
    moveRow(other, table, d, c)
    sync(doc, other)
    const x = readTables(doc)[0].rowIds
    expect(x).toEqual(readTables(other)[0].rowIds)
    expect(new Set(x).size).toBe(4)
    expect(x).toHaveLength(4)
  })
  it('gilt auch in abgeleiteten Tabellen', () => {
    const { doc, table, ids: [a, , , d] } = setup()
    const view = addView(doc, 'Alle', emptyViewDef(table))
    setTableManualSort(doc, table)
    moveRow(doc, table, d, a)
    expect(computeView(doc, { ...emptyViewDef(table) }).rows[0].id).toBe(d)
    expect(view).toBeTruthy()
  })
  it('lässt sich rückgängig machen und löschen', () => {
    const { doc, table, ids: [a, , , d], order } = setup()
    setTableManualSort(doc, table)
    const undo = createUndoManager(doc)
    moveRow(doc, table, d, a)
    undo.undo()
    expect(order()).toBe('ABCD')
    deleteRow(doc, table, a)
    expect(order()).toBe('BCD')
  })
  it('erscheint nicht als Zelländerung im Protokoll, stimmt aber in der Zeitreise', async () => {
    const { doc, table, ids: [a, , , d], order } = setup()
    setTableManualSort(doc, table)
    installAudit(doc)
    const before = Date.now()
    await new Promise((r) => setTimeout(r, 5))
    moveRow(doc, table, d, a)
    expect(order()).toBe('DABC')
    expect(auditOf(doc).toArray().filter(isVisible)).toEqual([])
    const past = buildAsOf(doc, before).doc
    expect(readTables(past)[0].rowIds[0]).toBe(a)
  })
  it('darf nur umsortieren, wer die ganze Tabelle schreiben darf', () => {
    const { doc, table, name, ids: [a, , , d] } = setup()
    setTableManualSort(doc, table, readTables(doc)[0].rowIds)
    const mine = clone(doc)
    const updates: Uint8Array[] = []
    mine.on('update', (u: Uint8Array) => updates.push(u))
    moveRow(mine, table, d, a)
    const columnOnly = { ...rightsFor(null, ''), active: true, admin: false, access: () => 'none' as const, colAccess: (_t: string, c: string) => (c === name ? 'write' as const : 'none' as const) }
    const scope = scopeOf(doc, updates[0])
    expect([...scope.cells.get(table)!.get(d)!]).toEqual([POSITION])
    expect(judgeViaViews(doc, updates[0], scope, [table], columnOnly)).toBeTruthy()
  })
})
