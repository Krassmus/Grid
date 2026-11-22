import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { FakeHub } from './sync'
import { addColumn, addRow, addTable, deleteRow, readTables, summarize } from './model'
import { columnCells } from './cells'

const numbers = (doc: Y.Doc, tableId: string, colId: string) => {
  const tables = readTables(doc)
  const t = tables.find((x) => x.id === tableId)!
  const cells = columnCells(doc, tables, t, t.columns.find((c) => c.id === colId)!)
  return t.rowIds.map((r) => [r, cells.get(r)!.text] as const)
}

describe('Aufsteigende Zahl', () => {
  it('nummeriert vorhandene Zeilen und neue der Reihe nach', () => {
    const doc = new Y.Doc()
    const t = addTable(doc, 'T', { firstRow: false })
    addRow(doc, t); addRow(doc, t)
    const c = addColumn(doc, t, 'Nr', 'autonumber')
    addRow(doc, t)
    expect(numbers(doc, t, c).map((x) => x[1])).toEqual(['1', '2', '3'])
  })

  it('gleichzeitig angelegte Zeilen bekommen nach dem Zusammenführen verschiedene Nummern, bei allen gleich', () => {
    const a = new Y.Doc(), b = new Y.Doc()
    const hub = new FakeHub(); hub.join('a', a); hub.join('b', b)
    const t = addTable(a, 'T', { firstRow: false })
    const c = addColumn(a, t, 'Nr', 'autonumber')
    addRow(a, t)
    hub.setOnline('a', false); hub.setOnline('b', false)
    const ra = addRow(a, t), rb = addRow(b, t)
    hub.setOnline('a', true); hub.setOnline('b', true)
    const na = numbers(a, t, c), nb = numbers(b, t, c)
    expect(na).toEqual(nb)
    expect(new Set(na.map((x) => x[1])).size).toBe(na.length)
    expect(na.map((x) => x[0]).sort()).toEqual([...new Set(na.map((x) => x[0]))].sort())
    expect([ra, rb].every((r) => na.some((x) => x[0] === r))).toBe(true)
  })

  it('eine Zeile mit späterer Marke steht hinten, auch wenn die Uhr eines Geräts nachgeht', () => {
    const doc = new Y.Doc()
    const t = addTable(doc, 'T', { firstRow: false })
    const c = addColumn(doc, t, 'Nr', 'autonumber')
    const r1 = addRow(doc, t)
    const r2 = addRow(doc, t)
    deleteRow(doc, t, r1)
    const r3 = addRow(doc, t)
    expect(numbers(doc, t, c).map((x) => x[0])).toEqual([r2, r3])
  })
})

describe('Aufsteigende Zahl in der Darstellung', () => {
  it('die Zeitmarke taucht nie als Titel oder Untertitel auf', () => {
    const doc = new Y.Doc()
    const t = addTable(doc, 'T', { firstRow: false })
    addColumn(doc, t, 'Nr', 'autonumber')
    addRow(doc, t)
    const tbl = readTables(doc)[0]
    const s = summarize(doc, tbl, tbl.rowIds[0])
    expect(s.title).toBe('Ohne Titel')
    expect(s.subs).toEqual([])
  })
})
