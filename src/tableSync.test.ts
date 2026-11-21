import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  addColumn, addFile, addLink, addRow, addTable, deleteColumn, deleteRow, deleteTable, moveTable, readTables, removeFile, removeLink,
  renameColumn, setCell, setColumnWidth,
} from './model'
import { Materializer, fullOps } from './tableSync'

function sample() {
  const doc = new Y.Doc()
  const t = addTable(doc, 'Ausgaben', { firstRow: false })
  const name = readTables(doc)[0].columns[0].id
  const wert = addColumn(doc, t, 'Wert', 'number')
  const beleg = addColumn(doc, t, 'Beleg', 'file')
  const bezug = addColumn(doc, t, 'Bezug', 'relation', t)
  const r1 = addRow(doc, t), r2 = addRow(doc, t)
  setCell(doc, t, r1, name, 'Kaffee')
  setCell(doc, t, r1, wert, 3.5)
  addLink(doc, t, r1, bezug, r2)
  addFile(doc, t, r1, beleg, { hash: 'h1', name: 'beleg.pdf', size: 3, mime: 'application/pdf' })
  return { doc, t, name, wert, beleg, bezug, r1, r2 }
}

describe('Datentabellen: vollständig', () => {
  it('fullOps enthält Spalten (mit data-Kennzeichen), Zeilen mit Werten, Verknüpfungen und Dateien', () => {
    const s = sample()
    const ops = fullOps(s.doc)
    const t = ops.rebuild![0]
    expect(t.columns.map((c) => [c.id, c.data])).toEqual([[s.name, true], [s.wert, true], [s.beleg, false], [s.bezug, false]])
    expect(t.rows).toEqual([[s.r1, 0, ['Kaffee', 3.5]], [s.r2, 1, [null, null]]])
    expect(t.links).toEqual([[s.r1, s.bezug, s.r2, expect.any(Number)]])
    expect(ops.filesPut).toEqual([[s.t, s.r1, s.beleg, 'h1', 'beleg.pdf', 3, 'application/pdf']])
  })
})

