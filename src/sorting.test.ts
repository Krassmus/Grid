import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addColumn, addFile, addLink, addRow, addTable, readTables, setCell } from './model'
import { sortedRowIds } from './sorting'

function setup() {
  const doc = new Y.Doc()
  const t = addTable(doc, 'T', { firstRow: false })
  const name = addColumn(doc, t, 'Name', 'text')
  return { doc, t, name }
}
const rowsWith = (doc: Y.Doc, t: string, col: string, values: (string | number | null)[]) =>
  values.map((v) => { const r = addRow(doc, t); if (v !== null) setCell(doc, t, r, col, v); return r })

describe('Sortieren', () => {
  it('Text: aufsteigend, absteigend, Leere immer hinten, natürliche Zahlen', () => {
    const { doc, t, name } = setup()
    const [b, a, e, n10, n2] = rowsWith(doc, t, name, ['bär', 'Apfel', null, 'x10', 'x2'])
    expect(sortedRowIds(doc, t, name, 'asc')).toEqual([a, b, n2, n10, e])
    expect(sortedRowIds(doc, t, name, 'desc')).toEqual([n10, n2, b, a, e])
  })
  it('Zahl und Datum', () => {
    const { doc, t } = setup()
    const num = addColumn(doc, t, 'Z', 'number')
    const [r1, r2, r3] = rowsWith(doc, t, num, [10, 2, null])
    expect(sortedRowIds(doc, t, num, 'asc')).toEqual([r2, r1, r3])
    const d = addColumn(doc, t, 'D', 'date')
    setCell(doc, t, r1, d, '2026-12-01'); setCell(doc, t, r2, d, '2026-11-17T14:30'); setCell(doc, t, r3, d, '2026-11-17')
    expect(sortedRowIds(doc, t, d, 'asc')).toEqual([r3, r2, r1])
  })
  it('Checkbox: nicht angehakt zuerst, dann angehakt', () => {
    const { doc, t, name } = setup()
    const box = addColumn(doc, t, 'Erledigt', 'checkbox')
    const [r1, r2, r3] = rowsWith(doc, t, name, ['1', '2', '3'])
    setCell(doc, t, r2, box, 1)
    expect(sortedRowIds(doc, t, box, 'asc')).toEqual([r1, r3, r2])
    expect(sortedRowIds(doc, t, box, 'desc')).toEqual([r2, r1, r3])
  })
  it('Relation nach Titel der ersten Verknüpfung, Datei nach Dateiname', () => {
    const { doc, t, name } = setup()
    const other = addTable(doc, 'Ziel', { firstRow: false })
    const oname = readTables(doc).find((x) => x.id === other)!.columns[0].id // die automatisch angelegte Spalte „Name“
    const [z1, z2] = rowsWith(doc, other, oname, ['Zebra', 'Affe'])
    const rel = addColumn(doc, t, 'Rel', 'relation', other)
    const [r1, r2, r3] = rowsWith(doc, t, name, ['1', '2', '3'])
    addLink(doc, t, r1, rel, z1); addLink(doc, t, r2, rel, z2)
    expect(sortedRowIds(doc, t, rel, 'asc')).toEqual([r2, r1, r3])
    const file = addColumn(doc, t, 'Datei', 'file')
    addFile(doc, t, r1, file, { hash: 'h1', name: 'a.png', size: 1, mime: 'image/png' })
    addFile(doc, t, r2, file, { hash: 'h2', name: 'b.png', size: 1, mime: 'image/png' })
    expect(sortedRowIds(doc, t, file, 'desc')).toEqual([r2, r1, r3])
  })
})
