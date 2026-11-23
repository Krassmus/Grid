import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addColumn, addRow, addTable, deleteRow, readTables, setCell, setColumnConfig } from './model'
import { columnCells, newCtx } from './cells'

const text = (doc: Y.Doc, tableId: string, colId: string) => {
  const tables = readTables(doc), t = tables.find((x) => x.id === tableId)!
  const m = columnCells(doc, tables, t, t.columns.find((c) => c.id === colId)!, newCtx())
  return t.rowIds.map((r) => m.get(r)!.text)
}

describe('Zwischenspeicher der Spaltenwerte', () => {
  it('folgt Änderungen an Zellen, Zeilen und Spalten', () => {
    const doc = new Y.Doc()
    const t = addTable(doc, 'T', { firstRow: false })
    const a = readTables(doc)[0].columns[0].id
    const n = addColumn(doc, t, 'N', 'number')
    const r1 = addRow(doc, t), r2 = addRow(doc, t)
    setCell(doc, t, r1, a, 'eins'); setCell(doc, t, r2, a, 'zwei'); setCell(doc, t, r1, n, 3)
    expect(text(doc, t, a)).toEqual(['eins', 'zwei'])
    expect(text(doc, t, n)).toEqual(['3', ''])
    setCell(doc, t, r2, a, 'zwo'); setCell(doc, t, r2, n, 4.5)
    expect(text(doc, t, a)).toEqual(['eins', 'zwo'])
    expect(text(doc, t, n)).toEqual(['3', '4.5'])
    const r3 = addRow(doc, t); setCell(doc, t, r3, a, 'drei')
    expect(text(doc, t, a)).toEqual(['eins', 'zwo', 'drei'])
    deleteRow(doc, t, r1)
    expect(text(doc, t, a)).toEqual(['zwo', 'drei'])
    expect(text(doc, t, n)).toEqual(['4.5', ''])
  })
  it('alte Ergebnisse bleiben nach einer Änderung unverändert, Rückgängig stimmt', () => {
    const doc = new Y.Doc()
    const t = addTable(doc, 'T', { firstRow: false })
    const a = readTables(doc)[0].columns[0].id
    const r = addRow(doc, t); setCell(doc, t, r, a, 'x')
    const tables = readTables(doc)
    const before = columnCells(doc, tables, tables[0], tables[0].columns[0], newCtx())
    setCell(doc, t, r, a, 'y')
    expect(before.get(r)!.text).toBe('x')
    expect(text(doc, t, a)).toEqual(['y'])
    const other = new Y.Doc(); Y.applyUpdate(other, Y.encodeStateAsUpdate(doc))
    expect(text(other, t, a)).toEqual(['y'])
    const u = Y.encodeStateAsUpdate(doc); setCell(doc, t, r, a, 'z'); text(doc, t, a)
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(other))); expect(text(other, t, a)).toEqual(['z'])
    expect(u.length).toBeGreaterThan(0)
  })
  it('Einstellung einer Spalte (Dezimalstellen) wirkt sofort', () => {
    const doc = new Y.Doc()
    const t = addTable(doc, 'T', { firstRow: false })
    const n = addColumn(doc, t, 'N', 'number'); const r = addRow(doc, t); setCell(doc, t, r, n, 1.234)
    expect(text(doc, t, n)).toEqual(['1.234'])
    setColumnConfig(doc, t, n, 'decimals', 1)
    expect(text(doc, t, n)).toEqual(['1.2'])
  })
})

import { orderByKeys, sortedRowIds } from './sorting'
import { cellDelta } from './cells'

describe('schrittweises Sortieren', () => {
  it('liefert dieselbe Reihenfolge wie vollständiges Sortieren (Zufallstest mit Gleichständen und leeren Zellen)', () => {
    let seed = 7
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
    const doc = new Y.Doc()
    const t = addTable(doc, 'T', { firstRow: false })
    const a = readTables(doc)[0].columns[0].id
    const n = addColumn(doc, t, 'N', 'number')
    const rows = Array.from({ length: 60 }, () => addRow(doc, t))
    rows.forEach((r) => { if (rnd(4)) setCell(doc, t, r, n, rnd(10)); setCell(doc, t, r, a, 'z' + rnd(10)) })
    for (const dir of ['asc', 'desc'] as const) sortedRowIds(doc, t, n, dir)
    let incremental = 0
    for (let step = 0; step < 200; step++) {
      for (let k = 0; k <= rnd(3); k++) setCell(doc, t, rows[rnd(rows.length)], n, rnd(5) ? rnd(10) : null)
      for (const dir of ['asc', 'desc'] as const) {
        const got = sortedRowIds(doc, t, n, dir)
        const tables = readTables(doc), table = tables[0], col = table.columns.find((c) => c.id === n)!
        const cells = columnCells(doc, tables, table, col, newCtx())
        if (cellDelta(cells)) incremental++
        const full = orderByKeys(table.rowIds, new Map(table.rowIds.map((id) => [id, cells.get(id)?.key ?? null])), dir)
        expect(got).toEqual(full)
      }
    }
    expect(incremental).toBeGreaterThan(0)
  })
})
