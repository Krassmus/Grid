import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { addColumn, addLink, addRow, addTable, readTables, setCell } from './model'
import { columnCells } from './cells'
import { FormulaSyntaxError, parseFormula, parseTemplate } from './formula'
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
  it('schreibt Felder in doppelten geschweiften Klammern, auch mit Pfad und Leerzeichen', () => {
    expect(parseFormula('{{Σ Führer}} & "x"')).toMatchObject({ t: 'bin', op: '&', a: { t: 'ref', parts: ['Σ Führer'] } })
    expect(parseFormula('SUMME({{Gruppen.Führer}})')).toMatchObject({ t: 'call', fn: 'SUM', args: [{ t: 'ref', parts: ['Gruppen', 'Führer'] }] })
    expect(parseFormula('{{A}} + {{B}}')).toMatchObject({ t: 'bin', op: '+', a: { t: 'ref', parts: ['A'] }, b: { t: 'ref', parts: ['B'] } })
    expect(() => parseFormula('{{A')).toThrow(FormulaSyntaxError)
    expect(() => parseFormula('{{}}')).toThrow(FormulaSyntaxError)
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

describe('Text mit Platzhaltern', () => {
  const tpl = (s: ReturnType<typeof setup>, text: string) => {
    const col = addColumn(s.doc, s.gebiete, 'T', 'template', undefined, [], { tpl: text })
    return s.e.map((r) => s.run(col).get(r)!)
  }
  it('setzt Spalten, Rechnungen und Aggregate in den Text ein', () => {
    const s = setup()
    expect(tpl(s, '{{Name}} hat {{[Σ Führer] + [Σ Unterführer] + [Σ Helfer]}} Personen in {{ANZAHL(Gruppen)}} Gruppen').map((c) => c.text)).toEqual([
      'EAL 1 hat 22 Personen in 2 Gruppen', 'EAL 2 hat 1 Personen in 1 Gruppen', 'EAL 3 hat 0 Personen in 0 Gruppen',
    ])
  })
  it('kennt Text ohne Platzhalter, mehrzeilige Texte und Formeln mit Text', () => {
    const s = setup()
    expect(tpl(s, 'nur Text')[0].text).toBe('nur Text')
    expect(tpl(s, 'Zeile 1\n{{Name}}')[0].text).toBe('Zeile 1\nEAL 1')
    expect(tpl(s, '{{WENN([Σ Helfer] > 10; "}}viele"; "wenige")}}')[0].text).toBe('}}viele') // "}}" in Anführungszeichen beendet den Platzhalter nicht
    expect(tpl(s, '').every((c) => c.text === '')).toBe(true)
  })
  it('erlaubt in Platzhaltern Rechnungen mit eingeschachtelten Feldern', () => {
    expect(parseTemplate('Summe: {{ {{A}} + {{B}} }} fertig')).toMatchObject({ t: 'bin', op: '&' })
    expect(() => parseTemplate('{{ {{A}} + {{B}} }')).toThrow(FormulaSyntaxError)
  })
  it('meldet Fehler im Platzhalter mit seiner Formel', () => {
    expect(() => parseTemplate('Hallo {{Name')).toThrow(/nicht mit }} abgeschlossen/)
    expect(() => parseTemplate('Hallo {{ }}')).toThrow(/Leerer Platzhalter/)
    expect(() => parseTemplate('{{1 +}}')).toThrow(/Platzhalter \{\{1 \+\}\}: Die Formel ist unvollständig/)
    const s = setup()
    const c = tpl(s, 'x {{[Gibt es nicht]}}')[0]
    expect([c.text, c.error]).toEqual(['#NAME?', 'Spalte „Gibt es nicht“ gibt es nicht'])
  })
  it('ist Text, sortierbar und im Typ „Text“', () => {
    const s = setup()
    const col = addColumn(s.doc, s.gebiete, 'T', 'template', undefined, [], { tpl: '{{[Σ Helfer]}} Helfer' })
    expect(effectiveType(s.gt().columns.find((c) => c.id === col)!, s.tables())).toBe('text')
    expect(sortedRowIds(s.doc, s.gebiete, col, 'desc')[0]).toBe(s.e[0]) // „17 Helfer“ nach natürlicher Sortierung zuletzt = absteigend zuerst
  })
})

