import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addBlock, addColumn, addReport, addRow, addTable, addView, emptyViewDef, moveBlock, readReports, readTables, readTabs, readViews, setCell, setColumnConfig, addOption, deleteReport } from './model'
import { FULL_RIGHTS, type Rights } from './rights'
import { formatNumber, placeholderFor, reportEngine } from './report'
import { scopeOf } from './updateScope'

/** Kassenbuch: Einnahmen und Ausgaben in einer Tabelle, am Vorzeichen zu erkennen. */
function cashBook() {
  const doc = new Y.Doc()
  const table = addTable(doc, 'Buchungen', { firstRow: false })
  const name = readTables(doc)[0].columns[0].id
  const amount = addColumn(doc, table, 'Betrag', 'number')
  setColumnConfig(doc, table, amount, 'decimals', 2)
  setColumnConfig(doc, table, amount, 'unit', '€')
  const account = addColumn(doc, table, 'Konto', 'select')
  const giro = addOption(doc, table, account, 'Girokonto'), cash = addOption(doc, table, account, 'Barkasse')
  for (const [text, value, where] of [['Beitrag', 1200.1, giro], ['Spende', 300.2, cash], ['Miete', -500, giro]] as const) {
    const row = addRow(doc, table)
    setCell(doc, table, row, name, text); setCell(doc, table, row, amount, value); setCell(doc, table, row, account, where)
  }
  const income = addView(doc, 'Einnahmen', { ...emptyViewDef(table), filters: [{ col: amount, op: 'gt', value: '0' }] })
  const byAccount = addView(doc, 'Je Konto', { ...emptyViewDef(table), group: { mode: 'column', col: account } })
  const engine = (rights: Rights = FULL_RIGHTS) => reportEngine(doc, readTables(doc), readViews(doc), rights)
  return { doc, table, name, amount, account, income, byAccount, engine }
}
const text = (r: ReturnType<ReturnType<typeof reportEngine>['value']>) => (r.ok ? r.text : r.code)

describe('Werte im Bericht', () => {
  it('fasst ein Feld über alle Zeilen einer Tabelle oder abgeleiteten Tabelle zusammen, im Format der Spalte', () => {
    const { engine } = cashBook()
    expect(text(engine().value(' SUMME({{Buchungen.Betrag}}) '))).toBe('1.000,30 €')
    expect(text(engine().value('SUMME({{Einnahmen.Betrag}})'))).toBe('1.500,30 €')
    expect(text(engine().value('ANZAHL({{Einnahmen}})'))).toBe('2')
    expect(text(engine().value('1240 + SUMME({{ Buchungen.Betrag }})'))).toBe('2.240,30 €')
    expect(text(engine().value('SUM(buchungen.betrag)'))).toBe('1.000,30 €')
  })
  it('gibt einem Verhältnis keine Einheit', () => {
    expect(text(cashBook().engine().value('RUNDEN(SUMME({{Einnahmen.Betrag}}) / ANZAHL({{Einnahmen}}); 1)'))).toBe('750,2')
  })
  it('rechnet bei gruppierten Sichten mit den einzelnen Zeilen', () => {
    expect(text(cashBook().engine().value('ANZAHL({{Je Konto}})'))).toBe('3')
  })
  it('meldet Fehler verständlich', () => {
    const { engine, doc } = cashBook()
    expect(text(engine().value('{{Buchungen.Betrag}}'))).toBe('#WERT!')
    expect(text(engine().value('SUMME({{Kasse.Betrag}})'))).toBe('#NAME?')
    expect(text(engine().value('SUMME({{Buchungen.Summe}})'))).toBe('#NAME?')
    expect(text(engine().value('SUMME({{Buchungen.Betrag}}'))).toBe('#SYNTAX')
    addTable(doc, 'Einnahmen')
    expect(text(engine().value('SUMME({{Einnahmen.Betrag}})'))).toBe('#NAME?') // mehrdeutig
  })
  it('verträgt, was Textfelder ändern', () => {
    expect(text(cashBook().engine().value('TEXTVERBINDEN({{Einnahmen.Name}}; „ + “)'))).toBe('Beitrag + Spende')
  })
  it('schreibt kein „-0,00“', () => expect(formatNumber(-1e-13, { decimals: 2, unit: '' })).toBe('0,00'))
  it('die Einfügehilfe schreibt gültige Platzhalter', () => {
    const p = placeholderFor('SUMME', 'Einnahmen', 'Betrag')
    expect(p).toBe('{{ SUMME({{Einnahmen.Betrag}}) }}')
    expect(text(cashBook().engine().value(p.slice(2, -2)))).toBe('1.500,30 €')
  })
})

