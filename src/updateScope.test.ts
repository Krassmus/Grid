import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addCalendar, updateCalendar, addColumn, addFile, addLink, addMap, addRow, addTable, deleteRow, deleteTable, readTables, renameTable, setCell, setMapShape, addView, tablesOf } from './model'
import { scopeOf } from './updateScope'

/** Zwei Dokumente im Gleichschritt: `author` schreibt, `checker` prüft das Update, bevor er es anwendet. */
function pair() {
  const author = new Y.Doc(), checker = new Y.Doc()
  const sync = () => Y.applyUpdate(checker, Y.encodeStateAsUpdate(author, Y.encodeStateVector(checker)))
  /** Führt `change` im Autor aus und liefert den Bereich des entstandenen Updates (vor dem Anwenden beim Prüfer). */
  const scopeOfChange = (change: () => void) => {
    const sv = Y.encodeStateVector(author)
    change()
    const u = Y.encodeStateAsUpdate(author, sv)
    const s = scopeOf(checker, u)
    Y.applyUpdate(checker, u)
    return s
  }
  return { author, checker, sync, scopeOfChange }
}
const none = { structure: false, unknown: false }

describe('Bereich eines Updates', () => {
  it('Kalender sind Struktur', () => {
    const { author, sync, scopeOfChange } = pair()
    addTable(author, 'A'); sync()
    let id = ''
    expect(scopeOfChange(() => { id = addCalendar(author, 'K', { layers: [], filters: [] }) })).toMatchObject({ structure: true, unknown: false })
    expect(scopeOfChange(() => updateCalendar(author, id, { name: 'K2' }))).toMatchObject({ structure: true, unknown: false })
  })

  it('Zellen und Zeilen gehören zur Tabelle; Spalten, Umbenennen und Tabellen sind Struktur', () => {
    const { author, sync, scopeOfChange } = pair()
    const t = addTable(author, 'A', { firstRow: false }); const col = readTables(author).find((x) => x.id === t)!.columns[0].id
    const u = addTable(author, 'B', { firstRow: false })
    sync()
    let row = ''
    expect(scopeOfChange(() => { row = addRow(author, t) })).toMatchObject({ tables: new Set([t]), maps: new Set(), ...none })
    expect(scopeOfChange(() => setCell(author, t, row, col, 'x'))).toMatchObject({ tables: new Set([t]), ...none })
    expect(scopeOfChange(() => setCell(author, t, row, col, 'y'))).toMatchObject({ tables: new Set([t]), ...none }) // überschreiben
    expect(scopeOfChange(() => deleteRow(author, t, row))).toMatchObject({ tables: new Set([t]), ...none })
    expect(scopeOfChange(() => { addColumn(author, t, 'Zahl', 'number') })).toMatchObject({ structure: true, unknown: false })
    expect(scopeOfChange(() => renameTable(author, u, 'B2'))).toMatchObject({ structure: true })
    expect(scopeOfChange(() => { addTable(author, 'C') })).toMatchObject({ structure: true })
    expect(scopeOfChange(() => deleteTable(author, u))).toMatchObject({ structure: true })
  })

  it('Verknüpfungen und Dateien gehören zur Tabelle mit der Relationsspalte', () => {
    const { author, sync, scopeOfChange } = pair()
    const a = addTable(author, 'A', { firstRow: false }), b = addTable(author, 'B', { firstRow: false })
    const rel = addColumn(author, a, 'Rel', 'relation', b)
    const r1 = addRow(author, a), r2 = addRow(author, b)
    sync()
    expect(scopeOfChange(() => addLink(author, a, r1, rel, r2))).toMatchObject({ tables: new Set([a]), ...none })
    expect(scopeOfChange(() => addFile(author, a, r1, rel, { hash: 'ab'.repeat(32), name: 'x.png', size: 1, mime: 'image/png' }))).toMatchObject({ tables: new Set([a]), ...none })
  })

  it('Karten: Objekte brauchen Schreibrecht an der Karte, die Karte selbst Admin; Sichten sind Struktur', () => {
    const { author, sync, scopeOfChange } = pair()
    const t = addTable(author, 'A', { firstRow: false })
    const m = addMap(author, 'Karte', [])
    sync()
    expect(scopeOfChange(() => setMapShape(author, m, 'sh000001', { kind: 'point', lat: 1, lon: 2, color: '#000', label: '' } as any))).toMatchObject({ maps: new Set([m]), ...none })
    expect(scopeOfChange(() => { addMap(author, 'Zweite', []) })).toMatchObject({ structure: true })
    expect(scopeOfChange(() => { addView(author, 'V', { source: t, filters: [], match: 'all', group: null } as any) })).toMatchObject({ structure: true })
  })

  it('das Änderungsprotokoll und Profile sind frei', () => {
    const { author, sync, scopeOfChange } = pair()
    addTable(author, 'A')
    sync()
    expect(scopeOfChange(() => { author.getArray('audit').push([{ t: 1 }]) })).toMatchObject({ structure: false, unknown: false, tables: new Set() })
    expect(scopeOfChange(() => { author.getMap('profiles').set('konto', { name: 'x' } as any) })).toMatchObject({ structure: false, unknown: false })
  })

  it('bereits Bekanntes zählt nicht; Fehlendes (Eltern unbekannt) ist unbekannt', () => {
    const { author, checker, sync } = pair()
    const t = addTable(author, 'A', { firstRow: false })
    sync()
    const sv = Y.encodeStateVector(author)
    const r = addRow(author, t)
    const first = Y.encodeStateAsUpdate(author, sv)
    const sv2 = Y.encodeStateVector(author)
    setCell(author, t, r, readTables(author).find((x) => x.id === t)!.columns[0].id, 'x')
    const second = Y.encodeStateAsUpdate(author, sv2)
    // zweites Update ohne das erste: die Zeile fehlt
    expect(scopeOf(checker, second).unknown).toBe(true)
    Y.applyUpdate(checker, first)
    expect(scopeOf(checker, first)).toMatchObject({ tables: new Set(), structure: false, unknown: false }) // schon bekannt
    expect(scopeOf(checker, second)).toMatchObject({ tables: new Set([t]), unknown: false })
    expect(tablesOf(checker).get(t)).toBeDefined()
  })

  it('der ganze Zustand eines Dokuments, den jemand erneut hochlädt, bringt nichts Neues', () => {
    const { author, checker } = pair()
    const t = addTable(author, 'A'); setCell(author, t, addRow(author, t), readTables(author).find((x) => x.id === t)!.columns[0].id, 'x')
    Y.applyUpdate(checker, Y.encodeStateAsUpdate(author))
    expect(scopeOf(checker, Y.encodeStateAsUpdate(author))).toMatchObject({ tables: new Set(), structure: false, unknown: false })
  })

  it('misst die Kosten bei großen Dokumenten', () => {
    const { author, checker, scopeOfChange } = pair()
    const t = addTable(author, 'A', { firstRow: false }); const col = readTables(author).find((x) => x.id === t)!.columns[0].id
    author.transact(() => { for (let i = 0; i < 20000; i++) { const r = addRow(author, t); setCell(author, t, r, col, 'Zeile ' + i) } })
    Y.applyUpdate(checker, Y.encodeStateAsUpdate(author))
    const rows = [...tablesOf(author).get(t)!.get('rows').keys()]
    const t0 = performance.now()
    for (let i = 0; i < 200; i++) scopeOfChange(() => setCell(author, t, rows[i * 50], col, 'neu ' + i))
    const per = (performance.now() - t0) / 200
    console.log(`Bereich je Update bei 20.000 Zeilen: ${per.toFixed(3)} ms (einschließlich Erzeugen und Anwenden)`)
    expect(per).toBeLessThan(5)
  })
})
