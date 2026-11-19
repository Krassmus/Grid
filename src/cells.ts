/**
 * Zellwerte als Sortierwert und Anzeigetext – eine Spalte auf einmal. Gemeinsame Grundlage für Sortieren,
 * abgeleitete Tabellen, Rollup-Spalten und die Summenzeile. Berechnete Werte (Rollup) werden hier erzeugt und nie gespeichert.
 */
import * as Y from 'yjs'
import { buildFileIndex, buildLinkIndex, summarize, tablesOf, type ColumnInfo, type TableInfo, type ViewAgg } from './model'
import { formatDate } from './dateFormat'
import { plainText } from './richText'
import { DATE, FORMULA, NUMBER, ROLLUP, TEXT, effectiveType } from './columnTypes'
import { FormulaSyntaxError, parseFormula, type Node } from './formula'
import { allowedAggs, type FooterFn } from './aggregate'

export type Key = number | string | null // null = leer (steht beim Sortieren immer am Ende)
export interface Cell { raw: unknown; text: string; key: Key; /** Nur bei fehlerhaften Formeln: Erklärung (text enthält den Fehlercode). */ error?: string }

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' })
export const compareKeys = (a: number | string, b: number | string): number =>
  typeof a === 'number' && typeof b === 'number' ? a - b : collator.compare(String(a), String(b))

export function fmtNumber(n: number, col: ColumnInfo): string {
  const cfg = col.type === 'number' ? NUMBER.config(col) : { decimals: -1, unit: '' }
  const s = cfg.decimals >= 0 ? n.toFixed(cfg.decimals) : String(Number(n.toPrecision(12)))
  return cfg.unit ? `${s} ${cfg.unit}` : s
}

const EMPTY: Cell = { raw: null, text: '', key: null }

/** Zwischenspeicher für eine Auswertung: jede Spalte wird dabei nur einmal berechnet, die Verknüpfungen nur einmal gelesen. */
export interface CellCtx {
  cache: Map<string, Map<string, Cell>>
  links?: Map<string, string[]>
  files?: Map<string, { name: string }[]>
}
export const newCtx = (): CellCtx => ({ cache: new Map() })
const MAX_DEPTH = 12

/** Zellen einer Spalte, je Zeilen-ID. `stack` (Spalten, die gerade berechnet werden) erkennt Zyklen. */
export function columnCells(doc: Y.Doc, tables: TableInfo[], table: TableInfo, col: ColumnInfo, ctx: CellCtx = newCtx(), stack: string[] = []): Map<string, Cell> {
  const me = `${table.id}.${col.id}`
  const computed = col.type === 'rollup' || col.type === 'formula'
  if (computed && (stack.includes(me) || stack.length > MAX_DEPTH)) {
    const cyc: Cell = col.type === 'formula' ? { raw: null, text: '#ZYKLUS', key: null, error: 'Die Formel verweist (auch über andere Spalten) auf sich selbst' } : EMPTY
    return new Map(table.rowIds.map((rid) => [rid, cyc]))
  }
  const hit = ctx.cache.get(me)
  if (hit) return hit
  const out = col.type === 'rollup' ? rollupCells(doc, tables, table, col, ctx, [...stack, me])
    : col.type === 'formula' ? formulaCells(doc, tables, table, col, ctx, [...stack, me])
    : plainCells(doc, tables, table, col, ctx)
  ctx.cache.set(me, out)
  return out
}

/** Verknüpfte Zeilen in der Reihenfolge der Zieltabelle (nicht nach ID), damit Verketten ein sinnvolles Ergebnis gibt. */
function inRowOrder(ids: string[], target: TableInfo): string[] {
  const rank = new Map(target.rowIds.map((id, i) => [id, i]))
  return [...ids].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity))
}

function linkIndex(doc: Y.Doc, ctx: CellCtx) { return (ctx.links ??= buildLinkIndex(doc).forward) }
function fileIndex(doc: Y.Doc, ctx: CellCtx) { return (ctx.files ??= buildFileIndex(doc)) }

