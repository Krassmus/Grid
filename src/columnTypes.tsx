import type { ReactNode } from 'react'
import * as Y from 'yjs'
import type { AggFn, ColType, ColumnInfo, TableInfo } from './model'
import { DATE_STYLES, type DateStyle } from './dateFormat'
import { Pill } from './SelectCell'
import { aggLabel, allowedAggs } from './aggregate'
import { FormulaEditor, TemplateEditor } from './FormulaEditor'
import { GEO_FORMATS, type GeoFormat } from './geo'
import { FormulaSyntaxError, inferType, parseFormula } from './formula'

/** Was ein Konfigurationseditor braucht, um die Einstellungen einer Spalte anzuzeigen und zu ändern. */
export interface ConfigContext<C> {
  doc: Y.Doc
  table: TableInfo
  tables: TableInfo[]
  column: ColumnInfo
  config: C
  /** Ändert Einstellungen sofort (im Dokument gespeichert, wird mit anderen synchronisiert). */
  set: (patch: Partial<C>) => void
  /** Öffnet die Verwaltung der Auswahloptionen. */
  editOptions: () => void
}

/**
 * Basisklasse der Spaltentypen. Jeder Typ bringt seine Einstellungen (`defaults`) und den Editor dafür mit.
 * Typ, ID und Name gehören nicht dazu: Der Typ ist nach dem Anlegen fest, der Name ist für alle gleich.
 * Gespeichert wird nur, was vom Standard abweicht; unbekannte Schlüssel werden ignoriert.
 */
export abstract class ColumnType<C extends object> {
  abstract readonly type: ColType
  abstract readonly label: string
  abstract readonly defaults: C
  abstract renderConfig(ctx: ConfigContext<C>): ReactNode

  config(col: Pick<ColumnInfo, 'config'>): C {
    const out: Record<string, unknown> = { ...(this.defaults as Record<string, unknown>) }
    for (const key of Object.keys(this.defaults)) {
      const v = col.config?.[key]
      if (v !== undefined && typeof v === typeof (this.defaults as Record<string, unknown>)[key]) out[key] = v
    }
    return out as C
  }
}

// ---------- kleine Formular-Bausteine ----------

function Check(props: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; hint?: string }) {
  return (
    <label className="cfg-check">
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span>{props.children}{props.hint && <small>{props.hint}</small>}</span>
    </label>
  )
}

function Field(props: { label: string; children: ReactNode }) {
  return <label className="cfg-field"><span>{props.label}</span>{props.children}</label>
}

// ---------- Typen ----------

export interface TextConfig { mode: 'single' | 'multi' | 'rich'; bold: boolean }
class TextColumn extends ColumnType<TextConfig> {
  readonly type = 'text'
  readonly label = 'Text'
  readonly defaults: TextConfig = { mode: 'single', bold: false }
  renderConfig({ config, set }: ConfigContext<TextConfig>) {
    return (
      <>
        <Field label="Textart">
          <select value={config.mode} onChange={(e) => set({ mode: e.target.value as TextConfig['mode'] })}>
            <option value="single">Einzeilig</option>
            <option value="multi">Mehrzeilig</option>
            <option value="rich">Formatierter Text</option>
          </select>
        </Field>
        {config.mode === 'rich' && <p className="hint">Ein Klick auf die Zelle öffnet einen Editor mit Fett, Kursiv, Unterstrichen und Listen.</p>}
        {config.mode !== 'rich' && <Check checked={config.bold} onChange={(bold) => set({ bold })}>Text fett anzeigen</Check>}
      </>
    )
  }
}

