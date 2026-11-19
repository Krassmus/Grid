import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addColumn, addLink, addRow, addTable, readTables, setCell } from './model'
import { columnCells } from './cells'
import { FormulaSyntaxError, parseFormula } from './formula'
import { effectiveType } from './columnTypes'
import { sortedRowIds } from './sorting'

/** Einsatzgebiete (EAL 1, EAL 2, EAL 3) mit Gruppen; Formeln werden in der Spalte „F“ ausgewertet. */
function setup() {
  const doc = new Y.Doc()
  const gebiete = addTable(doc, 'Einsatzgebiete', { firstRow: false })
  const gruppen = addTable(doc, 'Gruppen', { firstRow: false })
  const nameOf = (t: string) => readTables(doc).find((x) => x.id === t)!.columns[0].id
  const fuehrer = addColumn(doc, gruppen, 'Führer', 'number')
  const unter = addColumn(doc, gruppen, 'Unterführer', 'number')
  const helfer = addColumn(doc, gruppen, 'Helfer', 'number')
  const rel = addColumn(doc, gebiete, 'Gruppen', 'relation', gruppen)
  const g = [[1, 2, 14], [2, 0, 3], [0, 1, 0]].map(([f, u, h]) => {
    const r = addRow(doc, gruppen)
    setCell(doc, gruppen, r, fuehrer, f); setCell(doc, gruppen, r, unter, u); setCell(doc, gruppen, r, helfer, h)
    return r
  })
  const e = ['EAL 1', 'EAL 2', 'EAL 3'].map((n) => { const r = addRow(doc, gebiete); setCell(doc, gebiete, r, nameOf(gebiete), n); return r })
  addLink(doc, gebiete, e[0], rel, g[0]); addLink(doc, gebiete, e[0], rel, g[1]); addLink(doc, gebiete, e[1], rel, g[2])
  const sums = Object.fromEntries([['Führer', fuehrer], ['Unterführer', unter], ['Helfer', helfer]].map(([n, c]) =>
    [n, addColumn(doc, gebiete, `Σ ${n}`, 'rollup', undefined, [], { rel, col: c, fn: 'sum' })]))
  const formula = (expr: string, name = 'F', extra: Record<string, unknown> = {}) => addColumn(doc, gebiete, name, 'formula', undefined, [], { expr, ...extra })
  const tables = () => readTables(doc)
  const gt = () => tables().find((t) => t.id === gebiete)!
  const run = (col: string) => { const c = gt().columns.find((x) => x.id === col)!; return columnCells(doc, tables(), gt(), c) }
  const texts = (col: string) => e.map((r) => run(col).get(r)!.text)
  const val = (expr: string) => texts(formula(expr))
  return { doc, gebiete, e, sums, formula, run, texts, val, name: nameOf(gebiete), tables, gt }
}

describe('Formel-Parser', () => {
  it('parst Rechnung, Klammern, Funktionen und Pfade', () => {
    expect(parseFormula('1 + 2 * 3')).toMatchObject({ t: 'bin', op: '+', b: { t: 'bin', op: '*' } })
    expect(parseFormula('SUMME(Gruppen.Führer; 2)')).toMatchObject({ t: 'call', fn: 'SUM', args: [{ t: 'ref', parts: ['Gruppen', 'Führer'] }, { t: 'num', v: 2 }] })
    expect(parseFormula('[Σ Führer] & "x"')).toMatchObject({ t: 'bin', op: '&', a: { t: 'ref', parts: ['Σ Führer'] } })
  })
  it('meldet Fehler mit Position', () => {
    for (const bad of ['', '1 +', '(1', 'SUMME(', '1 2', '"offen', '[offen', '1 $ 2', '1,5 + 2']) {
      expect(() => parseFormula(bad), bad).toThrow(FormulaSyntaxError)
    }
  })
})

