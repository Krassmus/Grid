import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { addColumn, addRow, addTable, getCell, parseStamp, personIds, publishProfile, readTables, setCell } from './model'
import { columnCells, footerText, newCtx } from './cells'

afterEach(() => vi.useRealTimers())

describe('Zeitstempel und Person', () => {
  it('Erstellt gilt ab dem Anlegen, Zuletzt geändert folgt Änderungen (gedrosselt)', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-22T10:00:00'))
    const doc = new Y.Doc()
    const t = addTable(doc, 'T')
    const text = readTables(doc)[0].columns[0].id
    const created = addColumn(doc, t, 'Erstellt', 'stamp')
    const modified = addColumn(doc, t, 'Geändert', 'stamp', undefined, [], { kind: 'modified' })
    const row = addRow(doc, t)
    const c0 = parseStamp(getCell(doc, t, row, created))!, m0 = parseStamp(getCell(doc, t, row, modified))!
    expect(c0.at).toBe(m0.at)
    vi.setSystemTime(new Date('2026-11-22T10:00:10'))
    setCell(doc, t, row, text, 'a')
    expect(parseStamp(getCell(doc, t, row, modified))!.at).toBe(m0.at) // zu kurz her: nicht neu geschrieben
    vi.setSystemTime(new Date('2026-11-22T10:05:00'))
    setCell(doc, t, row, text, 'ab')
    expect(parseStamp(getCell(doc, t, row, modified))!.at).toBeGreaterThan(m0.at)
    expect(parseStamp(getCell(doc, t, row, created))!.at).toBe(c0.at) // „Erstellt“ bleibt
    const info = readTables(doc)[0]
    const cells = columnCells(doc, readTables(doc), info, info.columns.find((c) => c.id === modified)!, newCtx())
    expect(cells.get(row)!.text).toMatch(/^22\.11\.2026, 10:05 Uhr/)
  })
  it('Person: Namen aus den Profilen im Dokument', () => {
    const doc = new Y.Doc()
    const t = addTable(doc, 'T')
    const p = addColumn(doc, t, 'Wer', 'person')
    const row = addRow(doc, t)
    publishProfile(doc, 'acct-a', { name: 'Anna', avatar: '' })
    publishProfile(doc, 'acct-b', { name: 'Bernd', avatar: '' })
    setCell(doc, t, row, p, 'acct-b,acct-a')
    expect(personIds(getCell(doc, t, row, p))).toEqual(['acct-b', 'acct-a'])
    const info = readTables(doc)[0]
    const cells = columnCells(doc, readTables(doc), info, info.columns.find((c) => c.id === p)!, newCtx())
    expect(cells.get(row)!.text).toBe('Bernd, Anna')
  })
  it('Dauer rechnet in der Summe mit', () => {
    const doc = new Y.Doc()
    const t = addTable(doc, 'T')
    const d = addColumn(doc, t, 'Zeit', 'duration')
    const r1 = addRow(doc, t), r2 = addRow(doc, t)
    setCell(doc, t, r1, d, 5400); setCell(doc, t, r2, d, 1800)
    const info = readTables(doc)[0]
    const cells = columnCells(doc, readTables(doc), info, info.columns.find((c) => c.id === d)!, newCtx())
    expect(cells.get(r1)!.text).toBe('1:30')
    expect(cells.get(r2)!.key).toBe(1800)
    const col = info.columns.find((c) => c.id === d)!
    expect(footerText([...cells.values()], col, 'sum')).toBe('2:00')
    expect(footerText([...cells.values()], col, 'avg')).toBe('1:00')
  })
})
