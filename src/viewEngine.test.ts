import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addColumn, addRow, addTable, addView, deleteTable, emptyViewDef, readTabs, readViews, moveTable, readTables, setCell, type ViewDef } from './model'
import { computeView } from './viewEngine'

function setup() {
  const doc = new Y.Doc()
  const t = addTable(doc, 'Ausgaben', { firstRow: false })
  const cols = { name: readTables(doc)[0].columns[0].id, amount: addColumn(doc, t, 'Betrag', 'number'), cat: addColumn(doc, t, 'Kategorie', 'text'), done: addColumn(doc, t, 'Bezahlt', 'checkbox') }
  const data: [string, number | null, string, boolean][] = [
    ['Miete', 800, 'Wohnen', true], ['Strom', 60, 'Wohnen', false], ['Brot', 4.5, 'Essen', true], ['Käse', 7.25, 'Essen', false], ['Notiz', null, '', false],
  ]
  for (const [n, a, c, d] of data) {
    const r = addRow(doc, t)
    setCell(doc, t, r, cols.name, n); if (a !== null) setCell(doc, t, r, cols.amount, a)
    if (c) setCell(doc, t, r, cols.cat, c); if (d) setCell(doc, t, r, cols.done, 1)
  }
  return { doc, t, cols }
}
const view = (doc: Y.Doc, def: ViewDef) => computeView(doc, def)
const texts = (doc: Y.Doc, def: ViewDef, col: string) => view(doc, def).rows.map((r) => r.cells[col].text)

describe('Abgeleitete Tabellen', () => {
  it('ohne Bedingungen: alle Zeilen', () => {
    const { doc, t, cols } = setup()
    expect(texts(doc, emptyViewDef(t), cols.name)).toEqual(['Miete', 'Strom', 'Brot', 'Käse', 'Notiz'])
  })
  it('filtert mit Text-, Zahlen- und Checkbox-Bedingungen (UND bzw. ODER)', () => {
    const { doc, t, cols } = setup()
    const base = emptyViewDef(t)
    expect(texts(doc, { ...base, filters: [{ col: cols.cat, op: 'eq', value: 'essen' }] }, cols.name)).toEqual(['Brot', 'Käse'])
    expect(texts(doc, { ...base, filters: [{ col: cols.amount, op: 'gt', value: '5' }] }, cols.name)).toEqual(['Miete', 'Strom', 'Käse'])
    const both: ViewDef = { ...base, filters: [{ col: cols.amount, op: 'gt', value: '5' }, { col: cols.done, op: 'checked', value: '' }] }
    expect(texts(doc, both, cols.name)).toEqual(['Miete'])
    expect(texts(doc, { ...both, match: 'any' }, cols.name)).toEqual(['Miete', 'Strom', 'Brot', 'Käse'])
    expect(texts(doc, { ...base, filters: [{ col: cols.cat, op: 'empty', value: '' }] }, cols.name)).toEqual(['Notiz'])
  })
  it('ignoriert unvollständige Bedingungen und gelöschte Spalten', () => {
    const { doc, t, cols } = setup()
    const base = emptyViewDef(t)
    expect(view(doc, { ...base, filters: [{ col: cols.name, op: 'contains', value: '  ' }, { col: 'weg', op: 'eq', value: 'x' }] }).rows).toHaveLength(5)
  })
  it('gruppiert nach Spalte mit Summe, Minimum, Verketten und Anzahl', () => {
    const { doc, t, cols } = setup()
    const def: ViewDef = {
      ...emptyViewDef(t), group: { mode: 'column', col: cols.cat },
      aggs: { [cols.name]: { fn: 'concat', sep: ' + ' }, [cols.amount]: { fn: 'sum' }, [cols.done]: { fn: 'sum' } },
    }
    const r = view(doc, def)
    expect(r.rows.map((x) => x.cells[cols.cat].text)).toEqual(['Wohnen', 'Essen', ''])
    expect(r.rows.map((x) => x.cells[cols.name].text)).toEqual(['Miete + Strom', 'Brot + Käse', 'Notiz'])
    expect(r.rows.map((x) => x.cells[cols.amount].text)).toEqual(['860', '11.75', '0'])
    expect(r.rows.map((x) => x.cells[cols.done].text)).toEqual(['1', '1', '0'])
    expect(r.columns.map((c) => c.name)).toEqual(['Name (Verketten)', 'Betrag (Summe)', 'Kategorie', 'Bezahlt (Anzahl angehakt)'])
    const mm = view(doc, { ...def, aggs: { [cols.amount]: { fn: 'max' }, [cols.name]: { fn: 'hide' } } })
    expect(mm.rows.map((x) => x.cells[cols.amount].text)).toEqual(['800', '7.25', ''])
    expect(mm.columns.some((c) => c.id === cols.name)).toBe(false)
  })
  it('ganze Tabelle in eine Zeile, auch ohne Treffer', () => {
    const { doc, t, cols } = setup()
    const def: ViewDef = { ...emptyViewDef(t), group: { mode: 'all' }, aggs: { [cols.amount]: { fn: 'sum' }, [cols.name]: { fn: 'count' } } }
    const r = view(doc, def)
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].cells[cols.amount].text).toBe('871.75')
    expect(r.rows[0].cells[cols.name].text).toBe('5')
    const none = view(doc, { ...def, filters: [{ col: cols.name, op: 'eq', value: 'gibtsnicht' }] })
    expect(none.rows).toHaveLength(1)
    expect(none.rows[0].cells[cols.amount].text).toBe('0')
  })
  it('liegt in der Kopfzeile, wird mitsortiert und mit der Quelltabelle gelöscht', () => {
    const { doc, t } = setup()
    const v = addView(doc, 'Ansicht', emptyViewDef(t))
    expect(readTabs(doc).map((x) => x.kind)).toEqual(['table', 'view'])
    moveTable(doc, v, 0)
    expect(readTabs(doc).map((x) => x.id)).toEqual([v, t])
    expect(readViews(doc)[0].def.source).toBe(t)
    deleteTable(doc, t)
    expect(readViews(doc)).toHaveLength(0)
    expect(readTabs(doc)).toHaveLength(0)
    expect(view(doc, emptyViewDef(t)).missing).toBe(true)
  })
})