function rollupCells(doc: Y.Doc, tables: TableInfo[], table: TableInfo, col: ColumnInfo, ctx: CellCtx, stack: string[]): Map<string, Cell> {
  const out = new Map<string, Cell>()
  const cfg = ROLLUP.config(col)
  const rel = table.columns.find((c) => c.id === cfg.rel && c.type === 'relation')
  const target = tables.find((t) => t.id === rel?.target)
  const tcol = target?.columns.find((c) => c.id === cfg.col)
  if (!rel || !target || !tcol || !allowedAggs(effectiveType(tcol, tables)).includes(cfg.fn)) {
    for (const rid of table.rowIds) out.set(rid, EMPTY)
    return out
  }
  const targetCells = columnCells(doc, tables, target, tcol, ctx, stack)
  const links = linkIndex(doc, ctx)
  for (const rid of table.rowIds) {
    const cells = inRowOrder(links.get(`${rid}|${rel.id}`) ?? [], target).flatMap((x) => targetCells.get(x) ?? [])
    const r = summarizeGroup(cells, tcol, { fn: cfg.fn, sep: cfg.sep })
    out.set(rid, { raw: r.key, text: r.text, key: r.key })
  }
  return out
}

function plainCells(doc: Y.Doc, tables: TableInfo[], table: TableInfo, col: ColumnInfo, ctx: CellCtx): Map<string, Cell> {
  const out = new Map<string, Cell>()
  const rows: Y.Map<Y.Map<any>> | undefined = tablesOf(doc).get(table.id)?.get('rows')
  const links = col.type === 'relation' ? linkIndex(doc, ctx) : null
  const files = col.type === 'file' ? fileIndex(doc, ctx) : null
  const target = col.type === 'relation' ? tables.find((t) => t.id === col.target) : undefined
  const rich = col.type === 'text' && TEXT.config(col).mode === 'rich'
  const dateCfg = col.type === 'date' ? DATE.config(col) : null
  for (const rid of table.rowIds) {
    const raw = rows?.get(rid)?.get(col.id)
    let text = ''
    let key: Key = null
    switch (col.type) {
      case 'number':
        if (typeof raw === 'number') { text = fmtNumber(raw, col); key = raw }
        break
      case 'date':
        if (typeof raw === 'string' && raw) { text = formatDate(raw, dateCfg!.style, dateCfg!.time); key = raw }
        break
      case 'select': {
        const i = (col.options ?? []).findIndex((o) => o.id === raw)
        if (i >= 0) { text = col.options![i].name; key = i }
        break
      }
      case 'checkbox': text = raw ? '✓' : ''; key = raw ? 1 : 0; break // nicht angehakt zählt als 0, nie als leer
      case 'relation': {
        const titles = (links?.get(`${rid}|${col.id}`) ?? []).map((x) => (target ? summarize(doc, target, x).title : ''))
        text = titles.filter(Boolean).join(', ')
        key = titles[0] || null
        break
      }
      case 'file': {
        const names = (files?.get(`${rid}|${col.id}`) ?? []).map((f) => f.name)
        text = names.join(', ')
        key = names[0] ?? null
        break
      }
      default:
        if (typeof raw === 'string' && raw) { text = rich ? plainText(raw).trim() : raw; key = text || null }
    }
    out.set(rid, { raw, text, key })
  }
  return out
}

// ---------- Formeln ----------

class FErr { constructor(readonly code: string, readonly msg: string) {} }
type Val = number | string | boolean | null | FErr
const nameKey = (s: string) => s.trim().toLowerCase()

const textOf = (v: Val): string =>
  v === null ? '' : v instanceof FErr ? v.code : typeof v === 'number' ? String(Number(v.toPrecision(12))) : typeof v === 'boolean' ? (v ? 'Wahr' : 'Falsch') : v
const truthy = (v: Val): boolean => (v === null ? false : typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : v !== '')
function numOf(v: Val): number | FErr {
  if (v instanceof FErr) return v
  if (v === null) return 0
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return v
  const n = Number(v.trim())
  return v.trim() === '' || Number.isNaN(n) ? new FErr('#WERT!', `„${v}“ ist keine Zahl`) : n
}