describe('Datumsfunktionen', () => {
  afterEach(() => vi.useRealTimers())
  /** Heute ist Samstag, der 21.11.2026, 14:30. Die drei Zeilen haben im Datum 11.11., 21.11. (heute) und 25.11. */
  function withDates() {
    vi.useFakeTimers({ now: new Date(2026, 10, 21, 14, 30) })
    const t = setup()
    const date = addColumn(t.doc, t.gebiete, 'Datum', 'date')
    ;['2026-11-11', '2026-11-21', '2026-11-25'].forEach((d, i) => setCell(t.doc, t.gebiete, t.e[i], date, d))
    return t
  }

  it('DAYSINCE / TAGE_SEIT: Tage seit einem Datum bis heute (negativ, wenn es in der Zukunft liegt)', () => {
    const t = withDates()
    expect(t.val('DAYSINCE([Datum])')).toEqual(['10', '0', '-4'])
    expect(t.val('TAGE_SEIT([Datum])')).toEqual(['10', '0', '-4'])
    expect(t.val('DAYSUNTIL([Datum])')).toEqual(['-10', '0', '4'])
    expect(t.val('TAGE_BIS([Datum])')).toEqual(['-10', '0', '4'])
  })

  it('lässt leere Datumsfelder leer und meldet Text, der kein Datum ist', () => {
    const t = withDates()
    setCell(t.doc, t.gebiete, t.e[1], t.gt().columns.find((c) => c.name === 'Datum')!.id, '')
    expect(t.val('DAYSINCE([Datum])')).toEqual(['10', '', '-4'])
    expect(t.val('DAYSINCE("gestern")')).toEqual(['#WERT!', '#WERT!', '#WERT!'])
    expect(t.val('DAYSINCE("2026-02-30")')).toEqual(['#WERT!', '#WERT!', '#WERT!'])
    expect(t.val('DAYSINCE()')[0]).toBe('#SYNTAX')
  })

  it('rechnet mit ganzen Tagen, auch über Schaltjahr und Uhrzeit', () => {
    const t = withDates()
    expect(t.val('TAGE("2024-02-28"; "2024-03-01")')[0]).toBe('2') // Schaltjahr
    expect(t.val('TAGE("2026-01-01"; "2027-01-01")')[0]).toBe('365')
    expect(t.val('DAYSINCE("2026-11-11T23:59")')[0]).toBe('10') // Uhrzeit zählt nicht
    expect(t.val('TAGE([Datum]; "2026-12-01")')).toEqual(['20', '10', '6'])
  })

  it('liefert Jahr, Monat, Tag und Wochentag (Montag = 1)', () => {
    const t = withDates()
    expect(t.val('JAHR([Datum])')).toEqual(['2026', '2026', '2026'])
    expect(t.val('MONAT([Datum])')[0]).toBe('11')
    expect(t.val('TAG([Datum])')).toEqual(['11', '21', '25'])
    expect(t.val('WOCHENTAG([Datum])')).toEqual(['3', '6', '3']) // Mi, Sa, Mi
    expect(t.val('WEEKDAY("2026-11-22")')[0]).toBe('7') // Sonntag
  })

  it('addiert Tage, baut Datumswerte und kennt heute und jetzt', () => {
    const t = withDates()
    expect(t.val('TAGE_ADDIEREN([Datum]; 10)')).toEqual(['2026-11-21', '2026-12-01', '2026-12-05'])
    expect(t.val('ADDDAYS("2026-11-30T09:15"; 1)')[0]).toBe('2026-12-01T09:15')
    expect(t.val('ADDDAYS("2026-03-01"; -1)')[0]).toBe('2026-02-28')
    expect(t.val('DATUM(2026; 13; 1)')[0]).toBe('2027-01-01')
    expect(t.val('DATE(2026; 2; 31)')[0]).toBe('2026-03-03')
    expect(t.val('HEUTE()')[0]).toBe('2026-11-21')
    expect(t.val('JETZT()')[0]).toBe('2026-11-21T14:30')
    expect(t.val('TAGE_SEIT(TAGE_ADDIEREN(HEUTE(); -7))')[0]).toBe('7')
  })

  it('berechnet das Alter in vollen Jahren', () => {
    const t = withDates()
    expect(t.val('ALTER("2000-11-21")')[0]).toBe('26') // heute Geburtstag
    expect(t.val('ALTER("2000-11-22")')[0]).toBe('25') // morgen
    expect(t.val('AGE("2000-02-29"; "2001-02-28")')[0]).toBe('0')
    expect(t.val('AGE("2000-02-29"; "2001-03-01")')[0]).toBe('1')
  })

  it('hat die passenden Typen: Zahl bzw. Text (Datum als JJJJ-MM-TT), WENN und Vergleiche funktionieren', () => {
    const t = withDates()
    const num = t.formula('DAYSINCE([Datum])', 'Alter in Tagen')
    const txt = t.formula('HEUTE()', 'Stand')
    expect(effectiveType(t.gt().columns.find((c) => c.id === num)!, t.tables())).toBe('number')
    expect(effectiveType(t.gt().columns.find((c) => c.id === txt)!, t.tables())).toBe('text')
    expect(t.val('WENN(TAGE_SEIT([Datum]) > 5; "alt"; "neu")')).toEqual(['alt', 'neu', 'neu'])
    expect(t.val('[Datum] < HEUTE()')).toEqual(['Wahr', 'Falsch', 'Falsch'])
  })
})
