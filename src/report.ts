/**
 * Berichte: Text mit Platzhaltern `{{ }}` und eingefügte Tabellen. Ein Bericht speichert nur diese Vorlage; Werte und Tabellen
 * werden bei jeder Anzeige neu berechnet.
 *
 * In `{{ }}` gilt die Formelsprache der Formelspalten (formula.ts). Anders als dort gibt es keine „eigene Zeile“: `{{Tabelle.Spalte}}`
 * meint die Spalte in allen Zeilen der Tabelle oder abgeleiteten Tabelle, `{{Tabelle}}` ihre Zeilen (zum Zählen).
 *
 * Wer nicht alles lesen darf, was in einen Wert eingeht, bekommt statt einer unvollständigen Zahl einen Hinweis.
 */
import type * as Y from 'yjs'
import { columnCells, compileFormula, FErr, nameKey, newCtx, valueOf, type Cell, type CellCtx, type FormulaEnv, type Val } from './cells'
import { ringOf } from './colCrypt'
import { DATE, DURATION, FORMULA, NUMBER, ROLLUP, TEMPLATE, effectiveType } from './columnTypes'
import { formatDate } from './dateFormat'
import { formatDuration } from './duration'
import { FormulaSyntaxError, parseFormula, parseTemplate, type Node } from './formula'
import { language, t } from './i18n'
import type { ColumnInfo, TableInfo, ViewInfo } from './model'
import type { Rights } from './rights'
import { orderByKeys } from './sorting'
import { computeView, matchingIds } from './viewEngine'

/** Ergebnis eines Platzhalters: Anzeigetext oder Fehler mit Erklärung. */
export type Result = { ok: true; text: string } | { ok: false; code: string; message: string }

const LOCKED = '#GESPERRT'
const lockedError = () => new FErr(LOCKED, t('Nicht vollständig verfügbar: Dir fehlt das Recht, alle nötigen Daten zu lesen.'))

/** Eine Tabelle oder abgeleitete Tabelle, wie ein Bericht sie anspricht. */
interface Source { name: string; table: TableInfo; view?: ViewInfo }

export interface TableResult {
  name: string
  columns: { id: string; name: string; numeric: boolean }[]
  rows: string[][]
  /** Summenzeile (je Spalte ein Text, leer ohne Summe); `null`: keine */
  totals: string[] | null
}

/** Zahlenformat: Nachkommastellen (-1 = nach Bedarf) und Einheit, oder Dauer. */
type NumberFormat = { duration: 'hm' | 'hms' } | { decimals: number; unit: string }
const PLAIN: NumberFormat = { decimals: -1, unit: '' }

/** Zahl für den Ausdruck: Dezimalzeichen und Tausendertrennung der eingestellten Sprache. */
export function formatNumber(n: number, fmt: NumberFormat = PLAIN): string {
  if ('duration' in fmt) return formatDuration(n, fmt.duration)
  const d = fmt.decimals
  let v = d >= 0 ? n : Number(n.toPrecision(12))
  if (Math.abs(v) < 0.5 * 10 ** -(d >= 0 ? d : 4)) v = 0 // kein „-0,00“ durch Rundungsreste
  const s = new Intl.NumberFormat(language() === 'de' ? 'de-DE' : 'en-US', d >= 0 ? { minimumFractionDigits: d, maximumFractionDigits: d } : { maximumFractionDigits: 4 }).format(v)
  return fmt.unit ? `${s} ${fmt.unit}` : s
}

