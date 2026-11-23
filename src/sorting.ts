import * as Y from 'yjs'
import { readTables, tablesOf, type ColumnInfo, type TableInfo } from './model'
import { cellDelta, columnCells, compareKeys, type Cell, type Key } from './cells'

export type SortDir = 'asc' | 'desc'
export { compareKeys }
export type { Key }

/** Sortierwerte einer Spalte je Zeile (Zahl → Zahl, Datum → ISO-Text, Auswahl → Position der Option, Relation → Titel der ersten Verknüpfung, Datei → erster Dateiname, Rollup → Ergebnis). */
export function sortKeys(doc: Y.Doc, table: TableInfo, col: ColumnInfo, tables: TableInfo[]): Map<string, Key> {
  const out = new Map<string, Key>()
  for (const [rid, c] of columnCells(doc, tables, table, col)) out.set(rid, c.key)
  return out
}

/** Ordnet IDs nach ihren Sortierwerten. Leere stehen immer hinten, Gleiche behalten ihre Reihenfolge. */
export function orderByKeys(ids: string[], keys: Map<string, Key>, dir: SortDir): string[] {
  const sign = dir === 'asc' ? 1 : -1
  return ids
    .map((id, i) => ({ id, i, k: keys.get(id) ?? null }))
    .sort((a, b) => {
      if (a.k === null || b.k === null) return a.k === b.k ? a.i - b.i : a.k === null ? 1 : -1
      const c = compareKeys(a.k, b.k)
      return c ? c * sign : a.i - b.i
    })
    .map((x) => x.id)
}

const sortedCache = new WeakMap<Map<string, Cell>, { rowIds: string[]; asc?: string[]; desc?: string[] }>()
const MAX_INCREMENTAL = 64

/** Zeilen-IDs der Tabelle, nach der Spalte sortiert. Das Ergebnis wird gemerkt; ändern sich nur wenige Zellen, werden nur diese Zeilen neu eingeordnet. */
export function sortedRowIds(doc: Y.Doc, tableId: string, colId: string, dir: SortDir): string[] {
  const tables = readTables(doc)
  const table = tables.find((t) => t.id === tableId)
  const col = table?.columns.find((c) => c.id === colId)
  if (!table || !col) return table?.rowIds ?? []
  const cells = columnCells(doc, tables, table, col)
  const hit = sortedCache.get(cells)
  if (hit && sameRows(hit.rowIds, table.rowIds) && hit[dir]) return hit[dir]!
  const sign = dir === 'asc' ? 1 : -1
  const keyOf = (id: string): Key => cells.get(id)?.key ?? null
  let ids: string[] | undefined
  const delta = cellDelta(cells)
  const before = delta && sortedCache.get(delta.prev)
  if (delta && before && delta.dirty.length <= MAX_INCREMENTAL && sameRows(before.rowIds, table.rowIds) && before[dir]) {
    const index = new Map(table.rowIds.map((id, i) => [id, i]))
    const cmp = (a: string, b: string) => {
      const ka = keyOf(a), kb = keyOf(b)
      if (ka === null || kb === null) return ka === kb ? index.get(a)! - index.get(b)! : ka === null ? 1 : -1
      const c = compareKeys(ka, kb)
      return c ? c * sign : index.get(a)! - index.get(b)!
    }
    const moved = new Set(delta.dirty.filter((id) => index.has(id)))
    ids = before[dir]!.filter((id) => !moved.has(id))
    for (const id of [...moved].sort(cmp)) {
      let lo = 0, hi = ids.length
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cmp(ids[mid], id) < 0) lo = mid + 1; else hi = mid }
      ids.splice(lo, 0, id)
    }
  }
  ids ??= orderByKeys(table.rowIds, new Map(table.rowIds.map((id) => [id, keyOf(id)])), dir)
  const entry = hit && sameRows(hit.rowIds, table.rowIds) ? hit : { rowIds: table.rowIds }
  entry[dir] = ids
  sortedCache.set(cells, entry)
  return ids
}
const sameRows = (a: string[], b: string[]) => a === b || (a.length === b.length && a.every((x, i) => x === b[i]))

/** Spaltentypen, deren Sortierwert nur von der eigenen Zelle abhängt (kein Verweis, keine Formel). */
const OWN_VALUE = new Set(['text', 'number', 'date', 'select', 'checkbox', 'link', 'duration'])

/**
 * Muss nach dieser Änderung neu sortiert (bzw. gesucht) werden? Nein, nur wenn sicher ist, dass sie die Sortierspalte nicht berührt:
 * Die Sortierspalte hängt nur von der eigenen Zelle ab, und geändert wurden ausschließlich Zellen anderer Spalten bestehender Zeilen dieser Tabelle
 * (oder gar nichts in dieser Tabelle).
 */
export function sortRelevant(doc: Y.Doc, tr: Y.Transaction, tableId: string | undefined, colId: string | undefined): boolean {
  if (!tableId || !colId) return true
  const table = tablesOf(doc).get(tableId)
  const type = table?.get('cols')?.get(colId)?.get('type')
  if (!table || !OWN_VALUE.has(type)) return true
  const rows: Y.Map<Y.Map<unknown>> | undefined = table.get('rows')
  if (!rows) return true
  for (const [changed, keys] of tr.changed) {
    if ((changed as unknown) === rows || (changed as unknown) === table) return true
    const inRows = (changed as Y.AbstractType<unknown>).parent === rows
    if (inRows) { if (keys.has(colId)) return true; continue }
    // Änderungen außerhalb dieser Tabelle betreffen eine Sortierung nach der eigenen Zelle nicht
    let p: Y.AbstractType<unknown> | null = changed as Y.AbstractType<unknown>
    while (p && p !== table) p = p.parent as Y.AbstractType<unknown> | null
    if (p === table) return true
  }
  return false
}