describe('Datentabellen: inkrementell', () => {
  const setup = () => {
    const s = sample()
    const m = new Materializer(s.doc)
    return { ...s, m }
  }

  it('ohne Änderung nichts zu schreiben', () => {
    expect(setup().m.collect()).toBeNull()
  })

  it('eine Zelle ändern: nur diese Zeile mit allen Datenspalten', () => {
    const s = setup()
    setCell(s.doc, s.t, s.r2, s.name, 'Tee')
    expect(s.m.collect()).toEqual({ upsertRows: [{ table: s.t, cols: [s.name, s.wert], rows: [[s.r2, 1, ['Tee', null]]] }] })
    expect(s.m.collect()).toBeNull() // danach ist alles abgearbeitet
  })

  it('mehrere Änderungen derselben Zeile ergeben einen Eintrag', () => {
    const s = setup()
    setCell(s.doc, s.t, s.r1, s.name, 'A'); setCell(s.doc, s.t, s.r1, s.wert, 1); setCell(s.doc, s.t, s.r1, s.name, 'B')
    expect(s.m.collect()!.upsertRows![0].rows).toEqual([[s.r1, 0, ['B', 1]]])
  })

  it('Zeile hinzufügen und löschen', () => {
    const s = setup()
    const r3 = addRow(s.doc, s.t)
    expect(s.m.collect()).toEqual({ upsertRows: [{ table: s.t, cols: [s.name, s.wert], rows: [[r3, 2, [null, null]]] }] })
    deleteRow(s.doc, s.t, s.r1)
    const ops = s.m.collect()!
    expect(ops.deleteRows).toEqual([{ table: s.t, ids: [s.r1] }])
    expect(ops.positions).toBeUndefined()
  })

  it('neue Spalte, gelöschte Spalte: Tabelle wird neu aufgebaut', () => {
    const s = setup()
    const n = addColumn(s.doc, s.t, 'Notiz', 'text')
    let ops = s.m.collect()!
    expect(ops.rebuild).toHaveLength(1)
    expect(ops.rebuild![0].columns.map((c) => c.id)).toContain(n)
    expect(ops.rebuild![0].rows).toHaveLength(2)
    expect(ops.upsertRows).toBeUndefined()
    deleteColumn(s.doc, s.t, n)
    ops = s.m.collect()!
    expect(ops.rebuild![0].columns.map((c) => c.id)).not.toContain(n)
  })

  it('Umbenennen und Breite ändern: nur das Verzeichnis', () => {
    const s = setup()
    renameColumn(s.doc, s.t, s.wert, 'Betrag')
    setColumnWidth(s.doc, s.t, s.name, 300)
    const ops = s.m.collect()!
    expect(Object.keys(ops)).toEqual(['catalog'])
    expect(ops.catalog![0].columns.find((c) => c.id === s.wert)!.name).toBe('Betrag')
    expect(ops.catalog![0].columns.find((c) => c.id === s.name)!.width).toBe(300)
    expect(ops.catalog![0].rows).toBeUndefined()
  })

  it('Verknüpfungen und Dateien', () => {
    const s = setup()
    removeLink(s.doc, s.t, s.r1, s.bezug, s.r2)
    addLink(s.doc, s.t, s.r2, s.bezug, s.r1)
    removeFile(s.doc, s.t, s.r1, s.beleg, 'h1')
    addFile(s.doc, s.t, s.r2, s.beleg, { hash: 'h2', name: 'b.png', size: 1, mime: 'image/png' })
    const ops = s.m.collect()!
    expect(ops.linksDel).toEqual([[s.t, s.r1, s.bezug, s.r2]])
    expect(ops.linksPut).toEqual([[s.t, s.r2, s.bezug, s.r1, expect.any(Number)]])
    expect(ops.filesDel).toEqual([[s.t, s.r1, s.beleg, 'h1']])
    expect(ops.filesPut).toEqual([[s.t, s.r2, s.beleg, 'h2', 'b.png', 1, 'image/png']])
  })

  it('Tabelle anlegen, umsortieren und löschen', () => {
    const s = setup()
    const t2 = addTable(s.doc, 'Neu')
    let ops = s.m.collect()!
    expect(ops.rebuild!.map((x) => x.id)).toEqual([t2])
    expect(ops.rebuild![0].pos).toBe(1)
    moveTable(s.doc, t2, 0)
    ops = s.m.collect()!
    expect(ops.tablePos).toEqual([[t2, 0], [s.t, 1]])
    deleteTable(s.doc, t2)
    expect(s.m.collect()!.dropTables).toEqual([t2])
  })

  it('Zeile in einer neuen Tabelle erzeugt keinen eigenen Eintrag (die Tabelle wird ohnehin ganz geschrieben)', () => {
    const s = setup()
    const t2 = addTable(s.doc, 'Neu', { firstRow: false })
    const r = addRow(s.doc, t2)
    const ops = s.m.collect()!
    expect(ops.upsertRows).toBeUndefined()
    expect(ops.rebuild![0].rows!.map((x) => x[0])).toEqual([r])
  })

  it('gleichzeitiges Anhängen von Zeilen (mitten in der Reihenfolge) schreibt die Reihenfolge neu', () => {
    const a = new Y.Doc(), b = new Y.Doc()
    const t = addTable(a, 'T', { firstRow: false })
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    const x = addRow(a, t)
    const m = new Materializer(a)
    const y = addRow(b, t)
    m.collect() // eigene Zeile x
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    const ops = m.collect()!
    const order = readTables(a)[0].rowIds
    expect(order).toHaveLength(2)
    expect(order).toContain(x)
    expect(order).toContain(y)
    // y landet je nach Client-ID vor oder nach x; steht es davor, muss die Reihenfolge neu geschrieben werden
    if (order[0] === y) expect(ops.positions).toEqual([{ table: t, ids: order }])
    expect(ops.upsertRows![0].rows.map((r) => r[0])).toContain(y)
  })

  it('dispose beendet die Beobachtung', () => {
    const s = setup()
    s.m.dispose()
    setCell(s.doc, s.t, s.r1, s.name, 'x')
    expect(s.m.collect()).toBeNull()
  })
})
