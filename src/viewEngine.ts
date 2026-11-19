/**
 * Berechnet eine abgeleitete Tabelle (View): Zeilen der Quelltabelle filtern (WHERE), optional gruppieren und je Spalte
 * zusammenfassen (Minimum, Maximum, Summe, Verketten, Anzahl). Das Ergebnis ist reine Anzeige und wird nie gespeichert.
 */
import * as Y from 'yjs'
import { buildFileIndex, buildLinkIndex, readTables, summarize, tablesOf, type ColType, type ColumnInfo, type FilterOp, type TableInfo, type ViewAgg, type ViewDef, type AggFn } from './model'
import { compareKeys, sortKeys, type Key } from './sorting'
import { formatDate } from './dateFormat'
import { plainText } from './richText'
import { DATE, NUMBER, TEXT } from './columnTypes'

// ---------- Operatoren und Zusammenfassungen je Spaltentyp ----------

export const OPS_BY_TYPE: Record<ColType, FilterOp[]> = {
  text: ['contains', 'ncontains', 'eq', 'ne', 'starts', 'empty', 'nempty'],
  number: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'empty', 'nempty'],
  date: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'empty', 'nempty'],
  select: ['eq', 'ne', 'empty', 'nempty'],
  checkbox: ['checked', 'unchecked'],
  relation: ['contains', 'ncontains', 'empty', 'nempty'],
  file: ['contains', 'ncontains', 'empty', 'nempty'],
}

export const opNeedsValue = (op: FilterOp) => !['empty', 'nempty', 'checked', 'unchecked'].includes(op)

export function opLabel(type: ColType, op: FilterOp): string {
  const date = type === 'date'
  switch (op) {
    case 'eq': return 'ist gleich'
    case 'ne': return 'ist nicht gleich'
    case 'contains': return 'enthält'
    case 'ncontains': return 'enthält nicht'
    case 'starts': return 'beginnt mit'
    case 'gt': return date ? 'ist nach' : 'ist größer als'
    case 'ge': return date ? 'ist am oder nach' : 'ist größer oder gleich'
    case 'lt': return date ? 'ist vor' : 'ist kleiner als'
    case 'le': return date ? 'ist am oder vor' : 'ist kleiner oder gleich'
    case 'empty': return 'ist leer'
    case 'nempty': return 'ist nicht leer'
    case 'checked': return 'ist angehakt'
    case 'unchecked': return 'ist nicht angehakt'
  }
}

export function allowedAggs(type: ColType): AggFn[] {
  if (type === 'number') return ['sum', 'min', 'max', 'concat', 'count', 'hide']
  if (type === 'checkbox') return ['sum', 'hide']
  return ['concat', 'min', 'max', 'count', 'hide']
}

export const defaultAgg = (type: ColType): AggFn => (type === 'number' || type === 'checkbox' ? 'sum' : 'concat')

export function aggLabel(type: ColType, fn: AggFn): string {
  if (fn === 'sum') return type === 'checkbox' ? 'Anzahl angehakt' : 'Summe'
  return { min: 'Minimum', max: 'Maximum', concat: 'Verketten', count: 'Anzahl', hide: 'Nicht anzeigen' }[fn]
}

/** Gespeicherte Wahl, falls für den Typ erlaubt, sonst der Standard. */
export function aggOf(def: ViewDef, col: ColumnInfo): ViewAgg {
  const a = def.aggs[col.id]
  return a && allowedAggs(col.type).includes(a.fn) ? a : { fn: defaultAgg(col.type) }
}

// ---------- Zellwerte ----------

interface Cell { raw: unknown; text: string; key: Key }

function fmtNumber(n: number, col: ColumnInfo): string {
  const cfg = NUMBER.config(col)
  const s = cfg.decimals >= 0 ? n.toFixed(cfg.decimals) : String(Number(n.toPrecision(12)))
  return cfg.unit ? `${s} ${cfg.unit}` : s
}

function columnCells(doc: Y.Doc, tables: TableInfo[], table: TableInfo, col: ColumnInfo): Map<string, Cell> {
  const keys = sortKeys(doc, table, col, tables)
  const rows: Y.Map<Y.Map<any>> | undefined = tablesOf(doc).get(table.id)?.get('rows')
  const links = col.type === 'relation' ? buildLinkIndex(doc).forward : null
  const files = col.type === 'file' ? buildFileIndex(doc) : null
  const target = col.type === 'relation' ? tables.find((t) => t.id === col.target) : undefined
  const out = new Map<string, Cell>()
  for (const rid of table.rowIds) {
    const raw = rows?.get(rid)?.get(col.id)
    let text = ''
    switch (col.type) {
      case 'number': text = typeof raw === 'number' ? fmtNumber(raw, col) : ''; break
      case 'date': { const c = DATE.config(col); text = formatDate(raw, c.style, c.time); break }
      case 'select': text = col.options?.find((o) => o.id === raw)?.name ?? ''; break
      case 'checkbox': text = raw ? '✓' : ''; break
      case 'relation': text = (links?.get(`${rid}|${col.id}`) ?? []).map((x) => (target ? summarize(doc, target, x).title : '')).filter(Boolean).join(', '); break
      case 'file': text = (files?.get(`${rid}|${col.id}`) ?? []).map((f) => f.name).join(', '); break
      default: {
        if (typeof raw !== 'string') break
        text = TEXT.config(col).mode === 'rich' ? plainText(raw).trim() : raw
      }
    }
    out.set(rid, { raw, text, key: keys.get(rid) ?? null })
  }
  return out
}

