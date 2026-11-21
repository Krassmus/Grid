import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addColumn, addLink, addRow, addTable, buildLinkIndex, readTables, setColumnConfig } from './model'
import { allowsMultiTarget, targetAvailable } from './relationRules'

describe('Zieldatensatz mehrfach verknüpfbar', () => {
  function setup() {
    const doc = new Y.Doc()
    const a = addTable(doc, 'A', { firstRow: false }), b = addTable(doc, 'B', { firstRow: false })
    const col = addColumn(doc, a, 'Bezug', 'relation', b)
    const a1 = addRow(doc, a), a2 = addRow(doc, a), b1 = addRow(doc, b), b2 = addRow(doc, b)
    addLink(doc, a, a1, col, b1)
    const column = () => readTables(doc).find((t) => t.id === a)!.columns.find((c) => c.id === col)!
    return { doc, a, col, a1, a2, b1, b2, column }
  }

  it('standardmäßig aus: ein Ziel, auf das schon eine andere Zeile verweist, ist nicht mehr frei', () => {
    const s = setup()
    const idx = buildLinkIndex(s.doc)
    expect(allowsMultiTarget(s.column())).toBe(false)
    expect(targetAvailable(idx, s.column(), s.b1, [s.a2])).toBe(false) // a1 verweist darauf
    expect(targetAvailable(idx, s.column(), s.b2, [s.a2])).toBe(true)
  })

  it('die eigene Zeile oder die Quelle einer Verschiebung zählt nicht', () => {
    const s = setup()
    const idx = buildLinkIndex(s.doc)
    expect(targetAvailable(idx, s.column(), s.b1, [s.a1])).toBe(true) // a1 selbst
    expect(targetAvailable(idx, s.column(), s.b1, [s.a2, s.a1])).toBe(true) // Verschieben von a1 nach a2
  })

  it('Verknüpfungen gelöschter Zeilen blockieren nicht', () => {
    const s = setup()
    expect(targetAvailable(buildLinkIndex(s.doc), s.column(), s.b1, [s.a2], (r) => r !== s.a1)).toBe(true)
  })

  it('mit der Einstellung ist alles erlaubt', () => {
    const s = setup()
    setColumnConfig(s.doc, s.a, s.col, 'multiTarget', true)
    expect(allowsMultiTarget(s.column())).toBe(true)
    expect(targetAvailable(buildLinkIndex(s.doc), s.column(), s.b1, [s.a2])).toBe(true)
  })
})