export function reportEngine(doc: Y.Doc, tables: TableInfo[], views: ViewInfo[], rights: Rights) {
  const ctx: CellCtx = newCtx()
  const cellsOf = (table: TableInfo, col: ColumnInfo) => columnCells(doc, tables, table, col, ctx)
  const sourceOf = (x: TableInfo | ViewInfo): Source | undefined => {
    if ('columns' in x) return { name: x.name, table: x }
    const table = tables.find((y) => y.id === x.def.source)
    return table && { name: x.name, table, view: x }
  }
  function byName(name: string): Source {
    const hits = [...tables, ...views].filter((x) => nameKey(x.name) === nameKey(name))
    if (hits.length > 1) throw new FErr('#NAME?', t('Den Namen „{name}“ gibt es mehrfach. Benenne eine der Tabellen um.', { name }))
    const found = hits[0] && sourceOf(hits[0])
    if (!found) throw new FErr('#NAME?', t('Es gibt keine Tabelle „{name}“.', { name }))
    return found
  }

  // ---------- Darf der Betrachter alles lesen, was eingeht? ----------

  /** Ist die Spalte samt allem, woraus sie berechnet wird, vollständig lesbar? `viaView`: ein Recht an dieser Sicht zählt für ihre Quelle. */
  function readable(table: TableInfo, col: ColumnInfo, viaView?: ViewInfo, seen = new Set<string>()): boolean {
    const key = `${table.id}.${col.id}`
    if (seen.has(key)) return true
    seen.add(key)
    if (ringOf(doc).locked(col.id)) return false
    const granted = rights.colAccess(table.id, col.id) !== 'none' || (!!viaView && !col.hidden && rights.access(viaView.id) !== 'none')
    if (!granted) return false
    const find = (tb: TableInfo, name: string) => tb.columns.find((c) => nameKey(c.name) === nameKey(name))
    if (col.type === 'relation') {
      const target = tables.find((x) => x.id === col.target)
      return !!target && rights.visible(target.id, target.columns.map((c) => c.id))
    }
    if (col.type === 'rollup') {
      const rel = table.columns.find((c) => c.id === ROLLUP.config(col).rel)
      const target = tables.find((x) => x.id === rel?.target)
      const tcol = target?.columns.find((c) => c.id === ROLLUP.config(col).col)
      if (!rel || !target || !tcol) return !rel || !!target // unvollständig eingerichtet: zeigt ohnehin nichts
      return readable(table, rel, undefined, seen) && readable(target, tcol, undefined, seen)
    }
    if (col.type !== 'formula' && col.type !== 'template') return true
    let tree: Node
    try { tree = col.type === 'formula' ? parseFormula(FORMULA.config(col).expr) : parseTemplate(TEMPLATE.config(col).tpl) } catch { return true } // zeigt nur einen Fehler
    return refsOf(tree).every((parts) => {
      let cur = table
      for (let i = 0; i < parts.length; i++) {
        const c = find(cur, parts[i])
        if (!c) return true // unbekannter Name: Fehler statt Wert
        if (!readable(cur, c, undefined, seen)) return false
        if (i < parts.length - 1) { const next = tables.find((x) => x.id === c.target); if (!next) return false; cur = next }
      }
      return true
    })
  }

  /** Die Zeilen der Quelle; bei Sichten nur, wenn alle Bedingungen lesbar sind. */
  function rowsOf(src: Source): string[] {
    const { table, view } = src
    if (!view) {
      if (!rights.visible(table.id, table.columns.map((c) => c.id))) throw lockedError()
      return table.rowIds
    }
    if (rights.access(view.id) === 'none' && !rights.visible(table.id, table.columns.map((c) => c.id))) throw lockedError()
    for (const f of view.def.filters) {
      const c = table.columns.find((x) => x.id === f.col)
      // Bedingungsspalten dürfen in der Sicht ausgeblendet sein: Wer die Sicht lesen darf, sieht ihr Ergebnis
      if (c && !readable(table, { ...c, hidden: false }, view)) throw lockedError()
    }
    return matchingIds(view.def, table, tables, (c) => cellsOf(table, c))
  }

  // ---------- Platzhalter ----------

  /** Spalte einer Quelle, mit Prüfung der Rechte. */
  function column(src: Source, name: string): ColumnInfo {
    const c = src.table.columns.find((x) => nameKey(x.name) === nameKey(name))
    if (!c) throw new FErr('#NAME?', t('Spalte „{last}“ gibt es nicht in „{table}“', { last: name, table: src.name }))
    if (!readable(src.table, c, src.view)) throw lockedError()
    return c
  }

  const env: FormulaEnv = {
    ref: (parts) => {
      byName(parts[0]) // meldet zuerst unbekannte Namen
      throw new FErr('#WERT!', t('Ein Feld meint im Bericht alle Zeilen. Fasse sie zusammen, z. B. SUMME({{{ref}}}) oder ANZAHL({{{ref}}}).', { ref: parts.join('.') }))
    },
    list: (parts) => {
      if (parts.length > 2) throw new FErr('#NAME?', t('Im Bericht heißt ein Feld {{Tabelle.Spalte}}.'))
      const src = byName(parts[0])
      const ids = rowsOf(src)
      if (parts.length === 1) return () => ids
      const col = column(src, parts[1])
      const cells = cellsOf(src.table, col)
      const values: Val[] = ids.map((id) => valueOf(col, cells.get(id)))
      return () => values
    },
  }

  /** Das Zahlenformat der Spalten, aus denen sich der Wert ergibt (nur, wenn es eindeutig passt). */
  function formatOf(tree: Node): NumberFormat {
    if (tree.t === 'call' && tree.fn === 'COUNT') return PLAIN
    if (hasDivision(tree)) return PLAIN // ein Verhältnis trägt keine Einheit
    const found: NumberFormat[] = []
    const visit = (n: Node) => {
      if (n.t === 'un') visit(n.a)
      else if (n.t === 'bin') { visit(n.a); visit(n.b) }
      else if (n.t === 'call') { if (n.fn !== 'COUNT') n.args.forEach(visit) }
      else if (n.t === 'ref' && n.parts.length === 2) {
        try {
          const src = byName(n.parts[0])
          const fmt = columnFormat(src.table, src.table.columns.find((c) => nameKey(c.name) === nameKey(n.parts[1])))
          if (fmt) found.push(fmt)
        } catch { /* meldet schon die Auswertung */ }
      }
    }
    visit(tree)
    const first = found[0]
    return first && found.every((f) => JSON.stringify(f) === JSON.stringify(first)) ? first : PLAIN
  }

  function columnFormat(table: TableInfo, col: ColumnInfo | undefined): NumberFormat | null {
    if (!col) return null
    if (col.type === 'number') { const c = NUMBER.config(col); return { decimals: c.decimals, unit: c.unit } }
    if (col.type === 'duration') return { duration: DURATION.config(col).format }
    if (col.type === 'formula') { const c = FORMULA.config(col); return c.decimals >= 0 || c.unit ? { decimals: c.decimals, unit: c.unit } : null }
    if (col.type === 'rollup') {
      const cfg = ROLLUP.config(col)
      if (cfg.fn === 'count') return null
      const target = tables.find((x) => x.id === table.columns.find((c) => c.id === cfg.rel)?.target)
      return target ? columnFormat(target, target.columns.find((c) => c.id === cfg.col)) : null
    }
    return null
  }

  /** Wertet den Inhalt eines Platzhalters aus. */
  function value(expr: string): Result {
    try {
      const tree = parseFormula(normalize(expr))
      const v = compileFormula(tree, env)('')
      if (v instanceof FErr) return { ok: false, code: v.code, message: v.msg }
      if (v === null) return { ok: true, text: '' }
      if (typeof v === 'number') return Number.isFinite(v) ? { ok: true, text: formatNumber(v, formatOf(tree)) } : { ok: false, code: '#WERT!', message: t('Das Ergebnis ist keine Zahl') }
      if (typeof v === 'boolean') return { ok: true, text: v ? t('Wahr') : t('Falsch') }
      return { ok: true, text: /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(v) ? formatDate(v, 'long', v.length > 10) : v }
    } catch (e) {
      if (e instanceof FormulaSyntaxError) return { ok: false, code: '#SYNTAX', message: e.message }
      if (e instanceof FErr) return { ok: false, code: e.code, message: e.msg }
      throw e
    }
  }

  // ---------- Eingefügte Tabellen ----------

  /** Inhalt einer eingefügten Tabelle; `null`: Die Quelle gibt es nicht (mehr). */
  function table(sourceId: string, hide: readonly string[] = [], totals = false): TableResult | { name: string; error: string } | null {
    const found = tables.find((x) => x.id === sourceId) ?? views.find((x) => x.id === sourceId)
    const src = found && sourceOf(found)
    if (!src) return null
    try {
      let ids = rowsOf(src)
      const grouped = !!src.view && src.view.def.group.mode !== 'none'
      const view = grouped ? computeView(doc, src.view!.def) : null
      const cols = view ? view.columns.filter((c) => !hide.includes(c.id)) : src.table.columns.filter((c) => !c.hidden && !hide.includes(c.id))
      const originals = cols.map((c) => src.table.columns.find((x) => x.id === c.id)!)
      for (const c of originals) if (!readable(src.table, c, src.view)) throw lockedError()
      const sort = src.table.sort
      const sortCol = !view && sort && src.table.columns.find((c) => c.id === sort.colId)
      if (sort && sortCol && readable(src.table, sortCol, src.view)) {
        const cells = cellsOf(src.table, sortCol)
        ids = orderByKeys(ids, new Map(ids.map((id) => [id, cells.get(id)?.key ?? null])), sort.dir)
      }
      // je Spalte: Format der Zahlen und ob eine Summe Sinn ergibt
      const info = originals.map((c) => {
        const type = effectiveType(c, tables)
        const agg = view && c.id !== (src.view!.def.group.mode === 'column' ? src.view!.def.group.col : undefined) ? viewAggregate(src.view!, c, type) : null
        const numeric = agg ? agg === 'sum' || agg === 'count' || ((agg === 'min' || agg === 'max') && type === 'number') : type === 'number' || type === 'duration'
        const fmt = agg === 'count' || c.type === 'autonumber' ? PLAIN : columnFormat(src.table, c) ?? PLAIN
        const summable = c.type !== 'autonumber' && (agg ? agg === 'sum' || agg === 'count' : type === 'number' || type === 'duration')
        return { numeric, fmt, summable }
      })
      const keys: (number | string | null)[][] = view
        ? view.rows.map((r) => cols.map((c) => r.cells[c.id]?.key ?? null))
        : ids.map((id) => originals.map((c) => cellsOf(src.table, c).get(id)?.key ?? null))
      const texts: string[][] = view
        ? view.rows.map((r) => cols.map((c) => r.cells[c.id]?.text ?? ''))
        : ids.map((id) => originals.map((c) => cellText(cellsOf(src.table, c).get(id), c)))
      const rows = texts.map((row, y) => row.map((text, x) => {
        const k = keys[y][x]
        return info[x].numeric && typeof k === 'number' && text !== '' && !text.startsWith('#') ? formatNumber(k, info[x].fmt) : text
      }))
      let sums: string[] | null = null
      if (totals && info.some((i) => i.summable)) {
        sums = info.map((i, x) => (i.summable ? formatNumber(keys.reduce<number>((n, row) => n + (typeof row[x] === 'number' ? (row[x] as number) : 0), 0), i.fmt) : ''))
        const label = info.findIndex((i) => !i.summable)
        if (label >= 0) sums[label] = t('Summe')
      }
      return {
        name: src.name,
        columns: cols.map((c, x) => ({ id: c.id, name: view ? c.name : originals[x].name, numeric: info[x].numeric })),
        rows, totals: sums,
      }
    } catch (e) {
      if (e instanceof FErr) return { name: src.name, error: e.msg }
      throw e
    }
  }

  function viewAggregate(view: ViewInfo, col: ColumnInfo, type: string) {
    return view.def.aggs[col.id]?.fn ?? (type === 'number' || type === 'checkbox' ? 'sum' : 'concat')
  }

  return { value, table, isLocked: (r: Result) => !r.ok && r.code === LOCKED }
}

