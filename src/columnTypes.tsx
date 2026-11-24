import type { ReactNode } from 'react'
import * as Y from 'yjs'
import type { AggFn, ColType, ColumnInfo, TableInfo } from './model'
import { DATE_STYLES, type DateStyle } from './dateFormat'
import { Pill } from './SelectCell'
import { aggLabel, allowedAggs } from './aggregate'
import { FormulaEditor, TemplateEditor } from './FormulaEditor'
import { GEO_FORMATS, type GeoFormat } from './geo'
import type { DurationFormat } from './duration'
import type { LinkKind } from './link'
import { FormulaSyntaxError, inferType, parseFormula } from './formula'
import { t } from './i18n'

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
  abstract get label(): string
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
  get label() { return t('Text') }
  readonly defaults: TextConfig = { mode: 'single', bold: false }
  renderConfig({ config, set }: ConfigContext<TextConfig>) {
    return (
      <>
        <Field label={t('Textart')}>
          <select value={config.mode} onChange={(e) => set({ mode: e.target.value as TextConfig['mode'] })}>
            <option value="single">{t('Einzeilig')}</option>
            <option value="multi">{t('Mehrzeilig')}</option>
            <option value="rich">{t('Formatierter Text')}</option>
          </select>
        </Field>
        {config.mode === 'rich' && <p className="hint">{t('Ein Klick auf die Zelle öffnet einen Editor mit Fett, Kursiv, Unterstrichen und Listen.')}</p>}
        {config.mode !== 'rich' && <Check checked={config.bold} onChange={(bold) => set({ bold })}>{t('Text fett anzeigen')}</Check>}
      </>
    )
  }
}

