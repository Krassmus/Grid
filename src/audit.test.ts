import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { addColumn, addLink, addRow, addTable, deleteRow, moveLink, removeLink, reorderLink, readTables, setCell } from './model'
import { auditOf, installAudit } from './audit'
import { createUndoManager } from './undo'

afterEach(() => vi.useRealTimers())

describe('Änderungsprotokoll', () => {
  it('schreibt eigene Änderungen mit Zeit, alt und neu', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-23T10:00:00'))
    const doc = new Y.Doc(); installAudit(doc)
    const t = addTable(doc, 'Kunden')
    const name = readTables(doc)[0].columns[0].id
    const r = readTables(doc)[0].rowIds[0]
    expect(auditOf(doc).toArray().map((e) => e.k)).toEqual(['tab+'])
    setCell(doc, t, r, name, 'Meier')
    vi.setSystemTime(new Date('2026-11-23T10:05:00'))
    setCell(doc, t, r, name, 'Müller')
    const e = auditOf(doc).toArray().filter((x) => x.k === 'cell')
    expect(e).toHaveLength(2)
    expect(e[1]).toMatchObject({ tb: 'Kunden', c: 'Name', r: 'Müller', o: 'Meier', n: 'Müller' })
    expect(e[1].t).toBe(new Date('2026-11-23T10:05:00').getTime())
  })
  it('fasst schnelle Änderungen derselben Zelle zusammen und ignoriert Änderungen von anderen', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-23T10:00:00'))
    const doc = new Y.Doc(); installAudit(doc)
    const t = addTable(doc, 'T'); const c = readTables(doc)[0].columns[0].id; const r = readTables(doc)[0].rowIds[0]
    for (const v of ['a', 'ab', 'abc']) { setCell(doc, t, r, c, v); vi.advanceTimersByTime(1000) }
    const cells = auditOf(doc).toArray().filter((x) => x.k === 'cell')
    expect(cells).toHaveLength(1)
    expect(cells[0]).toMatchObject({ o: '', n: 'abc' })
    // Änderung von außen (anderes Gerät) wird nicht protokolliert
    const other = new Y.Doc(); Y.applyUpdate(other, Y.encodeStateAsUpdate(doc))
    setCell(other, t, r, c, 'fremd')
    const before = auditOf(doc).length
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc)), 'remote')
    expect(auditOf(doc).length).toBe(before)
  })
  it('Zeilen und Spalten, neue Zeilen ohne einzelne Zellen, Rückgängig zählt als Änderung, Protokoll selbst nicht rückgängig', () => {
    const doc = new Y.Doc(); installAudit(doc)
    const um = createUndoManager(doc)
    const t = addTable(doc, 'T', { firstRow: false })
    const x = addColumn(doc, t, 'X', 'text')
    const r = addRow(doc, t); setCell(doc, t, r, x, 'hallo')
    um.stopCapturing(); deleteRow(doc, t, r)
    const kinds = auditOf(doc).toArray().map((e) => e.k)
    expect(kinds).toEqual(['tab+', 'col+', 'row+', 'cell', 'row-'])
    const del = auditOf(doc).toArray().find((e) => e.k === 'row-')!
    expect(del.r).toContain('hallo') // Text der Darstellung bleibt auch bei gelöschten Zeilen erhalten
    expect(del.ri).toBe(r)
    um.undo()
    expect(auditOf(doc).toArray().map((e) => e.k)).toContain('row+')
    expect(auditOf(doc).length).toBeGreaterThanOrEqual(5) // Rückgängig löscht keine Protokolleinträge
  })
  it('viele Zellen auf einmal ergeben einen Sammeleintrag', () => {
    const doc = new Y.Doc(); installAudit(doc)
    const t = addTable(doc, 'T', { firstRow: false }); const c = readTables(doc)[0].columns[0].id
    const rows = Array.from({ length: 150 }, () => addRow(doc, t))
    const before = auditOf(doc).length
    doc.transact(() => rows.forEach((r) => setCell(doc, t, r, c, 'v')))
    const added = auditOf(doc).toArray().slice(before)
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ k: 'bulk', x: 150 })
  })
  it('Relationen: hinzufügen, entfernen, verschieben, umsortieren', () => {
    const doc = new Y.Doc(); installAudit(doc)
    const orte = addTable(doc, 'Orte', { firstRow: false })
    const name = readTables(doc)[0].columns[0].id
    const o1 = addRow(doc, orte), o2 = addRow(doc, orte); setCell(doc, orte, o1, name, 'Berlin'); setCell(doc, orte, o2, name, 'Köln')
    const kunden = addTable(doc, 'Kunden', { firstRow: false })
    const kn = readTables(doc).find((t) => t.id === kunden)!.columns[0].id
    const rel = addColumn(doc, kunden, 'Ort', 'relation', orte)
    const k1 = addRow(doc, kunden), k2 = addRow(doc, kunden); setCell(doc, kunden, k1, kn, 'Meier'); setCell(doc, kunden, k2, kn, 'Schulz')
    const mark = () => auditOf(doc).length
    let m = mark(); addLink(doc, kunden, k1, rel, o1); addLink(doc, kunden, k1, rel, o2)
    let e = auditOf(doc).toArray().slice(m)
    expect(e.map((x) => x.k)).toEqual(['lnk+', 'lnk+'])
    expect(e[0]).toMatchObject({ tb: 'Kunden', r: 'Meier', c: 'Ort', n: 'Berlin' })
    m = mark(); reorderLink(doc, { tableId: kunden, rowId: k1, colId: rel }, o2, o1)
    e = auditOf(doc).toArray().slice(m)
    expect(e.map((x) => x.k)).toEqual(['lnk~']); expect(e[0].n).toBe('Köln')
    m = mark(); moveLink(doc, { tableId: kunden, rowId: k1, colId: rel }, { tableId: kunden, rowId: k2, colId: rel }, o1)
    e = auditOf(doc).toArray().slice(m)
    expect(e.map((x) => x.k)).toEqual(['lnk>']); expect(e[0]).toMatchObject({ r: 'Meier', o: 'Berlin' }); expect(e[0].n).toContain('Schulz')
    m = mark(); removeLink(doc, kunden, k2, rel, o1)
    e = auditOf(doc).toArray().slice(m)
    expect(e.map((x) => x.k)).toEqual(['lnk-']); expect(e[0]).toMatchObject({ r: 'Schulz', o: 'Berlin' })
  })
})