export interface NumberConfig { decimals: number; unit: string }
class NumberColumn extends ColumnType<NumberConfig> {
  readonly type = 'number'
  readonly label = 'Zahl'
  /** decimals −1 = beliebig viele Nachkommastellen */
  readonly defaults: NumberConfig = { decimals: -1, unit: '' }
  renderConfig({ config, set }: ConfigContext<NumberConfig>) {
    return (
      <>
        <Field label="Nachkommastellen">
          <select value={config.decimals} onChange={(e) => set({ decimals: Number(e.target.value) })}>
            <option value={-1}>Beliebig</option>
            {[0, 1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
        <Field label="Einheit">
          <input value={config.unit} placeholder="z. B. € oder kg" maxLength={12} onChange={(e) => set({ unit: e.target.value })} />
        </Field>
      </>
    )
  }
}

export interface RelationConfig { single: boolean; backlink: boolean; display: 'default' | 'avatar' }
class RelationColumn extends ColumnType<RelationConfig> {
  readonly type = 'relation'
  readonly label = 'Relation'
  readonly defaults: RelationConfig = { single: false, backlink: true, display: 'default' }
  renderConfig({ config, set, column, tables }: ConfigContext<RelationConfig>) {
    return (
      <>
        <p className="cfg-static">Zieltabelle: <strong>{tables.find((t) => t.id === column.target)?.name ?? '?'}</strong></p>
        <Check checked={config.single} onChange={(single) => set({ single })} hint="Bereits vorhandene weitere Verknüpfungen bleiben bestehen.">
          Höchstens eine Verknüpfung pro Zeile
        </Check>
        <Check checked={config.backlink} onChange={(backlink) => set({ backlink })}>Rückverweis in der Zieltabelle anzeigen</Check>
        <Field label="Darstellung der verknüpften Datensätze">
          <select value={config.display ?? 'default'} onChange={(e) => set({ display: e.target.value as 'default' | 'avatar' })}>
            <option value="default">Wie in der Zieltabelle festgelegt</option>
            <option value="avatar">Nur der Avatar (sofern vorhanden)</option>
          </select>
          <small className="hint">In der Auswahl zum Verknüpfen stehen immer auch die Namen.</small>
        </Field>
      </>
    )
  }
}

export interface FileConfig { accept: 'all' | 'images'; single: boolean }
class FileColumn extends ColumnType<FileConfig> {
  readonly type = 'file'
  readonly label = 'Dateien'
  readonly defaults: FileConfig = { accept: 'all', single: false }
  renderConfig({ config, set }: ConfigContext<FileConfig>) {
    return (
      <>
        <Field label="Erlaubt">
          <select value={config.accept} onChange={(e) => set({ accept: e.target.value as FileConfig['accept'] })}>
            <option value="all">Alle Dateien</option>
            <option value="images">Nur Bilder</option>
          </select>
        </Field>
        <Check checked={config.single} onChange={(single) => set({ single })} hint="Bereits vorhandene weitere Dateien bleiben bestehen.">
          Höchstens eine Datei pro Zeile
        </Check>
      </>
    )
  }
}

export type SelectConfig = Record<string, never>
class SelectColumn extends ColumnType<SelectConfig> {
  readonly type = 'select'
  readonly label = 'Auswahl'
  readonly defaults: SelectConfig = {}
  renderConfig({ column, editOptions }: ConfigContext<SelectConfig>) {
    const options = column.options ?? []
    return (
      <div className="cfg-field">
        <span>Optionen</span>
        <div className="cfg-pills">
          {options.map((o) => <Pill key={o.id} option={o} />)}
          {options.length === 0 && <span className="hint">Noch keine Optionen.</span>}
        </div>
        <button type="button" onClick={editOptions}>Optionen bearbeiten …</button>
      </div>
    )
  }
}

export interface DateConfig { time: boolean; style: DateStyle }
class DateColumn extends ColumnType<DateConfig> {
  readonly type = 'date'
  readonly label = 'Datum'
  readonly defaults: DateConfig = { time: false, style: 'short' }
  renderConfig({ config, set }: ConfigContext<DateConfig>) {
    return (
      <>
        <Check checked={config.time} onChange={(time) => set({ time })}>Uhrzeit angeben</Check>
        <Field label="Darstellung">
          <select value={config.style} onChange={(e) => set({ style: e.target.value as DateStyle })}>
            {DATE_STYLES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </Field>
      </>
    )
  }
}

export interface CheckboxConfig { label: string }
class CheckboxColumn extends ColumnType<CheckboxConfig> {
  readonly type = 'checkbox'
  readonly label = 'Checkbox'
  readonly defaults: CheckboxConfig = { label: '' }
  renderConfig({ config, set }: ConfigContext<CheckboxConfig>) {
    return (
      <Field label="Beschriftung neben dem Kästchen">
        <input value={config.label} placeholder="z. B. Erledigt" maxLength={40} onChange={(e) => set({ label: e.target.value })} />
      </Field>
    )
  }
}

/** Rollup: fasst eine Spalte der über eine Relation verknüpften Zeilen zusammen. Der Wert wird berechnet, nie gespeichert. */
export interface RollupConfig { rel: string; col: string; fn: AggFn; sep: string }
class RollupColumn extends ColumnType<RollupConfig> {
  readonly type = 'rollup'
  readonly label = 'Rollup'
  readonly defaults: RollupConfig = { rel: '', col: '', fn: 'sum', sep: ', ' }
  renderConfig({ config, set, table, tables, column }: ConfigContext<RollupConfig>) {
    const relations = table.columns.filter((c) => c.type === 'relation')
    const rel = relations.find((c) => c.id === config.rel)
    const target = tables.find((t) => t.id === rel?.target)
    const targetCols = (target?.columns ?? []).filter((c) => c.id !== column.id)
    const tcol = targetCols.find((c) => c.id === config.col)
    const fns = tcol ? allowedAggs(effectiveType(tcol, tables)).filter((f) => f !== 'hide') : []
    return (
      <>
        <Field label="Über Relation">
          <select value={config.rel} onChange={(e) => set({ rel: e.target.value, col: '' })}>
            <option value="">Relation wählen …</option>
            {relations.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Spalte der verknüpften Zeilen">
          <select value={config.col} disabled={!target} onChange={(e) => set({ col: e.target.value })}>
            <option value="">Spalte wählen …</option>
            {targetCols.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Zusammenfassen als">
          <select value={config.fn} disabled={!tcol} onChange={(e) => set({ fn: e.target.value as AggFn })}>
            {fns.map((f) => <option key={f} value={f}>{aggLabel(tcol!.type, f)}</option>)}
          </select>
        </Field>
        {config.fn === 'concat' && (
          <Field label="Trennzeichen">
            <input value={config.sep} maxLength={12} onChange={(e) => set({ sep: e.target.value })} />
          </Field>
        )}
      </>
    )
  }
}

/** Formel: berechnet den Wert je Zeile aus anderen Spalten (siehe formula.ts). Der Wert wird nie gespeichert. */
export interface FormulaConfig { expr: string; decimals: number; unit: string }
class FormulaColumn extends ColumnType<FormulaConfig> {
  readonly type = 'formula'
  readonly label = 'Formel'
  readonly defaults: FormulaConfig = { expr: '', decimals: -1, unit: '' }
  renderConfig(ctx: ConfigContext<FormulaConfig>) { return <FormulaEditor {...ctx} /> }
}

/** Text mit Platzhaltern: Text mit eingestreuten `{{Formel}}`. Das Ergebnis ist Text und wird nie gespeichert. */
export interface TemplateConfig { tpl: string }
class TemplateColumn extends ColumnType<TemplateConfig> {
  readonly type = 'template'
  readonly label = 'Text mit Platzhaltern'
  readonly defaults: TemplateConfig = { tpl: '' }
  renderConfig(ctx: ConfigContext<TemplateConfig>) { return <TemplateEditor {...ctx} /> }
}

/** Geokoordinate: einheitlich als WGS84 gespeichert (siehe geo.ts), nur die Darstellung ist einstellbar. */
export interface GeoConfig { format: GeoFormat }
class GeoColumn extends ColumnType<GeoConfig> {
  readonly type = 'geo'
  readonly label = 'Geokoordinate'
  readonly defaults: GeoConfig = { format: 'map' }
  renderConfig({ config, set }: ConfigContext<GeoConfig>) {
    const ex = GEO_FORMATS.find((f) => f.id === config.format)?.example
    return (
      <Field label="Darstellung">
        <select value={config.format} onChange={(e) => set({ format: e.target.value as GeoFormat })}>
          {GEO_FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
        <small className="hint">{ex ? `Beispiel: ${ex}` : 'Eine kleine Karte um die Position. Ein Klick öffnet die große Karte.'} Gespeichert wird immer einheitlich (WGS84); im Dialog kann man jedes Format eingeben.</small>
      </Field>
    )
  }
}

export const TEXT = new TextColumn()
export const NUMBER = new NumberColumn()
export const RELATION = new RelationColumn()
export const FILE = new FileColumn()
export const SELECT = new SelectColumn()
export const DATE = new DateColumn()
export const CHECKBOX = new CheckboxColumn()
export const ROLLUP = new RollupColumn()
export const FORMULA = new FormulaColumn()
export const TEMPLATE = new TemplateColumn()
export const GEO = new GeoColumn()

const REGISTRY: Record<ColType, ColumnType<any>> = { text: TEXT, number: NUMBER, relation: RELATION, file: FILE, select: SELECT, date: DATE, checkbox: CHECKBOX, rollup: ROLLUP, formula: FORMULA, template: TEMPLATE, geo: GEO }
export const columnTypeOf = (type: ColType): ColumnType<any> => REGISTRY[type]

/**
 * Wie sich die Spalte beim Filtern, Zusammenfassen und Darstellen verhält. Normale Spalten: ihr Typ.
 * Rollup: Summe und Anzahl sind Zahlen, Minimum/Maximum behalten Zahl oder Datum, alles andere ist Text.
 */
export function effectiveType(col: ColumnInfo, tables: TableInfo[], depth = 0): ColType {
  if (col.type === 'formula') return formulaType(col, tables, depth)
  if (col.type === 'template') return 'text'
  if (col.type !== 'rollup') return col.type
  if (depth > 4) return 'text'
  const cfg = ROLLUP.config(col)
  const own = tables.find((t) => t.columns.some((c) => c.id === col.id))
  const rel = own?.columns.find((c) => c.id === cfg.rel && c.type === 'relation')
  const tcol = tables.find((t) => t.id === rel?.target)?.columns.find((c) => c.id === cfg.col)
  if (!tcol) return 'text'
  if (cfg.fn === 'sum' || cfg.fn === 'count') return 'number'
  if (cfg.fn === 'min' || cfg.fn === 'max') {
    const t = effectiveType(tcol, tables, depth + 1)
    return t === 'number' || t === 'date' ? t : 'text'
  }
  return 'text'
}

/** Typ einer Formel-Spalte aus dem Ausdruck (ohne auszuwerten): Rechnen → Zahl, Vergleiche → Kästchen, sonst Text. */
function formulaType(col: ColumnInfo, tables: TableInfo[], depth: number): ColType {
  if (depth > 4) return 'text'
  let ast
  try { ast = parseFormula(FORMULA.config(col).expr) } catch (e) { if (e instanceof FormulaSyntaxError) return 'text'; throw e }
  const own = tables.find((t) => t.columns.some((c) => c.id === col.id))
  if (!own) return 'text'
  const norm = (s: string) => s.trim().toLowerCase()
  return inferType(ast, (parts) => {
    let cur: TableInfo | undefined = own
    for (const part of parts.slice(0, -1)) {
      const rel: ColumnInfo | undefined = cur?.columns.find((c) => norm(c.name) === norm(part) && c.type === 'relation')
      cur = tables.find((t) => t.id === rel?.target)
    }
    const c = cur?.columns.find((x) => norm(x.name) === norm(parts[parts.length - 1]))
    return !c || c.id === col.id ? undefined : effectiveType(c, tables, depth + 1)
  })
}
