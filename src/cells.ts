/**
 * Zellwerte als Sortierwert und Anzeigetext – eine Spalte auf einmal. Gemeinsame Grundlage für Sortieren,
 * abgeleitete Tabellen, Rollup-Spalten und die Summenzeile. Berechnete Werte (Rollup) werden hier erzeugt und nie gespeichert.
 */
import * as Y from 'yjs'
import { reprMap } from './repr'
import { buildFileIndex, buildLinkIndex, isComputed, parseStamp, personIds, personName, tablesOf, type ColumnInfo, type TableInfo, type ViewAgg } from './model'
import { floatingFromMs, formatDate } from './dateFormat'
import { decodeGeo, formatGeo } from './geo'
import { plainText } from './richText'
import { DATE, DURATION, FORMULA, GEO, NUMBER, ROLLUP, STAMP, TEMPLATE, TEXT, effectiveType } from './columnTypes'
import { formatDuration } from './duration'
import { FormulaSyntaxError, parseFormula, parseTemplate, type Node } from './formula'
import { allowedAggs, type FooterFn } from './aggregate'
import { t } from './i18n'

export type Key = number | string | null // null = leer (steht beim Sortieren immer am Ende)
export interface Cell { raw: unknown; text: string; key: Key; /** Nur bei fehlerhaften Formeln: Erklärung (text enthält den Fehlercode). */ error?: string }

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' })
export const compareKeys = (a: number | string, b: number | string): number =>
  typeof a === 'number' && typeof b === 'number' ? a - b : collator.compare(String(a), String(b))

export function fmtNumber(n: number, col: ColumnInfo): string {
  if (col.type === 'duration') return formatDuration(n, DURATION.config(col).format)
  const cfg = col.type === 'number' ? NUMBER.config(col) : { decimals: -1, unit: '' }
  const s = cfg.decimals >= 0 ? n.toFixed(cfg.decimals) : String(Number(n.toPrecision(12)))
  return cfg.unit ? `${s} ${cfg.unit}` : s
}

const EMPTY: Cell = { raw: null, text: '', key: null }

/** Zwischenspeicher für eine Auswertung: jede Spalte wird dabei nur einmal berechnet, die Verknüpfungen nur einmal gelesen. */
export interface CellCtx {
  cache: Map<string, Map<string, Cell>>
  links?: Map<string, string[]>
  files?: Map<string, { name: string; mime?: string; hash?: string }[]>
  /** Darstellung der Zeilen je Tabelle (repr.ts) */
  reprs?: Map<string, Map<string, import('./repr').Repr>>
  reprBusy?: Set<string>
}
export const newCtx = (): CellCtx => ({ cache: new Map() })
const MAX_DEPTH = 12

