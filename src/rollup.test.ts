import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addColumn, addLink, addRow, addTable, readTables, setCell } from './model'
import { columnCells, footerText } from './cells'
import { sortedRowIds } from './sorting'
import { effectiveType } from './columnTypes'

/** Einsatzgebiete (EAL 1, EAL 2, EAL 3) mit Gruppen, die Führer/Unterführer/Helfer zählen. */
function setup() {
  const doc = new Y.Doc()
  const gebiete = addTable(doc, 'Einsatzgebiete', { firstRow: false })
  const gruppen = addTable(doc, 'Gruppen', { firstRow: false })
  const name = (t: string) => readTables(doc).find((x) => x.id === t)!.columns[0].id
  const fuehrer = addColumn(doc, gruppen, 'Führer', 'number')
  const helfer = addColumn(doc, gruppen, 'Helfer', 'number')
  const rel = addColumn(doc, gebiete, 'Gruppen', 'relation', gruppen)
  const g = [[1, 14], [2, 3], [null, null]].map(([f, h]) => {
    const r = addRow(doc, gruppen)
    if (f !== null) { setCell(doc, gruppen, r, fuehrer, f); setCell(doc, gruppen, r, helfer, h!) }
    return r
  })
  const e = ['EAL 1', 'EAL 2', 'EAL 3'].map((n) => { const r = addRow(doc, gebiete); setCell(doc, gebiete, r, name(gebiete), n); return r })
  addLink(doc, gebiete, e[0], rel, g[0]); addLink(doc, gebiete, e[0], rel, g[1]); addLink(doc, gebiete, e[1], rel, g[2])
  const sumF = addColumn(doc, gebiete, 'Σ Führer', 'rollup', undefined, [], { rel, col: fuehrer, fn: 'sum' })
  const sumH = addColumn(doc, gebiete, 'Σ Helfer', 'rollup', undefined, [], { rel, col: helfer, fn: 'sum' })
  const tables = () => readTables(doc)
  const gebietTable = () => tables().find((t) => t.id === gebiete)!
  const cells = (col: string) => columnCells(doc, tables(), gebietTable(), gebietTable().columns.find((c) => c.id === col)!)
  return { doc, gebiete, gruppen, e, sumF, sumH, fuehrer, rel, cells, tables, gebietTable }
}

describe('Rollup', () => {
  it('summiert die Werte der verknüpften Zeilen', () => {
    const s = setup()
    const c = s.cells(s.sumF)
    expect(s.e.map((r) => c.get(r)!.text)).toEqual(['3', '0', '0'])
    expect(s.e.map((r) => s.cells(s.sumH).get(r)!.key)).toEqual([17, 0, 0])
  })
  it('folgt Änderungen: Wert und Verknüpfung', () => {
    const s = setup()
    const g = s.tables().find((t) => t.id === s.gruppen)!
    setCell(s.doc, s.gruppen, g.rowIds[0], s.fuehrer, 10)
    expect(s.cells(s.sumF).get(s.e[0])!.text).toBe('12')
    addLink(s.doc, s.gebiete, s.e[2], s.rel, g.rowIds[1])
    expect(s.cells(s.sumF).get(s.e[2])!.text).toBe('2')
  })
  it('kann Minimum, Verketten und Anzahl', () => {
    const s = setup()
    const set = (col: string, cfg: Record<string, unknown>) =>
      Object.entries(cfg).forEach(([k, v]) => s.doc.getMap<Y.Map<any>>('tables').get(s.gebiete)!.get('cols').get(col)!.set('cfg.' + k, v))
    set(s.sumF, { fn: 'max' })
    expect(s.cells(s.sumF).get(s.e[0])!.text).toBe('2')
    set(s.sumF, { fn: 'count' })
    expect(s.e.map((r) => s.cells(s.sumF).get(r)!.text)).toEqual(['2', '0', '0'])
    set(s.sumF, { fn: 'concat', sep: ' / ' })
    expect(s.cells(s.sumF).get(s.e[0])!.text).toBe('1 / 2')
  })
  it('ist leer bei fehlender Relation oder Spalte und hat effektiven Typ', () => {
    const s = setup()
    const broken = addColumn(s.doc, s.gebiete, 'kaputt', 'rollup')
    expect([...s.cells(broken).values()].every((c) => c.text === '')).toBe(true)
    const col = s.gebietTable().columns.find((c) => c.id === s.sumF)!
    expect(effectiveType(col, s.tables())).toBe('number')
  })
  it('lässt sich sortieren', () => {
    const s = setup()
    expect(sortedRowIds(s.doc, s.gebiete, s.sumF, 'desc')[0]).toBe(s.e[0])
  })
  it('Rollup über Rollup und Zyklen brechen nicht ab', () => {
    const s = setup()
    // Zyklus: Rollup auf sich selbst über die eigene Relation
    const self = addColumn(s.doc, s.gebiete, 'Selbst', 'relation', s.gebiete)
    const loop = addColumn(s.doc, s.gebiete, 'Schleife', 'rollup', undefined, [], { rel: self, col: '', fn: 'sum' })
    s.doc.getMap<Y.Map<any>>('tables').get(s.gebiete)!.get('cols').get(loop)!.set('cfg.col', loop)
    addLink(s.doc, s.gebiete, s.e[0], self, s.e[1])
    expect(() => s.cells(loop)).not.toThrow()
  })
})

describe('Summenzeile', () => {
  it('wertet Summe, Durchschnitt, Minimum, Maximum, Anzahl und Leere aus', () => {
    const s = setup()
    const c = [...s.cells(s.sumH).values()]
    const col = s.gebietTable().columns.find((x) => x.id === s.sumH)!
    expect(footerText(c, col, 'sum')).toBe('17')
    expect(footerText(c, col, 'avg')).toBe('5.67')
    expect(footerText(c, col, 'max')).toBe('17')
    expect(footerText(c, col, 'min')).toBe('0')
    expect(footerText(c, col, 'count')).toBe('3')
  })
  it('Checkbox: Angehakte und Anteil', () => {
    const doc = new Y.Doc()
    const t = addTable(doc, 'T', { firstRow: false })
    const box = addColumn(doc, t, 'ok', 'checkbox')
    for (const v of [1, null, 1, null]) { const r = addRow(doc, t); if (v) setCell(doc, t, r, box, 1) }
    const table = readTables(doc)[0]
    const col = table.columns.find((x) => x.id === box)!
    const c = [...columnCells(doc, readTables(doc), table, col).values()]
    expect(footerText(c, col, 'sum')).toBe('2')
    expect(footerText(c, col, 'percent')).toBe('50 %')
  })
})
