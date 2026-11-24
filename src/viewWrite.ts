/**
 * Schreiben über abgeleitete Tabellen (docs/RIGHTS.md, „Schreiben über Sichten“): Wer an einer Sicht Schreibrecht hat, darf die
 * Zeilen der Quelltabelle ändern, anlegen und löschen, die der Sicht genügen. Hier steht, wann eine Sicht dafür taugt und ob eine Zeile ihren
 * Bedingungen genügt; Oberfläche und Prüfung beim Empfang (viewJudge.ts) benutzen dieselben Funktionen.
 */
import { isComputed, type ColumnInfo, type TableInfo, type ViewDef } from './model'
import { SIMPLE_TYPES, simpleCell } from './cells'
import { activeFilters, matches } from './viewEngine'
import { t } from './i18n'

/** Spalten, deren Wert in der Zeile selbst steht und die ein Formular ändern kann (ohne Verknüpfungen, Dateien, Berechnetes, Zeitmarken). */
export const isValueColumn = (c: ColumnInfo) => !isComputed(c) && !['relation', 'file', 'autonumber', 'stamp'].includes(c.type)

/** Spalten, die man über die Sicht ändern darf: Wertspalten, die nicht ausgeblendet sind. */
export const viewEditable = (c: ColumnInfo) => isValueColumn(c) && !c.hidden

/**
 * `null`, wenn die Sicht Schreibrecht erlaubt; sonst der Grund. Verlangt: keine Gruppierung, und alle wirksamen Bedingungen beziehen sich auf
 * Spalten der Quelltabelle, deren Wert in der Zeile steht (Text, Zahl, Datum, Auswahl, Kontrollkästchen), nicht auf Relationen oder Berechnetes.
 */
export function writeBlocker(def: ViewDef, table: TableInfo | undefined, tables: TableInfo[]): string | null {
  if (!table) return t('Die Quelltabelle fehlt.')
  if (def.group.mode !== 'none') return t('Gruppierte abgeleitete Tabellen sind nicht schreibbar.')
  for (const f of activeFilters(def, table, tables)) {
    if (!SIMPLE_TYPES.includes(f.col.type)) return t('Die Bedingung auf „{name}“ bezieht sich auf eine Spalte, deren Wert nicht in der Zeile selbst steht.', { name: f.col.name })
  }
  return null
}

/** Genügt die Zeile mit diesen gespeicherten Werten den Bedingungen der Sicht? (Nur für schreibbare Sichten.) */
export function rowMatches(def: ViewDef, table: TableInfo, tables: TableInfo[], valueOf: (colId: string) => unknown): boolean {
  const active = activeFilters(def, table, tables)
  if (active.length === 0) return true
  const hit = (f: (typeof active)[number]) => matches(simpleCell(f.col, valueOf(f.col.id)), f.col.type, f.op, f.value)
  return def.match === 'any' ? active.some(hit) : active.every(hit)
}

/**
 * Welche Auswahlwerte einer Auswahlspalte die Bedingungen auf genau diese Spalte zulassen (`null`: alle). Bei „eine der Bedingungen“ schränkt es
 * nur ein, wenn alle Bedingungen diese Spalte betreffen; ob die Zeile am Ende passt, prüft `rowMatches` beim Speichern.
 */
export function allowedOptions(def: ViewDef, table: TableInfo, tables: TableInfo[], col: ColumnInfo): string[] | null {
  const active = activeFilters(def, table, tables)
  const mine = active.filter((f) => f.col.id === col.id)
  if (mine.length === 0 || (def.match === 'any' && mine.length < active.length)) return null
  const ok = (o: string | null) => {
    const hit = (f: (typeof mine)[number]) => matches(simpleCell(col, o), f.col.type, f.op, f.value)
    return def.match === 'any' ? mine.some(hit) : mine.every(hit)
  }
  return (col.options ?? []).filter((o) => ok(o.id)).map((o) => o.id)
}

/** Werte für eine neue Zeile, die schon durch eine Bedingung „ist gleich“ (bei „alle Bedingungen“) oder „ist angehakt“ feststehen. */
export function presetValues(def: ViewDef, table: TableInfo, tables: TableInfo[]): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {}
  if (def.match !== 'all') return out
  for (const f of activeFilters(def, table, tables)) {
    if (f.col.type === 'checkbox' && f.op === 'checked') out[f.col.id] = 1
    else if (f.op === 'eq' && (f.col.type === 'text' || f.col.type === 'select')) out[f.col.id] = f.value
    else if (f.op === 'eq' && f.col.type === 'number' && !Number.isNaN(Number(f.value))) out[f.col.id] = Number(f.value)
    else if (f.op === 'eq' && f.col.type === 'date') out[f.col.id] = f.value
  }
  return out
}
