/**
 * Berechnet eine abgeleitete Tabelle (View): Zeilen der Quelltabelle filtern (WHERE), optional gruppieren und je Spalte
 * zusammenfassen (Minimum, Maximum, Summe, Verketten, Anzahl). Das Ergebnis ist reine Anzeige und wird nie gespeichert.
 */
import * as Y from 'yjs'
import { readTables, type ColType, type ColumnInfo, type FilterOp, type TableInfo, type ViewAgg, type ViewDef } from './model'
import { columnCells, newCtx, summarizeGroup, type Cell, type Key } from './cells'
import { aggLabel, allowedAggs, defaultAgg } from './aggregate'
import { effectiveType } from './columnTypes'
import { t } from './i18n'

export { aggLabel, allowedAggs, defaultAgg }

// ---------- Operatoren und Zusammenfassungen je Spaltentyp ----------

export const OPS_BY_TYPE: Record<ColType, FilterOp[]> = {
  text: ['contains', 'ncontains', 'eq', 'ne', 'starts', 'empty', 'nempty'],
  number: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'empty', 'nempty'],
  date: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'empty', 'nempty'],
  select: ['eq', 'ne', 'empty', 'nempty'],
  checkbox: ['checked', 'unchecked'],
  relation: ['contains', 'ncontains', 'empty', 'nempty'],
  file: ['contains', 'ncontains', 'empty', 'nempty'],
  rollup: [], // berechnete Spalten zählen mit ihrem effektiven Typ (effectiveType)
  formula: [],
  template: [],
  autonumber: [], // zählt mit dem effektiven Typ (Zahl)
  geo: ['contains', 'ncontains', 'empty', 'nempty'], // „contains“ sucht im angezeigten Text
  stamp: ['contains', 'ncontains', 'empty', 'nempty'],
  person: ['contains', 'ncontains', 'empty', 'nempty'],
  link: ['eq', 'ne', 'contains', 'ncontains', 'starts', 'empty', 'nempty'],
  duration: [], // zählt mit dem effektiven Typ (Zahl)
}

export const opNeedsValue = (op: FilterOp) => !['empty', 'nempty', 'checked', 'unchecked'].includes(op)

export function opLabel(type: ColType, op: FilterOp): string {
  const date = type === 'date'
  switch (op) {
    case 'eq': return t('ist gleich')
    case 'ne': return t('ist nicht gleich')
    case 'contains': return t('enthält')
    case 'ncontains': return t('enthält nicht')
    case 'starts': return t('beginnt mit')
    case 'gt': return date ? t('ist nach') : t('ist größer als')
    case 'ge': return date ? t('ist am oder nach') : t('ist größer oder gleich')
    case 'lt': return date ? t('ist vor') : t('ist kleiner als')
    case 'le': return date ? t('ist am oder vor') : t('ist kleiner oder gleich')
    case 'empty': return t('ist leer')
    case 'nempty': return t('ist nicht leer')
    case 'checked': return t('ist angehakt')
    case 'unchecked': return t('ist nicht angehakt')
  }
}

/** Gespeicherte Wahl, falls für den Typ erlaubt, sonst der Standard. */
export function aggOf(def: ViewDef, col: ColumnInfo, tables: TableInfo[]): ViewAgg {
  const type = effectiveType(col, tables)
  const a = def.aggs[col.id]
  return a && allowedAggs(type).includes(a.fn) ? a : { fn: defaultAgg(type) }
}

// ---------- Bedingungen ----------

export function matches(c: Cell, type: ColType, op: FilterOp, value: string): boolean {
  const v = value.trim().toLowerCase()
  const text = c.text.toLowerCase()
  switch (op) {
    case 'empty': return c.text === ''
    case 'nempty': return c.text !== ''
    case 'checked': return !!c.raw
    case 'unchecked': return !c.raw
    case 'contains': return text.includes(v)
    case 'ncontains': return !text.includes(v)
    case 'starts': return text.startsWith(v)
    case 'eq': case 'ne': {
      const eq = type === 'select' ? c.raw === value
        : type === 'number' ? c.key !== null && Number(c.key) === Number(value)
        : type === 'date' ? typeof c.key === 'string' && c.key.slice(0, 10) === value
        : text === v
      return op === 'eq' ? eq : !eq
    }
    default: { // gt, ge, lt, le
      if (c.key === null) return false
      let cmp: number
      if (type === 'date') cmp = String(c.key).slice(0, 10).localeCompare(value)
      else { const n = Number(value); if (Number.isNaN(n)) return false; cmp = Number(c.key) - n }
      return op === 'gt' ? cmp > 0 : op === 'ge' ? cmp >= 0 : op === 'lt' ? cmp < 0 : cmp <= 0
    }
  }
}