const cellText = (cell: Cell | undefined, col: ColumnInfo) => {
  if (!cell) return ''
  if (col.type === 'date' && typeof cell.raw === 'string' && cell.raw) { const c = DATE.config(col); return formatDate(cell.raw, c.style, c.time) }
  return cell.text
}

const refsOf = (n: Node, out: string[][] = []): string[][] => {
  if (n.t === 'ref') out.push(n.parts)
  else if (n.t === 'un') refsOf(n.a, out)
  else if (n.t === 'bin') { refsOf(n.a, out); refsOf(n.b, out) }
  else if (n.t === 'call') n.args.forEach((a) => refsOf(a, out))
  return out
}
const hasDivision = (n: Node): boolean =>
  n.t === 'un' ? hasDivision(n.a) : n.t === 'bin' ? n.op === '/' || hasDivision(n.a) || hasDivision(n.b) : n.t === 'call' ? n.args.some(hasDivision) : false

/** Was Textfelder gern selbst ändern: geschützte Leerzeichen und typografische Anführungszeichen. */
export const normalize = (expr: string) => expr.replace(/ /g, ' ').replace(/[“”„]/g, '"')

/** Der Platzhalter, den die Einfügehilfe schreibt. */
export function placeholderFor(fn: string, source: string, column: string | null): string {
  return `{{ ${fn}({{${column === null ? source : `${source}.${column}`}}}) }}`
}
