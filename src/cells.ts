/**
 * Zellwerte als Sortierwert und Anzeigetext – eine Spalte auf einmal. Gemeinsame Grundlage für Sortieren,
 * abgeleitete Tabellen, Rollup-Spalten und die Summenzeile. Berechnete Werte (Rollup) werden hier erzeugt und nie gespeichert.
 */
import * as Y from 'yjs'
import { buildFileIndex, buildLinkIndex, summarize, tablesOf, type ColumnInfo, type TableInfo, type ViewAgg } from './model'
import { formatDate } from './dateFormat'
import { plainText } from './richText'
import { DATE, NUMBER, ROLLUP, TEXT, effectiveType } from './columnTypes'
import { allowedAggs, type FooterFn } from './aggregate'

export type Key = number | string | null // null = leer (steht beim Sortieren immer am Ende)
export interface Cell { raw: unknown; text: string; key: Key }

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' })
export const compareKeys = (a: number | string, b: number | string): number =>
  typeof a === 'number' && typeof b === 'number' ? a - b : collator.compare(String(a), String(b))

export function fmtNumber(n: number, col: ColumnInfo): string {
  const cfg = col.type === 'number' ? NUMBER.config(col) : { decimals: -1, unit: '' }
  const s = cfg.decimals >= 0 ? n.toFixed(cfg.decimals) : String(Number(n.toPrecision(12)))
  return cfg.unit ? `${s} ${cfg.unit}` : s
}

const EMPTY: Cell = { raw: null, text: '', key: null }

/** Zellen einer Spalte, je Zeilen-ID. `stack` verhindert endlose Rollup-Ketten. */
export function columnCells(doc: Y.Doc, tables: TableInfo[], table: TableInfo, col: ColumnInfo, stack: string[] = []): Map<string, Cell> {
  const out = new Map<string, Cell>()

  if (col.type === 'rollup') {
    const me = `${table.id}.${col.id}`
    const cfg = ROLLUP.config(col)
    const rel = table.columns.find((c) => c.id === cfg.rel && c.type === 'relation')
    const target = tables.find((t) => t.id === rel?.target)
    const tcol = target?.columns.find((c) => c.id === cfg.col)
    if (!rel || !target || !tcol || stack.includes(me) || stack.length > 4 || !allowedAggs(effectiveType(tcol, tables)).includes(cfg.fn)) {
      for (const rid of table.rowIds) out.set(rid, EMPTY)
      return out
    }
    const targetCells = columnCells(doc, tables, target, tcol, [...stack, me])
    const links = buildLinkIndex(doc).forward
    for (const rid of table.rowIds) {
      const cells = (links.get(`${rid}|${rel.id}`) ?? []).flatMap((x) => targetCells.get(x) ?? [])
      const r = summarizeGroup(cells, tcol, { fn: cfg.fn, sep: cfg.sep })
      out.set(rid, { raw: r.key, text: r.text, key: r.key })
    }
    return out
  }

  const rows: Y.Map<Y.Map<any>> | undefined = tablesOf(doc).get(table.id)?.get('rows')
  const links = col.type === 'relation' ? buildLinkIndex(doc).forward : null
  const files = col.type === 'file' ? buildFileIndex(doc) : null
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
