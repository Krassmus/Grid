import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addColumn, addTable, readTables } from './model'
import { hiddenByRights } from './rightsView'

function setup() {
  const doc = new Y.Doc()
  const a = addTable(doc, 'Gruppen', { firstRow: false })
  const b = addTable(doc, 'Personen', { firstRow: false })
  const rel = addColumn(doc, a, 'Mitglieder', 'relation', b)
  addColumn(doc, b, 'Helfer', 'number')
  const roll = addColumn(doc, a, 'Summe Helfer', 'rollup', undefined, undefined, { rel, col: readTables(doc).find((t) => t.id === b)!.columns[0].id, fn: 'count', sep: ', ' })
  const f1 = addColumn(doc, a, 'Formel', 'formula', undefined, undefined, { expr: 'ANZAHL({{Mitglieder}}) + 1' })
  const f2 = addColumn(doc, a, 'Text', 'template', undefined, undefined, { tpl: 'Es sind {{ {{Summe Helfer}} }} Leute' })
  const f3 = addColumn(doc, a, 'Harmlos', 'formula', undefined, undefined, { expr: '1 + 1' })
  return { doc, a, b, rel, roll, f1, f2, f3 }
}

describe('Spalten ohne Leserecht an der Zieltabelle', () => {
  it('blendet Relationen, Rollups und darauf aufbauende Formeln aus', () => {
    const w = setup()
    const tables = readTables(w.doc)
    const A = tables.find((t) => t.id === w.a)!
    const hidden = hiddenByRights(A, [A]) // Personen nicht lesbar
    expect([...hidden].sort()).toEqual([w.rel, w.roll, w.f1, w.f2].sort())
    expect(hidden.has(w.f3)).toBe(false)
  })

  it('blendet nichts aus, wenn die Zieltabelle lesbar ist', () => {
    const w = setup()
    const tables = readTables(w.doc)
    expect(hiddenByRights(tables.find((t) => t.id === w.a)!, tables).size).toBe(0)
  })
})