/** Zellen einer Spalte, je Zeilen-ID. `stack` (Spalten, die gerade berechnet werden) erkennt Zyklen. */
export function columnCells(doc: Y.Doc, tables: TableInfo[], table: TableInfo, col: ColumnInfo, ctx: CellCtx = newCtx(), stack: string[] = []): Map<string, Cell> {
  const me = `${table.id}.${col.id}`
  const computed = isComputed(col)
  if (computed && (stack.includes(me) || stack.length > MAX_DEPTH)) {
    const cyc: Cell = col.type !== 'rollup' ? { raw: null, text: '#ZYKLUS', key: null, error: t('Die Formel verweist (auch über andere Spalten) auf sich selbst') } : EMPTY
    return new Map(table.rowIds.map((rid) => [rid, cyc]))
  }
  const hit = ctx.cache.get(me)
  if (hit) return hit
  const cacheable = OWN_VALUE.has(col.type)
  const kept = cacheable ? persistent(doc).read(table, col, (only, base) => plainCells(doc, tables, table, col, ctx, only, base)) : null
  if (kept) { ctx.cache.set(me, kept); return kept }
  const out = col.type === 'rollup' ? rollupCells(doc, tables, table, col, ctx, [...stack, me])
    : col.type === 'formula' || col.type === 'template' ? formulaCells(doc, tables, table, col, ctx, [...stack, me])
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
export function fileIndex(doc: Y.Doc, ctx: CellCtx) { return (ctx.files ??= buildFileIndex(doc)) }

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

// ---------- Dauerhafter Zwischenspeicher ----------
// Spalten, deren Werte nur von der eigenen Zelle abhängen, bleiben zwischen den Auswertungen erhalten. Eine Änderung an einer Zelle
// merkt nur diese Zeile zum Neuberechnen vor; jede andere Änderung (Zeilen, Spalten, Verknüpfungen, Profile …) leert alles.

const OWN_VALUE = new Set(['text', 'number', 'date', 'select', 'checkbox', 'link', 'duration', 'geo'])

interface Kept { sig: string; rowIds: string[]; cells: Map<string, Cell>; dirty: Set<string> }

class Persistent {
  private entries = new Map<string, Kept>()
  constructor(private doc: Y.Doc) {
    doc.on('afterTransaction', (tr: Y.Transaction) => this.changed(tr))
  }
  private changed(tr: Y.Transaction) {
    if (this.entries.size === 0) return
    const tables = tablesOf(this.doc)
    for (const [type, keys] of tr.changed) {
      const rows = type.parent as Y.AbstractType<unknown> | null
      const table = rows?.parent as Y.AbstractType<unknown> | null
      const isRow = !!rows && !!table && table.parent === (tables as unknown) && (table as Y.Map<any>).get('rows') === (rows as unknown)
      if (!isRow) { this.entries.clear(); return }
      const rowId = type._item?.parentSub, tableId = table._item?.parentSub
      if (!rowId || !tableId) { this.entries.clear(); return }
      for (const colId of keys) this.entries.get(`${tableId}.${colId}`)?.dirty.add(rowId)
    }
  }
  /** Gespeicherte Werte der Spalte (aufgefrischt) oder, nach einer Neuberechnung mit `compute`, die frischen. */
  read(table: TableInfo, col: ColumnInfo, compute: (only?: string[], base?: Map<string, Cell>) => Map<string, Cell>): Map<string, Cell> {
    const key = `${table.id}.${col.id}`
    const sig = JSON.stringify(col)
    const e = this.entries.get(key)
    if (e && e.sig === sig && sameIds(e.rowIds, table.rowIds)) {
      if (e.dirty.size === 0) return e.cells
      // Die Karte wird kopiert, damit Aufrufer, die die alte noch halten, unverändert bleiben
      const dirty = [...e.dirty]
      const cells = compute(dirty, new Map(e.cells))
      deltas.set(cells, { prev: e.cells, dirty })
      this.entries.set(key, { ...e, cells, dirty: new Set() })
      return cells
    }
    const cells = compute()
    this.entries.set(key, { sig, rowIds: table.rowIds, cells, dirty: new Set() })
    return cells
  }
}
const sameIds = (a: string[], b: string[]) => a === b || (a.length === b.length && a.every((x, i) => x === b[i]))

/** Woraus eine aufgefrischte Karte entstand: die vorherige und die Zeilen, die neu berechnet wurden (für schrittweises Nachsortieren). */
const deltas = new WeakMap<Map<string, Cell>, { prev: Map<string, Cell>; dirty: string[] }>()
export const cellDelta = (cells: Map<string, Cell>) => deltas.get(cells)

const persistents = new WeakMap<Y.Doc, Persistent>()
const persistent = (doc: Y.Doc) => { let p = persistents.get(doc); if (!p) persistents.set(doc, p = new Persistent(doc)); return p }

function plainCells(doc: Y.Doc, tables: TableInfo[], table: TableInfo, col: ColumnInfo, ctx: CellCtx, only?: string[], base?: Map<string, Cell>): Map<string, Cell> {
  const out = base ?? new Map<string, Cell>()
  const rows: Y.Map<Y.Map<any>> | undefined = tablesOf(doc).get(table.id)?.get('rows')
  const links = col.type === 'relation' ? linkIndex(doc, ctx) : null
  const files = col.type === 'file' ? fileIndex(doc, ctx) : null
  const target = col.type === 'relation' ? tables.find((t) => t.id === col.target) : undefined
  const rich = col.type === 'text' && TEXT.config(col).mode === 'rich'
  const dateCfg = col.type === 'date' ? DATE.config(col) : null
  // Aufsteigende Zahl: Rang der Zeitmarke unter allen Zeilen (bei gleicher Marke entscheidet die Zeilen-ID)
  let rank: Map<string, number> | null = null
  if (col.type === 'autonumber') {
    const stamp = (id: string) => { const v = rows?.get(id)?.get(col.id); return typeof v === 'number' ? v : 0 }
    rank = new Map([...table.rowIds].sort((a, b) => stamp(a) - stamp(b) || (a < b ? -1 : a > b ? 1 : 0)).map((id, i) => [id, i + 1]))
  }
  for (const rid of only ?? table.rowIds) {
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
      case 'geo': { // Sortierung nach Breite (Nord-Süd), Text im eingestellten Format
        const g = decodeGeo(raw)
        if (g) { text = formatGeo(g, GEO.config(col).format); key = g.lat }
        break
      }
      case 'duration':
        if (typeof raw === 'number') { text = fmtNumber(raw, col); key = raw }
        break
      case 'stamp': { // Sortierung nach Zeit; der Name steht nur im Text
        const st = parseStamp(raw)
        if (st) {
          const name = STAMP.config(col).by ? personName(doc, st.account) : ''
          text = formatDate(floatingFromMs(st.at), 'short', true) + (name ? ` · ${name}` : '')
          key = st.at
        }
        break
      }
      case 'person': {
        const names = personIds(raw).map((id) => personName(doc, id) || t('Unbekannt'))
        text = names.join(', ')
        key = names[0] ?? null
        break
      }
      case 'autonumber': { const n = rank!.get(rid)!; out.set(rid, { raw: n, text: String(n), key: n }); continue }
      case 'checkbox': text = raw ? '✓' : ''; key = raw ? 1 : 0; break // nicht angehakt zählt als 0, nie als leer
      case 'relation': {
        const titles = (links?.get(`${rid}|${col.id}`) ?? []).map((x) => (target ? reprMap(doc, tables, target, ctx).get(x)?.title ?? '' : ''))
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
  v === null ? '' : v instanceof FErr ? v.code : typeof v === 'number' ? String(Number(v.toPrecision(12))) : typeof v === 'boolean' ? (v ? t('Wahr') : t('Falsch')) : v
const truthy = (v: Val): boolean => (v === null ? false : typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : v !== '')
function numOf(v: Val): number | FErr {
  if (v instanceof FErr) return v
  if (v === null) return 0
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return v
  const n = Number(v.trim())
  return v.trim() === '' || Number.isNaN(n) ? new FErr('#WERT!', t('„{v}“ ist keine Zahl', { v })) : n
}

/** Wert einer Zelle für Formeln: Zahlen als Zahl, Kästchen als Wahrheitswert, Datum als ISO-Text, sonst Text; leer = null. */
function valueOf(col: ColumnInfo, c: Cell | undefined): Val {
  if (!c) return null
  if (c.error) return new FErr(c.text, c.error)
  switch (col.type) {
    case 'number': case 'duration': return typeof c.key === 'number' ? c.key : null
    case 'checkbox': return !!c.raw
    case 'date': return typeof c.key === 'string' ? c.key : null
    case 'rollup': case 'formula': case 'template': return (c.raw as Val) ?? null
    default: return c.text === '' ? null : c.text
  }
}

// ---------- Datum in Formeln ----------
// Datumswerte sind Text im Format JJJJ-MM-TT (mit Uhrzeit JJJJ-MM-TTTHH:MM). Gerechnet wird mit ganzen Kalendertagen,
// ohne Zeitzonen- und Sommerzeitprobleme; „heute“ ist der Kalendertag auf diesem Gerät.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/
const DAY_MS = 86_400_000
const utcDay = (y: number, m: number, d: number) => { const t = new Date(0); t.setUTCFullYear(y, m - 1, d); return t.getTime() / DAY_MS }
const todayNumber = () => { const n = new Date(); return utcDay(n.getFullYear(), n.getMonth() + 1, n.getDate()) }
const pad = (n: number) => String(n).padStart(2, '0')

/** Tage seit 1970 für einen Datumswert; `null` bei leer, Fehler bei Text, der kein Datum ist. */
function dayNumber(v: Val): number | null | FErr {
  if (v instanceof FErr) return v
  if (v === null || v === '') return null
  const m = typeof v === 'string' ? ISO_DATE.exec(v.trim()) : null
  const bad = () => new FErr('#WERT!', t('„{v}“ ist kein Datum (erwartet JJJJ-MM-TT)', { v: textOf(v) }))
  if (!m) return bad()
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const n = utcDay(y, mo, d)
  const back = new Date(n * DAY_MS)
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? n : bad()
}

/** Datum als Text; nur Jahre 1000 bis 9999 sind darstellbar. */
function isoDay(n: number): string | FErr {
  const dt = new Date(n * DAY_MS)
  const y = dt.getUTCFullYear()
  return y < 1000 || y > 9999 ? new FErr('#WERT!', t('Das Datum liegt außerhalb der Jahre 1000 bis 9999')) : `${y}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
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
  const template = col.type === 'template'
  const cfg = template ? { expr: TEMPLATE.config(col).tpl, decimals: -1, unit: '' } : FORMULA.config(col)
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
      if (!rel || !next) throw new FErr('#NAME?', t(steps.length ? '„{part}“ ist keine Relationsspalte' : '„{part}“ ist keine Relationsspalte dieser Tabelle', { part }))
      steps.push(rel); cur = next
    }
    const last = parts[parts.length - 1]
    const c = cur.columns.find((x) => nameKey(x.name) === nameKey(last))
    if (!c) throw new FErr('#NAME?', cur === table ? t('Spalte „{last}“ gibt es nicht', { last }) : t('Spalte „{last}“ gibt es nicht in „{table}“', { last, table: cur.name }))
    return { steps, table: cur, col: c }
  }

  function scalar(n: Node): Getter {
    switch (n.t) {
      case 'num': case 'str': case 'bool': return () => n.v
      case 'ref': {
        if (n.parts.length > 1) throw new FErr('#WERT!', t('Werte verknüpfter Zeilen nur innerhalb von SUMME, MITTELWERT, MIN, MAX, ANZAHL oder TEXTVERBINDEN verwenden'))
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
          if (n.op === '/') return y === 0 ? new FErr('#DIV/0!', t('Division durch 0')) : x / y
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
        return ids.map((id) => (cells ? valueOf(r.col, cells.get(id)) : finalTable ? reprMap(doc, tables, finalTable, ctx).get(id)?.title ?? null : null))
      }
    }
    const g = scalar(n)
    return (rid) => [g(rid)]
  }
  const tableColIsRelation = (name: string) => table.columns.some((c) => nameKey(c.name) === nameKey(name) && c.type === 'relation')

  function call(n: Extract<Node, { t: 'call' }>): Getter {
    if (!n.fn) throw new FErr('#NAME?', t('Unbekannte Funktion „{name}“', { name: n.name }))
    const need = (min: number, max = min) => {
      if (n.args.length < min || n.args.length > max) throw new FErr('#SYNTAX', t(max === 1 && min === 1 ? '{name} erwartet {range} Argument' : '{name} erwartet {range} Argumente', { name: n.name, range: min === max ? min : t('{a} bis {b}', { a: min, b: max }) }))
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
      // ----- Datum -----
      case 'TODAY': { need(0); return () => isoDay(todayNumber()) }
      case 'NOW': { need(0); return () => { const t = new Date(); const d = isoDay(utcDay(t.getFullYear(), t.getMonth() + 1, t.getDate())); return d instanceof FErr ? d : `${d}T${pad(t.getHours())}:${pad(t.getMinutes())}` } }
      case 'DAYSINCE': case 'DAYSUNTIL': {
        need(1)
        const a = scalar(n.args[0])
        return (rid) => { const d = dayNumber(a(rid)); return d === null || d instanceof FErr ? d : n.fn === 'DAYSINCE' ? todayNumber() - d : d - todayNumber() }
      }
      case 'DAYS': { // TAGE(von; bis)
        need(2)
        const a = scalar(n.args[0]), b = scalar(n.args[1])
        return (rid) => { const x = dayNumber(a(rid)); if (x instanceof FErr) return x; const y = dayNumber(b(rid)); if (y instanceof FErr) return y; return x === null || y === null ? null : y - x }
      }
      case 'YEAR': case 'MONTH': case 'DAY': case 'WEEKDAY': {
        need(1)
        const a = scalar(n.args[0])
        return (rid) => {
          const d = dayNumber(a(rid)); if (d === null || d instanceof FErr) return d
          const t = new Date(d * DAY_MS)
          return n.fn === 'YEAR' ? t.getUTCFullYear() : n.fn === 'MONTH' ? t.getUTCMonth() + 1 : n.fn === 'DAY' ? t.getUTCDate() : ((t.getUTCDay() + 6) % 7) + 1 // Montag = 1
        }
      }
      case 'ADDDAYS': {
        need(2)
        const a = scalar(n.args[0]), k = scalar(n.args[1])
        return (rid) => {
          const v = a(rid), d = dayNumber(v); if (d === null || d instanceof FErr) return d
          const x = numOf(k(rid)); if (x instanceof FErr) return x
          const out = isoDay(d + Math.round(x))
          const time = typeof v === 'string' ? ISO_DATE.exec(v.trim())?.[4] : undefined
          return out instanceof FErr || time === undefined ? out : `${out}T${time}:${ISO_DATE.exec((v as string).trim())![5]}`
        }
      }
      case 'AGE': { // ALTER(Geburtsdatum; [bis]) in vollen Jahren
        need(1, 2)
        const a = scalar(n.args[0]), b = n.args[1] ? scalar(n.args[1]) : null
        return (rid) => {
          const from = dayNumber(a(rid)); if (from === null || from instanceof FErr) return from
          const to = b ? dayNumber(b(rid)) : todayNumber(); if (to === null || to instanceof FErr) return to
          const f = new Date(from * DAY_MS), t = new Date(to * DAY_MS)
          const years = t.getUTCFullYear() - f.getUTCFullYear()
          return t.getUTCMonth() * 100 + t.getUTCDate() < f.getUTCMonth() * 100 + f.getUTCDate() ? years - 1 : years
        }
      }
      case 'DATE': { // DATUM(Jahr; Monat; Tag), Überlauf läuft in den nächsten Monat/ins nächste Jahr
        need(3)
        const g = n.args.map(scalar)
        return (rid) => {
          const p: number[] = []
          for (const x of g) { const v = numOf(x(rid)); if (v instanceof FErr) return v; p.push(Math.trunc(v)) }
          const t = new Date(0); t.setUTCFullYear(p[0], p[1] - 1, p[2])
          return isoDay(t.getTime() / DAY_MS)
        }
      }
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
    throw new FErr('#NAME?', t('Unbekannte Funktion „{name}“', { name: n.name }))
  }

  let get: Getter
  try { get = scalar(template ? parseTemplate(cfg.expr) : parseFormula(cfg.expr)) } catch (e) {
    if (e instanceof FormulaSyntaxError) return fillAll({ raw: null, text: '#SYNTAX', key: null, error: e.message })
    if (e instanceof FErr) return fillAll({ raw: null, text: e.code, key: null, error: e.msg })
    throw e
  }
  for (const rid of table.rowIds) {
    const v = get(rid)
    if (v instanceof FErr) out.set(rid, { raw: null, text: v.code, key: null, error: v.msg })
    else if (v === null) out.set(rid, EMPTY)
    else if (typeof v === 'number') {
      if (!Number.isFinite(v)) { out.set(rid, { raw: null, text: '#WERT!', key: null, error: t('Das Ergebnis ist keine Zahl') }); continue }
      const s = cfg.decimals >= 0 ? v.toFixed(cfg.decimals) : String(Number(v.toPrecision(12)))
      out.set(rid, { raw: v, text: cfg.unit ? `${s} ${cfg.unit}` : s, key: v })
    }
    else if (typeof v === 'boolean') out.set(rid, { raw: v, text: v ? t('Wahr') : t('Falsch'), key: v ? 1 : 0 })
    else out.set(rid, v === '' ? EMPTY : { raw: v, text: v, key: v })
  }
  return out
}

/** Fasst die Zellen einer Gruppe (oder die verknüpften Zeilen eines Rollups) zu einem Wert zusammen. */
export function summarizeGroup(cells: Cell[], col: ColumnInfo, agg: ViewAgg): { text: string; key: Key } {
  switch (agg.fn) {
    case 'sum': {
      const sum = cells.reduce((n, c) => n + (typeof c.key === 'number' ? c.key : 0), 0)
      return { text: col.type === 'number' || col.type === 'duration' ? fmtNumber(sum, col) : String(Number(sum.toPrecision(12))), key: sum }
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