export interface NumberConfig { decimals: number; unit: string }
class NumberColumn extends ColumnType<NumberConfig> {
  readonly type = 'number'
  get label() { return t('Zahl') }
  /** decimals −1 = beliebig viele Nachkommastellen */
  readonly defaults: NumberConfig = { decimals: -1, unit: '' }
  renderConfig({ config, set }: ConfigContext<NumberConfig>) {
    return (
      <>
        <Field label={t('Nachkommastellen')}>
          <select value={config.decimals} onChange={(e) => set({ decimals: Number(e.target.value) })}>
            <option value={-1}>{t('Beliebig')}</option>
            {[0, 1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
        <Field label={t('Einheit')}>
          <input value={config.unit} placeholder={t('z. B. € oder kg')} maxLength={12} onChange={(e) => set({ unit: e.target.value })} />
        </Field>
      </>
    )
  }
}

export interface RelationConfig { single: boolean; backlink: boolean; display: 'default' | 'avatar'; multiTarget: boolean }
class RelationColumn extends ColumnType<RelationConfig> {
  readonly type = 'relation'
  get label() { return t('Relation') }
  readonly defaults: RelationConfig = { single: false, backlink: true, display: 'default', multiTarget: false }
  renderConfig({ config, set, column, tables }: ConfigContext<RelationConfig>) {
    return (
      <>
        <p className="cfg-static">{t('Zieltabelle:')} <strong>{tables.find((x) => x.id === column.target)?.name ?? '?'}</strong></p>
        <Check checked={config.single} onChange={(single) => set({ single })} hint={t('Bereits vorhandene weitere Verknüpfungen bleiben bestehen.')}>
          {t('Höchstens eine Verknüpfung pro Zeile')}
        </Check>
        <Check checked={config.multiTarget} onChange={(multiTarget) => set({ multiTarget })} hint={t('Aus: jeder Zieldatensatz gehört zu höchstens einer Zeile dieser Tabelle, im Rückverweis steht dann höchstens ein Datensatz. Bereits vorhandene Mehrfach-Verknüpfungen bleiben bestehen.')}>
          {t('Zieldatensatz darf mehrfach verknüpft werden')}
        </Check>
        <Check checked={config.backlink} onChange={(backlink) => set({ backlink })}>{t('Rückverweis in der Zieltabelle anzeigen')}</Check>
        <Field label={t('Darstellung der verknüpften Datensätze')}>
          <select value={config.display ?? 'default'} onChange={(e) => set({ display: e.target.value as 'default' | 'avatar' })}>
            <option value="default">{t('Wie in der Zieltabelle festgelegt')}</option>
            <option value="avatar">{t('Nur der Avatar (sofern vorhanden)')}</option>
          </select>
          <small className="hint">{t('In der Auswahl zum Verknüpfen stehen immer auch die Namen.')}</small>
        </Field>
      </>
    )
  }
}

export interface FileConfig { accept: 'all' | 'images'; single: boolean }
class FileColumn extends ColumnType<FileConfig> {
  readonly type = 'file'
  get label() { return t('Dateien') }
  readonly defaults: FileConfig = { accept: 'all', single: false }
  renderConfig({ config, set }: ConfigContext<FileConfig>) {
    return (
      <>
        <Field label={t('Erlaubt')}>
          <select value={config.accept} onChange={(e) => set({ accept: e.target.value as FileConfig['accept'] })}>
            <option value="all">{t('Alle Dateien')}</option>
            <option value="images">{t('Nur Bilder')}</option>
          </select>
        </Field>
        <Check checked={config.single} onChange={(single) => set({ single })} hint={t('Bereits vorhandene weitere Dateien bleiben bestehen.')}>
          {t('Höchstens eine Datei pro Zeile')}
        </Check>
      </>
    )
  }
}

export type SelectConfig = Record<string, never>
class SelectColumn extends ColumnType<SelectConfig> {
  readonly type = 'select'
  get label() { return t('Auswahl') }
  readonly defaults: SelectConfig = {}
  renderConfig({ column, editOptions }: ConfigContext<SelectConfig>) {
    const options = column.options ?? []
    return (
      <div className="cfg-field">
        <span>{t('Optionen')}</span>
        <div className="cfg-pills">
          {options.map((o) => <Pill key={o.id} option={o} />)}
          {options.length === 0 && <span className="hint">{t('Noch keine Optionen.')}</span>}
        </div>
        <button type="button" onClick={editOptions}>{t('Optionen bearbeiten …')}</button>
      </div>
    )
  }
}

export interface DateConfig { time: boolean; style: DateStyle }
class DateColumn extends ColumnType<DateConfig> {
  readonly type = 'date'
  get label() { return t('Datum') }
  readonly defaults: DateConfig = { time: false, style: 'short' }
  renderConfig({ config, set }: ConfigContext<DateConfig>) {
    return (
      <>
        <Check checked={config.time} onChange={(time) => set({ time })}>{t('Uhrzeit angeben')}</Check>
        <Field label={t('Darstellung')}>
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
  get label() { return t('Checkbox') }
  readonly defaults: CheckboxConfig = { label: '' }
  renderConfig({ config, set }: ConfigContext<CheckboxConfig>) {
    return (
      <Field label={t('Beschriftung neben dem Kästchen')}>
        <input value={config.label} placeholder={t('z. B. Erledigt')} maxLength={40} onChange={(e) => set({ label: e.target.value })} />
      </Field>
    )
  }
}

/** Rollup: fasst eine Spalte der über eine Relation verknüpften Zeilen zusammen. Der Wert wird berechnet, nie gespeichert. */
export interface RollupConfig { rel: string; col: string; fn: AggFn; sep: string }
class RollupColumn extends ColumnType<RollupConfig> {
  readonly type = 'rollup'
  get label() { return t('Rollup') }
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
        <Field label={t('Über Relation')}>
          <select value={config.rel} onChange={(e) => set({ rel: e.target.value, col: '' })}>
            <option value="">{t('Relation wählen …')}</option>
            {relations.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label={t('Spalte der verknüpften Zeilen')}>
          <select value={config.col} disabled={!target} onChange={(e) => set({ col: e.target.value })}>
            <option value="">{t('Spalte wählen …')}</option>
            {targetCols.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label={t('Zusammenfassen als')}>
          <select value={config.fn} disabled={!tcol} onChange={(e) => set({ fn: e.target.value as AggFn })}>
            {fns.map((f) => <option key={f} value={f}>{aggLabel(tcol!.type, f)}</option>)}
          </select>
        </Field>
        {config.fn === 'concat' && (
          <Field label={t('Trennzeichen')}>
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
  get label() { return t('Formel') }
  readonly defaults: FormulaConfig = { expr: '', decimals: -1, unit: '' }
  renderConfig(ctx: ConfigContext<FormulaConfig>) { return <FormulaEditor {...ctx} /> }
}

/** Text mit Platzhaltern: Text mit eingestreuten `{{Formel}}`. Das Ergebnis ist Text und wird nie gespeichert. */
export interface TemplateConfig { tpl: string }
class TemplateColumn extends ColumnType<TemplateConfig> {
  readonly type = 'template'
  get label() { return t('Text mit Platzhaltern') }
  readonly defaults: TemplateConfig = { tpl: '' }
  renderConfig(ctx: ConfigContext<TemplateConfig>) { return <TemplateEditor {...ctx} /> }
}

/** Geokoordinate: einheitlich als WGS84 gespeichert (siehe geo.ts), nur die Darstellung ist einstellbar. */
export interface GeoConfig { format: GeoFormat }
class GeoColumn extends ColumnType<GeoConfig> {
  readonly type = 'geo'
  get label() { return t('Geokoordinate') }
  readonly defaults: GeoConfig = { format: 'map' }
  renderConfig({ config, set }: ConfigContext<GeoConfig>) {
    const ex = GEO_FORMATS.find((f) => f.id === config.format)?.example
    return (
      <Field label={t('Darstellung')}>
        <select value={config.format} onChange={(e) => set({ format: e.target.value as GeoFormat })}>
          {GEO_FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
        <small className="hint">{ex ? t('Beispiel: {ex}', { ex }) : t('Eine kleine Karte um die Position. Ein Klick öffnet die große Karte.')} {t('Gespeichert wird immer einheitlich (WGS84); im Dialog kann man jedes Format eingeben.')}</small>
      </Field>
    )
  }
}

/** Aufsteigende Zahl: nicht bearbeitbar, nummeriert die Zeilen der Reihe nach (siehe nextStamp in model.ts). */
export type AutonumberConfig = Record<string, never>
class AutonumberColumn extends ColumnType<AutonumberConfig> {
  readonly type = 'autonumber'
  get label() { return t('Aufsteigende Zahl') }
  readonly defaults: AutonumberConfig = {}
  renderConfig() {
    return <p className="hint">{t('Nummeriert die Zeilen in der Reihenfolge ihres Anlegens und lässt sich nicht bearbeiten. Legen zwei Personen gleichzeitig eine Zeile an, entscheidet erst das Zusammenführen über die Reihenfolge: die Nummer kann sich dann ändern. Löscht man eine Zeile, rücken die folgenden nach.')}</p>
  }
}

/** Zeitstempel: trägt selbst ein, wann die Zeile angelegt oder zuletzt geändert wurde (und von wem). Nicht bearbeitbar. */
export interface StampConfig { kind: 'created' | 'modified'; by: boolean }
class StampColumn extends ColumnType<StampConfig> {
  readonly type = 'stamp'
  get label() { return t('Zeitstempel') }
  readonly defaults: StampConfig = { kind: 'created', by: true }
  renderConfig({ config, set }: ConfigContext<StampConfig>) {
    return (
      <>
        <Field label={t('Zeitpunkt')}>
          <select value={config.kind} onChange={(e) => set({ kind: e.target.value as StampConfig['kind'] })}>
            <option value="created">{t('Erstellt')}</option>
            <option value="modified">{t('Zuletzt geändert')}</option>
          </select>
        </Field>
        <Check checked={config.by} onChange={(by) => set({ by })}>{t('Name der Person anzeigen')}</Check>
        <p className="hint">{t('Wird automatisch eingetragen und lässt sich nicht bearbeiten. Zeilen, die es schon vor dieser Spalte gab, bleiben leer, „Zuletzt geändert“ füllt sich mit der nächsten Änderung. Verknüpfungen und Dateien zählen dabei nicht als Änderung der Zeile.')}</p>
      </>
    )
  }
}

/** Person: ein Mitglied (oder mehrere) des Dokuments, mit Avatar. Gespeichert werden die Konto-Kennungen. */
export interface PersonConfig { multi: boolean }
class PersonColumn extends ColumnType<PersonConfig> {
  readonly type = 'person'
  get label() { return t('Person') }
  readonly defaults: PersonConfig = { multi: false }
  renderConfig({ config, set }: ConfigContext<PersonConfig>) {
    return (
      <>
        <Check checked={config.multi} onChange={(multi) => set({ multi })}>{t('Mehrere Personen pro Zeile')}</Check>
        <p className="hint">{t('Zur Auswahl stehen die Mitglieder, die das Dokument geöffnet haben (Name und Avatar aus dem Konto).')}</p>
      </>
    )
  }
}

/** Link: Web-Adresse, E-Mail oder Telefonnummer; ein Klick auf das Symbol öffnet sie. */
export interface LinkConfig { kind: LinkKind }
class LinkColumn extends ColumnType<LinkConfig> {
  readonly type = 'link'
  get label() { return t('Link') }
  readonly defaults: LinkConfig = { kind: 'url' }
  renderConfig({ config, set }: ConfigContext<LinkConfig>) {
    return (
      <Field label={t('Art')}>
        <select value={config.kind} onChange={(e) => set({ kind: e.target.value as LinkKind })}>
          <option value="url">{t('Web-Adresse')}</option>
          <option value="email">{t('E-Mail-Adresse')}</option>
          <option value="phone">{t('Telefonnummer')}</option>
        </select>
      </Field>
    )
  }
}

/** Dauer: gespeichert in Sekunden; Eingabe wie „1:30“, „90m“ oder „1,5 h“. Rechnet wie eine Zahl (Summe in der Fußzeile). */
export interface DurationConfig { format: DurationFormat }
class DurationColumn extends ColumnType<DurationConfig> {
  readonly type = 'duration'
  get label() { return t('Dauer') }
  readonly defaults: DurationConfig = { format: 'hm' }
  renderConfig({ config, set }: ConfigContext<DurationConfig>) {
    return (
      <Field label={t('Anzeige')}>
        <select value={config.format} onChange={(e) => set({ format: e.target.value as DurationFormat })}>
          <option value="hm">{t('Stunden:Minuten (1:30)')}</option>
          <option value="hms">{t('Stunden:Minuten:Sekunden (1:30:00)')}</option>
        </select>
        <small className="hint">{t('Eingabe zum Beispiel „1:30“, „90m“, „1h 30m“ oder „1,5 h“. Eine nackte Zahl zählt als Minuten. In Formeln zählt die Dauer in Sekunden.')}</small>
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
export const AUTONUMBER = new AutonumberColumn()
export const STAMP = new StampColumn()
export const PERSON = new PersonColumn()
export const LINK = new LinkColumn()
export const DURATION = new DurationColumn()

const REGISTRY: Record<ColType, ColumnType<any>> = { text: TEXT, number: NUMBER, relation: RELATION, file: FILE, select: SELECT, date: DATE, checkbox: CHECKBOX, rollup: ROLLUP, formula: FORMULA, template: TEMPLATE, geo: GEO, autonumber: AUTONUMBER, stamp: STAMP, person: PERSON, link: LINK, duration: DURATION }
export const columnTypeOf = (type: ColType): ColumnType<any> => REGISTRY[type]

/**
 * Wie sich die Spalte beim Filtern, Zusammenfassen und Darstellen verhält. Normale Spalten: ihr Typ.
 * Rollup: Summe und Anzahl sind Zahlen, Minimum/Maximum behalten Zahl oder Datum, alles andere ist Text.
 */
export function effectiveType(col: ColumnInfo, tables: TableInfo[], depth = 0): ColType {
  if (col.type === 'formula') return formulaType(col, tables, depth)
  if (col.type === 'template') return 'text'
  if (col.type === 'autonumber' || col.type === 'duration') return 'number'
  if (col.type === 'stamp' || col.type === 'person' || col.type === 'link') return 'text'
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
