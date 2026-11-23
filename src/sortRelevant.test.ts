import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addColumn, addRow, addTable, readTables, setCell } from './model'
import { sortRelevant } from './sorting'

function watch(doc: Y.Doc, f: () => void, t: string, col: string | undefined) {
  let relevant = false
  const h = (tr: Y.Transaction) => { relevant ||= sortRelevant(doc, tr, t, col) }
  doc.on('afterTransaction', h); f(); doc.off('afterTransaction', h)
  return relevant
}

describe('sortRelevant', () => {
  it('nur Änderungen an der Sortierspalte oder an den Zeilen zählen', () => {
    const doc = new Y.Doc()
    const t = addTable(doc, 'T', { firstRow: false })
    const a = readTables(doc)[0].columns[0].id
    const b = addColumn(doc, t, 'B', 'text')
    const r = addRow(doc, t)
    expect(watch(doc, () => setCell(doc, t, r, b, 'x'), t, a)).toBe(false)
    expect(watch(doc, () => setCell(doc, t, r, a, 'x'), t, a)).toBe(true)
    expect(watch(doc, () => addRow(doc, t), t, a)).toBe(true)
    expect(watch(doc, () => addColumn(doc, t, 'C', 'text'), t, a)).toBe(true)
    expect(watch(doc, () => setCell(doc, t, r, b, 'y'), t, undefined)).toBe(true)
    const other = addTable(doc, 'U', { firstRow: false })
    expect(watch(doc, () => addRow(doc, other), t, a)).toBe(false)
  })
  it('berechnete Spalten sortieren immer neu', () => {
    const doc = new Y.Doc()
    const t = addTable(doc, 'T', { firstRow: false })
    const a = readTables(doc)[0].columns[0].id
    const f = addColumn(doc, t, 'F', 'formula')
    const r = addRow(doc, t)
    expect(watch(doc, () => setCell(doc, t, r, a, 'x'), t, f)).toBe(true)
  })
})