/** Wert einer Zelle für Formeln: Zahlen als Zahl, Kästchen als Wahrheitswert, Datum als ISO-Text, sonst Text; leer = null. */
function valueOf(col: ColumnInfo, c: Cell | undefined): Val {
  if (!c) return null
  if (c.error) return new FErr(c.text, c.error)
  switch (col.type) {
    case 'number': return typeof c.key === 'number' ? c.key : null
    case 'checkbox': return !!c.raw
    case 'date': return typeof c.key === 'string' ? c.key : null
    case 'rollup': case 'formula': return (c.raw as Val) ?? null
    default: return c.text === '' ? null : c.text
  }
}

function compareVals(a: Val, b: Val, op: string): Val {
  if (a instanceof FErr) return a
  if (b instanceof FErr) return b
  let c: number
  if (a === null && b === null) c = 0
  else if ((typeof a === 'number' || a === null || typeof a === 'boolean') && (typeof b === 'number' || b === null || typeof b === 'boolean')) {
    c = (numOf(a) as number) - (numOf(b) as number)
  } else c = collator.compare(textOf(a), textOf(b))
  return op === '=' ? c === 0 : op === '<>' ? c !== 0 : op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0
}

function formulaCells(doc: Y.Doc, tables: TableInfo[], table: TableInfo, col: ColumnInfo, ctx: CellCtx, stack: string[]): Map<string, Cell> {
  const out = new Map<string, Cell>()
  const cfg = FORMULA.config(col)
  const fillAll = (c: Cell) => { for (const rid of table.rowIds) out.set(rid, c); return out }
  if (!cfg.expr.trim()) return fillAll(EMPTY)

  type Getter = (rid: string) => Val
  type ListGetter = (rid: string) => Val[]
  const cellsOf = (t: TableInfo, c: ColumnInfo) => columnCells(doc, tables, t, c, ctx, stack)

  /** Löst Spalte oder Pfad auf: Pfad = Relationen der Reihe nach, am Ende die Spalte der letzten Tabelle. */
  function resolve(parts: string[]): { steps: ColumnInfo[]; table: TableInfo; col: ColumnInfo } {
    let cur = table
    const steps: ColumnInfo[] = []
    for (const part of parts.slice(0, -1)) {
      const rel = cur.columns.find((c) => nameKey(c.name) === nameKey(part) && c.type === 'relation')
      const next = tables.find((t) => t.id === rel?.target)
      if (!rel || !next) throw new FErr('#NAME?', `„${part}“ ist keine Relationsspalte${steps.length ? '' : ' dieser Tabelle'}`)
      steps.push(rel); cur = next
    }
    const last = parts[parts.length - 1]
    const c = cur.columns.find((x) => nameKey(x.name) === nameKey(last))
    if (!c) throw new FErr('#NAME?', `Spalte „${last}“ gibt es nicht${cur === table ? '' : ` in „${cur.name}“`}`)
    return { steps, table: cur, col: c }
  }

  function scalar(n: Node): Getter {
    switch (n.t) {
      case 'num': case 'str': case 'bool': return () => n.v
      case 'ref': {
        if (n.parts.length > 1) throw new FErr('#WERT!', 'Werte verknüpfter Zeilen nur innerhalb von SUMME, MITTELWERT, MIN, MAX, ANZAHL oder TEXTVERBINDEN verwenden')
        const r = resolve(n.parts)
        const cells = cellsOf(r.table, r.col)
        return (rid) => valueOf(r.col, cells.get(rid))
      }
      case 'un': {
        const a = scalar(n.a)
        return (rid) => { const v = numOf(a(rid)); return v instanceof FErr ? v : n.op === '-' ? -v : v }
      }
      case 'bin': {
        const a = scalar(n.a), b = scalar(n.b)
        if (n.op === '&') return (rid) => { const x = a(rid), y = b(rid); return x instanceof FErr ? x : y instanceof FErr ? y : textOf(x) + textOf(y) }
        if (n.op in { '=': 1, '<>': 1, '<': 1, '<=': 1, '>': 1, '>=': 1 }) return (rid) => compareVals(a(rid), b(rid), n.op)
        return (rid) => {
          const x = numOf(a(rid)); if (x instanceof FErr) return x
          const y = numOf(b(rid)); if (y instanceof FErr) return y
          if (n.op === '+') return x + y
          if (n.op === '-') return x - y
          if (n.op === '*') return x * y
          if (n.op === '/') return y === 0 ? new FErr('#DIV/0!', 'Division durch 0') : x / y
          return Math.pow(x, y)
        }
      }
      case 'call': return call(n)
    }
  }

  /** Argumente von Aggregatfunktionen: Pfade (und Relationsspalten) liefern mehrere Werte, alles andere einen. */
  function list(n: Node): ListGetter {
    if (n.t === 'ref' && (n.parts.length > 1 || tableColIsRelation(n.parts[0]))) {
      const r = resolve(n.parts)
      const rels = n.parts.length > 1 ? r.steps : [resolve(n.parts).col]
      const finalTable = n.parts.length > 1 ? r.table : tables.find((t) => t.id === rels[rels.length - 1].target)
      const cells = n.parts.length > 1 ? cellsOf(r.table, r.col) : null
      const links = linkIndex(doc, ctx)
      return (rid) => {
        let ids = [rid]
        for (const rel of rels) {
          const next = new Set<string>()
          for (const id of ids) for (const x of links.get(`${id}|${rel.id}`) ?? []) next.add(x)
          ids = [...next]
        }
        const lastTable = finalTable
        if (lastTable) ids = inRowOrder(ids, lastTable)
        // Relationsspalte allein: die verknüpften Zeilen selbst (Titel), sonst die Werte der gewählten Spalte
        return ids.map((id) => (cells ? valueOf(r.col, cells.get(id)) : finalTable ? summarize(doc, finalTable, id).title : null))
      }
    }
    const g = scalar(n)
    return (rid) => [g(rid)]
  }
  const tableColIsRelation = (name: string) => table.columns.some((c) => nameKey(c.name) === nameKey(name) && c.type === 'relation')

  function call(n: Extract<Node, { t: 'call' }>): Getter {
    if (!n.fn) throw new FErr('#NAME?', `Unbekannte Funktion „${n.name}“`)
    const need = (min: number, max = min) => {
      if (n.args.length < min || n.args.length > max) throw new FErr('#SYNTAX', `${n.name} erwartet ${min === max ? min : `${min} bis ${max}`} Argument${max === 1 ? '' : 'e'}`)
    }
    switch (n.fn) {
      case 'SUM': case 'AVG': case 'MIN': case 'MAX': case 'COUNT': {
        need(1, 99)
        const lists = n.args.map(list)
        return (rid) => {
          const vals = lists.flatMap((l) => l(rid))
          const err = vals.find((v): v is FErr => v instanceof FErr)
          if (err) return err
          const nums = vals.filter((v): v is number => typeof v === 'number')
          if (n.fn === 'COUNT') return vals.filter((v) => v !== null && v !== '').length
          if (n.fn === 'SUM') return nums.reduce((a, b) => a + b, 0)
          if (n.fn === 'AVG') return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null
          if (nums.length) return n.fn === 'MIN' ? Math.min(...nums) : Math.max(...nums)
          const strs = vals.filter((v): v is string => typeof v === 'string' && v !== '')
          if (!strs.length) return null
          return strs.reduce((a, b) => ((n.fn === 'MIN') === (collator.compare(b, a) < 0) ? b : a))
        }
      }
      case 'JOIN': {
        need(1, 99)
        const withSep = n.args.length >= 2
        const sep = withSep ? scalar(n.args[n.args.length - 1]) : () => ', '
        const lists = (withSep ? n.args.slice(0, -1) : n.args).map(list)
        return (rid) => {
          const s = sep(rid)
          const vals = lists.flatMap((l) => l(rid))
          const err = vals.find((v): v is FErr => v instanceof FErr) ?? (s instanceof FErr ? s : undefined)
          return err ?? vals.map(textOf).filter(Boolean).join(textOf(s as Val))
        }
      }
      case 'IF': {
        need(2, 3)
        const c = scalar(n.args[0]), a = scalar(n.args[1]), b = n.args[2] ? scalar(n.args[2]) : () => null
        return (rid) => { const v = c(rid); return v instanceof FErr ? v : truthy(v) ? a(rid) : b(rid) }
      }
      case 'AND': case 'OR': {
        need(1, 99)
        const args = n.args.map(scalar)
        return (rid) => {
          const vals = args.map((g) => g(rid))
          const err = vals.find((v): v is FErr => v instanceof FErr)
          return err ?? (n.fn === 'AND' ? vals.every(truthy) : vals.some(truthy))
        }
      }
      case 'NOT': { need(1); const a = scalar(n.args[0]); return (rid) => { const v = a(rid); return v instanceof FErr ? v : !truthy(v) } }
      case 'ISEMPTY': { need(1); const a = scalar(n.args[0]); return (rid) => { const v = a(rid); return v instanceof FErr ? v : v === null || v === '' } }
      case 'ABS': { need(1); const a = scalar(n.args[0]); return (rid) => { const v = numOf(a(rid)); return v instanceof FErr ? v : Math.abs(v) } }
      case 'ROUND': {
        need(1, 2)
        const a = scalar(n.args[0]), d = n.args[1] ? scalar(n.args[1]) : () => 0
        return (rid) => {
          const v = numOf(a(rid)); if (v instanceof FErr) return v
          const k = numOf(d(rid)); if (k instanceof FErr) return k
          const f = 10 ** Math.max(0, Math.min(10, Math.round(k)))
          return Math.round((v + Number.EPSILON) * f) / f
        }
      }
    }
    throw new FErr('#NAME?', `Unbekannte Funktion „${n.name}“`)
  }

  let get: Getter
  try { get = scalar(parseFormula(cfg.expr)) } catch (e) {
    if (e instanceof FormulaSyntaxError) return fillAll({ raw: null, text: '#SYNTAX', key: null, error: e.message })
    if (e instanceof FErr) return fillAll({ raw: null, text: e.code, key: null, error: e.msg })
    throw e
  }
  for (const rid of table.rowIds) {
    const v = get(rid)
    if (v instanceof FErr) out.set(rid, { raw: null, text: v.code, key: null, error: v.msg })
    else if (v === null) out.set(rid, EMPTY)
    else if (typeof v === 'number') {
      if (!Number.isFinite(v)) { out.set(rid, { raw: null, text: '#WERT!', key: null, error: 'Das Ergebnis ist keine Zahl' }); continue }
      const s = cfg.decimals >= 0 ? v.toFixed(cfg.decimals) : String(Number(v.toPrecision(12)))
      out.set(rid, { raw: v, text: cfg.unit ? `${s} ${cfg.unit}` : s, key: v })
    }
    else if (typeof v === 'boolean') out.set(rid, { raw: v, text: v ? 'Wahr' : 'Falsch', key: v ? 1 : 0 })
    else out.set(rid, { raw: v, text: v, key: v || null })
  }
  return out
}