// ---------- Bedingungen ----------

function matches(c: Cell, col: ColumnInfo, op: FilterOp, value: string): boolean {
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
      const eq = col.type === 'select' ? c.raw === value
        : col.type === 'number' ? c.key !== null && Number(c.key) === Number(value)
        : col.type === 'date' ? typeof c.key === 'string' && c.key.slice(0, 10) === value
        : text === v
      return op === 'eq' ? eq : !eq
    }
    default: { // gt, ge, lt, le
      if (c.key === null) return false
      let cmp: number
      if (col.type === 'date') cmp = String(c.key).slice(0, 10).localeCompare(value)
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

function summarizeGroup(cells: Cell[], col: ColumnInfo, agg: ViewAgg): ViewCell {
  switch (agg.fn) {
    case 'sum': {
      const sum = cells.reduce((n, c) => n + (typeof c.key === 'number' ? c.key : 0), 0)
      return { text: col.type === 'number' ? fmtNumber(sum, col) : String(sum), key: sum }
    }
    case 'count': {
      const n = cells.filter((c) => c.text !== '').length
      return { text: String(n), key: n }
    }
    case 'concat': {
      const text = cells.map((c) => c.text).filter(Boolean).join(agg.sep ?? ', ')
      return { text, key: text || null }
    }
    default: { // min, max
      let best: Cell | undefined
      for (const c of cells) {
        if (c.key === null) continue
        if (!best || (agg.fn === 'min' ? compareKeys(c.key, best.key!) < 0 : compareKeys(c.key, best.key!) > 0)) best = c
      }
      return best ? { text: best.text, key: best.key } : { text: '', key: null }
    }
  }
}

export function computeView(doc: Y.Doc, def: ViewDef): ViewResult {
  const tables = readTables(doc)
  const table = tables.find((t) => t.id === def.source)
  if (!table) return { missing: true, sourceName: '', columns: [], rows: [], matched: 0 }
  const cells = new Map<string, Map<string, Cell>>()
  for (const c of table.columns) cells.set(c.id, columnCells(doc, tables, table, c))

  // Bedingungen: unvollständige (ohne Wert) und solche auf gelöschte Spalten werden ignoriert
  const active = def.filters.flatMap((f) => {
    const col = table.columns.find((c) => c.id === f.col)
    if (!col || !OPS_BY_TYPE[col.type].includes(f.op) || (opNeedsValue(f.op) && !f.value.trim())) return []
    return [{ col, op: f.op, value: f.value }]
  })
  const test = (rid: string) => {
    if (active.length === 0) return true
    const hit = (f: (typeof active)[number]) => matches(cells.get(f.col.id)!.get(rid)!, f.col, f.op, f.value)
    return def.match === 'any' ? active.some(hit) : active.every(hit)
  }
  const ids = table.rowIds.filter(test)
  const base = { missing: false, sourceName: table.name, matched: ids.length }
  const cellOf = (c: ColumnInfo, rid: string): ViewCell => { const x = cells.get(c.id)!.get(rid)!; return { text: x.text, key: x.key } }

  const groupCol = def.group.mode === 'column' ? table.columns.find((c) => c.id === def.group.col) : undefined
  if (def.group.mode === 'none' || (def.group.mode === 'column' && !groupCol)) {
    return {
      ...base,
      columns: table.columns.map((c) => ({ id: c.id, name: c.name, type: c.type, width: c.width })),
      rows: ids.map((rid) => ({ id: rid, cells: Object.fromEntries(table.columns.map((c) => [c.id, cellOf(c, rid)])) })),
    }
  }

  // Gruppen in der Reihenfolge ihres ersten Auftretens; „ganze Tabelle“ = eine Gruppe
  const groups = new Map<string, string[]>()
  if (groupCol) for (const rid of ids) {
    const k = cells.get(groupCol.id)!.get(rid)!.text
    const g = groups.get(k)
    if (g) g.push(rid); else groups.set(k, [rid])
  } else groups.set('', ids)

  const shown = table.columns.filter((c) => c === groupCol || aggOf(def, c).fn !== 'hide')
  const columns: ViewColumn[] = shown.map((c) => {
    if (c === groupCol) return { id: c.id, name: c.name, type: c.type, width: c.width }
    const a = aggOf(def, c)
    const type: ColType = a.fn === 'sum' || a.fn === 'count' ? 'number' : a.fn === 'concat' ? 'text' : c.type
    return { id: c.id, name: `${c.name} (${aggLabel(c.type, a.fn)})`, type, width: c.width }
  })
  const rows: ViewRow[] = [...groups.entries()].map(([k, rids], i) => ({
    id: `g${i}:${k}`,
    cells: Object.fromEntries(shown.map((c) => [
      c.id,
      c === groupCol ? (rids.length ? cellOf(c, rids[0]) : { text: '', key: null })
        : summarizeGroup(rids.map((r) => cells.get(c.id)!.get(r)!), c, aggOf(def, c)),
    ])),
  }))
  return { ...base, columns, rows }
}