// ---------- Ergebnis ----------

export interface ViewColumn { id: string; name: string; type: ColType; width?: number }
export interface ViewCell { text: string; key: Key }
export interface ViewRow { id: string; cells: Record<string, ViewCell> }
export interface ViewResult { missing: boolean; sourceName: string; columns: ViewColumn[]; rows: ViewRow[]; matched: number }

/** Bedingungen, die wirken: unvollständige (ohne Wert) und solche auf gelöschte Spalten werden ignoriert. */
export function activeFilters(def: ViewDef, table: TableInfo, tables: TableInfo[]) {
  return def.filters.flatMap((f) => {
    const col = table.columns.find((c) => c.id === f.col)
    const type = col && effectiveType(col, tables)
    if (!col || !type || !OPS_BY_TYPE[type].includes(f.op) || (opNeedsValue(f.op) && !f.value.trim())) return []
    return [{ col, type, op: f.op, value: f.value }]
  })
}

/** Die Zeilen der Quelltabelle, die den Bedingungen genügen (auch bei gruppierten Sichten die einzelnen Zeilen). */
export function matchingIds(def: ViewDef, table: TableInfo, tables: TableInfo[], cellsOf: (col: ColumnInfo) => Map<string, Cell>): string[] {
  const active = activeFilters(def, table, tables)
  if (active.length === 0) return table.rowIds
  const cells = active.map((f) => cellsOf(f.col))
  return table.rowIds.filter((rid) => {
    const hit = (f: (typeof active)[number], i: number) => matches(cells[i].get(rid)!, f.type, f.op, f.value)
    return def.match === 'any' ? active.some(hit) : active.every(hit)
  })
}

export function computeView(doc: Y.Doc, def: ViewDef): ViewResult {
  const tables = readTables(doc)
  const table = tables.find((t) => t.id === def.source)
  if (!table) return { missing: true, sourceName: '', columns: [], rows: [], matched: 0 }
  const cells = new Map<string, Map<string, Cell>>()
  const ctx = newCtx()
  for (const c of table.columns) cells.set(c.id, columnCells(doc, tables, table, c, ctx))

  const ids = matchingIds(def, table, tables, (c) => cells.get(c.id)!)
  const base = { missing: false, sourceName: table.name, matched: ids.length }
  const cellOf = (c: ColumnInfo, rid: string): ViewCell => { const x = cells.get(c.id)!.get(rid)!; return { text: x.text, key: x.key } }

  const groupCol = def.group.mode === 'column' ? table.columns.find((c) => c.id === def.group.col) : undefined
  if (def.group.mode === 'none' || (def.group.mode === 'column' && !groupCol)) {
    return {
      ...base,
      columns: table.columns.filter((c) => !c.hidden).map((c) => ({ id: c.id, name: c.name, type: effectiveType(c, tables), width: c.width })),
      rows: ids.map((rid) => ({ id: rid, cells: Object.fromEntries(table.columns.filter((c) => !c.hidden).map((c) => [c.id, cellOf(c, rid)])) })),
    }
  }

  // Gruppen in der Reihenfolge ihres ersten Auftretens; „ganze Tabelle“ = eine Gruppe
  const groups = new Map<string, string[]>()
  if (groupCol) for (const rid of ids) {
    const k = cells.get(groupCol.id)!.get(rid)!.text
    const g = groups.get(k)
    if (g) g.push(rid); else groups.set(k, [rid])
  } else groups.set('', ids)

  const shown = table.columns.filter((c) => c === groupCol || (!c.hidden && aggOf(def, c, tables).fn !== 'hide'))
  const columns: ViewColumn[] = shown.map((c) => {
    const ct = effectiveType(c, tables)
    if (c === groupCol) return { id: c.id, name: c.name, type: ct, width: c.width }
    const a = aggOf(def, c, tables)
    const type: ColType = a.fn === 'sum' || a.fn === 'count' ? 'number' : a.fn === 'concat' ? 'text' : ct
    return { id: c.id, name: `${c.name} (${aggLabel(ct, a.fn)})`, type, width: c.width }
  })
  const rows: ViewRow[] = [...groups.entries()].map(([k, rids], i) => ({
    id: `g${i}:${k}`,
    cells: Object.fromEntries(shown.map((c) => [
      c.id,
      c === groupCol ? (rids.length ? cellOf(c, rids[0]) : { text: '', key: null })
        : summarizeGroup(rids.map((r) => cells.get(c.id)!.get(r)!), c, aggOf(def, c, tables)),
    ])),
  }))
  return { ...base, columns, rows }
}
