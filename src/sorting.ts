import * as Y from 'yjs'
import { readTables, type ColumnInfo, type TableInfo } from './model'
import { columnCells, compareKeys, type Key } from './cells'

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

/** Zeilen-IDs der Tabelle, nach der Spalte sortiert. */
export function sortedRowIds(doc: Y.Doc, tableId: string, colId: string, dir: SortDir): string[] {
  const tables = readTables(doc)
  const table = tables.find((t) => t.id === tableId)
  const col = table?.columns.find((c) => c.id === colId)
  if (!table || !col) return table?.rowIds ?? []
  return orderByKeys(table.rowIds, sortKeys(doc, table, col, tables), dir)
}