describe('Formel-Spalte', () => {
  it('rechnet mit Spalten derselben Zeile, auch mit Rollups (Ihr Beispiel)', () => {
    const s = setup()
    const total = s.formula('[Σ Führer] + [Σ Unterführer] + [Σ Helfer]', 'Gesamt')
    expect(s.texts(total)).toEqual(['22', '1', '0'])
    expect(s.texts(s.formula('SUMME([Σ Führer]; [Σ Unterführer]; [Σ Helfer])'))).toEqual(['22', '1', '0'])
  })
  it('wertet Aggregate über Relationen aus', () => {
    const s = setup()
    expect(s.val('SUMME(Gruppen.Helfer)')).toEqual(['17', '0', '0'])
    expect(s.val('ANZAHL(Gruppen)')).toEqual(['2', '1', '0'])
    expect(s.val('MAX(Gruppen.Führer)')).toEqual(['2', '0', ''])
    expect(s.val('MITTELWERT(Gruppen.Helfer)')).toEqual(['8.5', '0', ''])
    expect(s.val('SUMME(Gruppen.Führer) + SUMME(Gruppen.Unterführer) + SUMME(Gruppen.Helfer)')).toEqual(['22', '1', '0'])
    expect(s.val('TEXTVERBINDEN(Gruppen.Helfer; " / ")')).toEqual(['14 / 3', '0', ''])
  })
  it('kennt Operatorrang, Vergleiche, WENN, Text und Rundung', () => {
    const s = setup()
    expect(s.val('2 + 3 * 4 ^ 2 / 8')).toEqual(['8', '8', '8'])
    expect(s.val('-2 ^ 2')).toEqual(['-4', '-4', '-4'])
    expect(s.val('WENN([Σ Helfer] > 10; "viele"; "wenige")')).toEqual(['viele', 'wenige', 'wenige'])
    expect(s.val('[Name] & ": " & [Σ Helfer]')).toEqual(['EAL 1: 17', 'EAL 2: 0', 'EAL 3: 0'])
    expect(s.val('RUNDEN(10 / 3; 2)')).toEqual(['3.33', '3.33', '3.33'])
    expect(s.val('UND([Σ Helfer] > 0; NICHT(ISTLEER([Name])))')).toEqual(['Wahr', 'Falsch', 'Falsch'])
    expect(s.val('IF(TRUE; 1; 2) + ABS(-3)')).toEqual(['4', '4', '4'])
  })
  it('zeigt Fehler als Code mit Erklärung statt abzustürzen', () => {
    const s = setup()
    const err = (expr: string) => { const c = s.run(s.formula(expr)).get(s.e[0])!; return [c.text, c.error] }
    expect(err('1 / 0')).toEqual(['#DIV/0!', 'Division durch 0'])
    expect(err('[Gibt es nicht] + 1')[0]).toBe('#NAME?')
    expect(err('FOO(1)')[0]).toBe('#NAME?')
    expect(err('1 +')[0]).toBe('#SYNTAX')
    expect(err('Gruppen.Helfer')[0]).toBe('#WERT!')
    expect(err('"abc" * 2')[0]).toBe('#WERT!')
    expect(s.run(s.formula('')).get(s.e[0])!.text).toBe('')
  })
  it('erkennt Zyklen', () => {
    const s = setup()
    const a = s.formula('1', 'A'), b = s.formula('[A] + 1', 'B')
    s.doc.getMap<Y.Map<any>>('tables').get(s.gebiete)!.get('cols').get(a)!.set('cfg.expr', '[B] + 1')
    expect(s.run(a).get(s.e[0])!.text).toBe('#ZYKLUS')
    expect(s.run(b).get(s.e[0])!.text).toBe('#ZYKLUS')
    const self = s.formula('[Selbst]', 'Selbst')
    expect(s.run(self).get(s.e[0])!.text).toBe('#ZYKLUS')
  })
  it('hat den passenden Typ, formatiert und sortiert', () => {
    const s = setup()
    const n = s.formula('[Σ Helfer] / 3', 'N', { decimals: 1, unit: 'kg' })
    expect(s.texts(n)).toEqual(['5.7 kg', '0.0 kg', '0.0 kg'])
    const col = (id: string) => s.gt().columns.find((c) => c.id === id)!
    expect(effectiveType(col(n), s.tables())).toBe('number')
    expect(effectiveType(col(s.formula('[Σ Helfer] > 1')), s.tables())).toBe('checkbox')
    expect(effectiveType(col(s.formula('[Name] & "x"')), s.tables())).toBe('text')
    expect(effectiveType(col(s.formula('SUMME(Gruppen.Helfer)')), s.tables())).toBe('number')
    expect(sortedRowIds(s.doc, s.gebiete, n, 'desc')[0]).toBe(s.e[0])
  })
  it('folgt Änderungen der Daten', () => {
    const s = setup()
    const f = s.formula('SUMME(Gruppen.Helfer)')
    const gruppen = s.tables().find((t) => t.name === 'Gruppen')!
    setCell(s.doc, gruppen.id, gruppen.rowIds[0], gruppen.columns.find((c) => c.name === 'Helfer')!.id, 100)
    expect(s.texts(f)[0]).toBe('103')
  })
})
