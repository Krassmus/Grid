import * as Y from 'yjs'
import { buildFileIndex, buildLinkIndex, readTables, summarize, tablesOf, type ColumnInfo, type TableInfo } from './model'
import { plainText } from './richText'
import { TEXT } from './columnTypes'

export type SortDir = 'asc' | 'desc'

type Key = number | string | null // null = leer (steht immer am Ende)

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' })

/**
 * Sortierwert einer Zelle: Zahl → Zahl, Datum → ISO-Text, Auswahl → Position der Option,
 * Relation → Titel der ersten verknüpften Zeile, Datei → Name der ersten Datei, Text → Text (bei formatiertem ohne Markup).
 */
export function sortKeys(doc: Y.Doc, table: TableInfo, col: ColumnInfo, tables: TableInfo[]): Map<string, Key> {
  const out = new Map<string, Key>()
  const links = col.type === 'relation' ? buildLinkIndex(doc).forward : null
  const files = col.type === 'file' ? buildFileIndex(doc) : null
  const target = col.type === 'relation' ? tables.find((t) => t.id === col.target) : undefined
  const rows: Y.Map<Y.Map<any>> | undefined = tablesOf(doc).get(table.id)?.get('rows')
  for (const rid of table.rowIds) {
    const v = rows?.get(rid)?.get(col.id)
    let key: Key = null
    switch (col.type) {
      case 'number': key = typeof v === 'number' ? v : null; break
      case 'date': key = typeof v === 'string' && v ? v : null; break
      case 'select': { const i = (col.options ?? []).findIndex((o) => o.id === v); key = i >= 0 ? i : null; break }
      case 'relation': {
        const first = links?.get(`${rid}|${col.id}`)?.[0]
        key = first && target ? summarize(doc, target, first).title : null
        break
      }
      case 'file': key = files?.get(`${rid}|${col.id}`)?.[0]?.name ?? null; break
      default: {
        if (v === undefined || v === null || v === '') break
        const s = TEXT.config(col).mode === 'rich' ? plainText(String(v)).trim() : String(v)
        key = s || null
      }
    }
    out.set(rid, key)
  }
  return out
}

/** Zeilen-IDs der Tabelle, nach der Spalte sortiert. Leere Zellen stehen immer hinten, Gleiche behalten ihre Reihenfolge. */
export function sortedRowIds(doc: Y.Doc, tableId: string, colId: string, dir: SortDir): string[] {
  const tables = readTables(doc)
  const table = tables.find((t) => t.id === tableId)
  const col = table?.columns.find((c) => c.id === colId)
  if (!table || !col) return table?.rowIds ?? []
  const keys = sortKeys(doc, table, col, tables)
  const sign = dir === 'asc' ? 1 : -1
  return table.rowIds
    .map((id, i) => ({ id, i, k: keys.get(id) ?? null }))
    .sort((a, b) => {
      if (a.k === null || b.k === null) return a.k === b.k ? a.i - b.i : a.k === null ? 1 : -1
      const c = typeof a.k === 'number' && typeof b.k === 'number' ? a.k - b.k : collator.compare(String(a.k), String(b.k))
      return c ? c * sign : a.i - b.i
    })
    .map((x) => x.id)
}
