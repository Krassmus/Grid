import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { addColumn, addLink, addRow, addTable, deleteColumn, deleteRow, deleteTable, linksOf, moveLink, readTables, removeLink, reorderLink, setCell, setTableSort, tablesOf } from './model'
import { auditOf, installAudit, setAuditSettings } from './audit'
import { buildAsOf } from './timeTravel'

afterEach(() => vi.useRealTimers())

/** Inhalt der Tabellen und Verknüpfungen, unabhängig von der Reihenfolge der Zeilen. */
const state = (doc: Y.Doc) => {
  const t = tablesOf(doc).toJSON() as Record<string, any>
  for (const tb of Object.values(t)) { tb.rowOrder = [...tb.rowOrder].sort(); tb.colOrder = [...tb.colOrder] }
  return JSON.stringify({ t, l: Object.fromEntries(Object.entries(linksOf(doc).toJSON()).sort()) }, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v))
}

describe('Stand zu einem früheren Zeitpunkt', () => {
  it('rechnet zufällige Änderungen exakt zurück', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T10:00:00'))
    let seed = 42
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
    const doc = new Y.Doc(); installAudit(doc)
    const kunden = addTable(doc, 'Kunden', { firstRow: false }), orte = addTable(doc, 'Orte', { firstRow: false })
    const kn = readTables(doc).find((t) => t.id === kunden)!.columns[0].id
    const on = readTables(doc).find((t) => t.id === orte)!.columns[0].id
    const rel = addColumn(doc, kunden, 'Ort', 'relation', orte)
    const zahl = addColumn(doc, kunden, 'Zahl', 'number')
    const kRows: string[] = [], oRows: string[] = []
    const snaps: { at: number; state: string }[] = []
    for (let step = 0; step < 250; step++) {
      vi.advanceTimersByTime(60_000) // über der Zusammenfassungsgrenze
      const r = rnd(10)
      const kr = readTables(doc).find((t) => t.id === kunden)!
      if (r === 0 || kRows.length < 3) kRows.push(addRow(doc, kunden))
      else if (r === 1 && oRows.length < 6) { const id = addRow(doc, orte); oRows.push(id); setCell(doc, orte, id, on, 'Ort ' + step) }
      else if (r <= 4) setCell(doc, kunden, kRows[rnd(kRows.length)], rnd(2) ? kn : zahl, rnd(2) ? 'x' + step : step)
      else if (r === 5 && kRows.length > 4) { const i = rnd(kRows.length); deleteRow(doc, kunden, kRows[i]); kRows.splice(i, 1) }
      else if (r === 6 && oRows.length) addLink(doc, kunden, kRows[rnd(kRows.length)], rel, oRows[rnd(oRows.length)])
      else if (r === 7 && oRows.length) removeLink(doc, kunden, kRows[rnd(kRows.length)], rel, oRows[rnd(oRows.length)])
      else if (r === 8 && oRows.length) moveLink(doc, { tableId: kunden, rowId: kRows[rnd(kRows.length)], colId: rel }, { tableId: kunden, rowId: kRows[rnd(kRows.length)], colId: rel }, oRows[rnd(oRows.length)])
      else if (r === 9 && kr.columns.length < 6) addColumn(doc, kunden, 'C' + step, 'text')
      if (step % 7 === 0) snaps.push({ at: Date.now(), state: state(doc) })
    }
    expect(snaps.length).toBeGreaterThan(20)
    for (const s of snaps) {
      const asOf = buildAsOf(doc, s.at)
      expect(asOf.incomplete).toBe(false)
      expect(state(asOf.doc)).toBe(s.state)
    }
    reorderLink // (Umsortieren ist in den Tests von audit.test.ts abgedeckt)
  })

  it('holt gelöschte Zeilen mit Inhalt und Stelle, gelöschte Spalten und Tabellen zurück', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T10:00:00'))
    const doc = new Y.Doc(); installAudit(doc)
    const t = addTable(doc, 'T', { firstRow: false })
    const a = readTables(doc)[0].columns[0].id
    const b = addColumn(doc, t, 'B', 'text')
    const rows = ['x', 'y', 'z'].map((v) => { const id = addRow(doc, t); setCell(doc, t, id, a, v); setCell(doc, t, id, b, v + v); return id })
    const u = addTable(doc, 'U', { firstRow: true })
    vi.advanceTimersByTime(60_000); const before = Date.now(); const full = state(doc)
    vi.advanceTimersByTime(60_000); deleteRow(doc, t, rows[1])
    vi.advanceTimersByTime(60_000); deleteColumn(doc, t, b)
    vi.advanceTimersByTime(60_000); deleteTable(doc, u)
    vi.advanceTimersByTime(60_000); setTableSort(doc, t, a, 'desc')
    const asOf = buildAsOf(doc, before)
    expect(state(asOf.doc)).toBe(full)
    expect(tablesOf(asOf.doc).get(t)!.get('rowOrder').toArray()).toEqual(rows) // auch die Stelle stimmt
    expect(asOf.reverted).toBeGreaterThanOrEqual(4)
  })

  it('Änderungen an der Ansicht werden gemeldet; ohne Einträge nach dem Zeitpunkt bleibt alles gleich', () => {
    const doc = new Y.Doc(); installAudit(doc)
    const t = addTable(doc, 'T'); const c = readTables(doc)[0].columns[0].id; const r = readTables(doc)[0].rowIds[0]
    let edits = 0
    const asOf = buildAsOf(doc, Date.now() + 1000, () => edits++)
    expect(state(asOf.doc)).toBe(state(doc))
    setCell(asOf.doc, t, r, c, 'verändert')
    expect(edits).toBe(1)
    expect(state(doc)).not.toContain('verändert') // das echte Dokument bleibt unberührt
  })

  it('Aufbewahrung ist einstellbar: 0 = nie löschen', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T10:00:00'))
    const doc = new Y.Doc(); installAudit(doc)
    const t = addTable(doc, 'T', { firstRow: false }); const c = readTables(doc)[0].columns[0].id
    const r = addRow(doc, t)
    vi.advanceTimersByTime(100 * 24 * 3600 * 1000)
    setCell(doc, t, r, c, 'neu')
    expect(auditOf(doc).toArray().some((e) => e.k === 'tab+')).toBe(false) // nach den Standard-90 Tagen weg
    setAuditSettings(doc, { days: 0, max: 0 })
    vi.advanceTimersByTime(1000 * 24 * 3600 * 1000)
    setCell(doc, t, r, c, 'noch neuer')
    expect(auditOf(doc).length).toBeGreaterThanOrEqual(2) // nichts mehr abgeschnitten
    setAuditSettings(doc, { days: 0, max: 1 })
    setCell(doc, t, r, c, 'x')
    expect(auditOf(doc).length).toBe(1)
  })
})