/** Fasst die Zellen einer Gruppe (oder die verknüpften Zeilen eines Rollups) zu einem Wert zusammen. */
export function summarizeGroup(cells: Cell[], col: ColumnInfo, agg: ViewAgg): { text: string; key: Key } {
  switch (agg.fn) {
    case 'sum': {
      const sum = cells.reduce((n, c) => n + (typeof c.key === 'number' ? c.key : 0), 0)
      return { text: col.type === 'number' ? fmtNumber(sum, col) : String(Number(sum.toPrecision(12))), key: sum }
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

/** Ergebnis einer Auswertung der Summenzeile als Anzeigetext. */
export function footerText(cells: Cell[], col: ColumnInfo, fn: FooterFn): string {
  const filled = cells.filter((c) => c.text !== '')
  const nums = cells.flatMap((c) => (typeof c.key === 'number' && (col.type !== 'select') ? [c.key] : []))
  const fmt = (n: number) => fmtNumber(Number(n.toPrecision(12)), col)
  switch (fn) {
    case 'count': return String(filled.length)
    case 'empty': return String(cells.length - filled.length)
    case 'sum': return fmt(nums.reduce((a, b) => a + b, 0))
    case 'avg': {
      if (nums.length === 0) return ''
      const avg = nums.reduce((a, b) => a + b, 0) / nums.length
      const d = col.type === 'number' ? NUMBER.config(col).decimals : -1
      return fmt(d >= 0 ? avg : Math.round(avg * 100) / 100)
    }
    case 'percent': {
      if (cells.length === 0) return ''
      return `${Math.round((1000 * cells.filter((c) => c.key === 1).length) / cells.length) / 10} %`
    }
    default: return summarizeGroup(cells, col, { fn }).text // min, max
  }
}
