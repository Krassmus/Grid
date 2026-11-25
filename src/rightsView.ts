/**
 * Spalten, die ein Betrachter nicht sehen soll, weil sie auf Tabellen aufbauen, die er nicht lesen darf (docs/RIGHTS.md):
 * Relationsspalten auf eine unlesbare Tabelle, Rollups über solche Relationen und Formeln oder Texte mit Platzhaltern, die darauf zugreifen.
 */
import { FORMULA, ROLLUP, TEMPLATE } from './columnTypes'
import { parseFormula, parseTemplate, type Node } from './formula'
import type { ColumnInfo, TableInfo } from './model'

const refsOf = (n: Node, out: string[] = []): string[] => {
  if (n.t === 'ref') out.push(n.parts[0].toLowerCase())
  else if (n.t === 'un') refsOf(n.a, out)
  else if (n.t === 'bin') { refsOf(n.a, out); refsOf(n.b, out) }
  else if (n.t === 'call') n.args.forEach((a) => refsOf(a, out))
  return out
}

const exprRefs = (c: ColumnInfo): string[] => {
  try {
    if (c.type === 'formula') return refsOf(parseFormula(FORMULA.config(c).expr))
    if (c.type === 'template') return refsOf(parseTemplate(TEMPLATE.config(c).tpl))
  } catch { /* ungültige Formel: zeigt ohnehin nur einen Fehler */ }
  return []
}

/**
 * IDs der Spalten von `table`, die ausgeblendet werden, wenn nur `readable` lesbar ist und die Spalten `unreadable` (aller Tabellen) nicht
 * gelesen werden dürfen; mit ihnen verschwindet, was auf ihnen aufbaut (Formeln, Texte, Rollups).
 */
export function hiddenByRights(table: TableInfo, readable: TableInfo[], unreadable: ReadonlySet<string> = new Set()): Set<string> {
  const ok = new Set(readable.map((x) => x.id))
  const hidden = new Set<string>(table.columns.filter((c) => unreadable.has(c.id)).map((c) => c.id))
  for (let changed = true; changed;) {
    changed = false
    const names = new Set(table.columns.filter((c) => hidden.has(c.id)).map((c) => c.name.toLowerCase()))
    for (const c of table.columns) {
      if (hidden.has(c.id)) continue
      const hide =
        (c.type === 'relation' && !!c.target && !ok.has(c.target)) ||
        (c.type === 'rollup' && (hidden.has(ROLLUP.config(c).rel) || unreadable.has(ROLLUP.config(c).col))) ||
        ((c.type === 'formula' || c.type === 'template') && exprRefs(c).some((r) => names.has(r)))
      if (hide) { hidden.add(c.id); changed = true }
    }
  }
  return hidden
}