describe('Tabellen im Bericht', () => {
  it('zeigt die Zeilen einer abgeleiteten Tabelle mit Summenzeile', () => {
    const { engine, income } = cashBook()
    const r = engine().table(income, [], true)
    if (!r || 'error' in r) throw new Error('keine Tabelle')
    expect(r.columns.map((c) => c.name)).toEqual(['Name', 'Betrag', 'Konto'])
    expect(r.rows).toEqual([['Beitrag', '1.200,10 €', 'Girokonto'], ['Spende', '300,20 €', 'Barkasse']])
    expect(r.totals).toEqual(['Summe', '1.500,30 €', ''])
  })
  it('summiert gruppierte Sichten und lässt Spalten weg', () => {
    const { engine, byAccount, name } = cashBook()
    const r = engine().table(byAccount, [name], true)
    if (!r || 'error' in r) throw new Error('keine Tabelle')
    expect(r.rows).toEqual([['700,10 €', 'Girokonto'], ['300,20 €', 'Barkasse']])
    expect(r.totals).toEqual(['1.000,30 €', 'Summe'])
  })
  it('liefert null für eine gelöschte Quelle', () => expect(cashBook().engine().table('weg')).toBeNull())
})

describe('Bericht ohne volles Leserecht', () => {
  const only = (...ids: string[]): Rights => {
    const access = (id: string) => (ids.includes(id) ? 'read' as const : 'none' as const)
    const colAccess = (table: string, col: string) => (ids.includes(table) || ids.includes(col) ? 'read' as const : 'none' as const)
    return { ...FULL_RIGHTS, active: true, admin: false, structure: false, access, colAccess, visible: (table, cols) => ids.includes(table) || cols.some((c) => ids.includes(c)) }
  }
  it('zeigt statt einer unvollständigen Zahl einen Hinweis', () => {
    const { engine, amount, name, income } = cashBook()
    const r = only(name) // nur die Namensspalte
    expect(text(engine(r).value('SUMME({{Buchungen.Betrag}})'))).toBe('#GESPERRT')
    expect(text(engine(r).value('SUMME({{Einnahmen.Betrag}})'))).toBe('#GESPERRT')
    expect(engine(r).table(income)).toHaveProperty('error')
    expect(text(engine(only(amount)).value('SUMME({{Buchungen.Betrag}})'))).toBe('1.000,30 €')
  })
  it('lässt eine abgeleitete Tabelle lesen, an der man das Recht hat', () => {
    const { engine, income } = cashBook()
    expect(text(engine(only(income)).value('SUMME({{Einnahmen.Betrag}})'))).toBe('1.500,30 €')
    expect(text(engine(only(income)).value('SUMME({{Buchungen.Betrag}})'))).toBe('#GESPERRT')
  })
  it('prüft, woraus berechnete Spalten entstehen', () => {
    const { doc, table, engine, name } = cashBook()
    const twice = addColumn(doc, table, 'Doppelt', 'formula')
    setColumnConfig(doc, table, twice, 'expr', '{{Betrag}} * 2')
    expect(text(engine(only(name, twice)).value('SUMME({{Buchungen.Doppelt}})'))).toBe('#GESPERRT')
  })
})

describe('Berichte im Dokument', () => {
  it('stehen in der Kopfzeile, lassen sich umsortieren und löschen', () => {
    const doc = new Y.Doc()
    const id = addReport(doc, 'Jahresbericht')
    const a = addBlock(doc, id, { kind: 'text', text: 'a' })
    moveBlock(doc, id, a, -1)
    expect(readReports(doc)[0].blocks.map((b) => b.kind)).toEqual(['text', 'heading'])
    expect(readTabs(doc).map((x) => x.kind)).toEqual(['report'])
    deleteReport(doc, id)
    expect(readTabs(doc)).toEqual([])
  })
  it('gehören zur Struktur: Nur Admins ändern sie', () => {
    const doc = new Y.Doc()
    const id = addReport(doc, 'Bericht')
    const copy = new Y.Doc()
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
    const updates: Uint8Array[] = []
    copy.on('update', (u: Uint8Array) => updates.push(u))
    addBlock(copy, id, { kind: 'text', text: 'neu' })
    expect(scopeOf(doc, updates[0]).structure).toBe(true)
  })
})
