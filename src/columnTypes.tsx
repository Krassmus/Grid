import type { ReactNode } from 'react'
import * as Y from 'yjs'
import type { ColType, ColumnInfo, TableInfo } from './model'
import { Pill } from './SelectCell'

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

export interface RelationConfig { single: boolean; backlink: boolean }
class RelationColumn extends ColumnType<RelationConfig> {
  readonly type = 'relation'
  readonly label = 'Relation'
  readonly defaults: RelationConfig = { single: false, backlink: true }
  renderConfig({ config, set, column, tables }: ConfigContext<RelationConfig>) {
    return (
      <>
        <p className="cfg-static">Zieltabelle: <strong>{tables.find((t) => t.id === column.target)?.name ?? '?'}</strong></p>
        <Check checked={config.single} onChange={(single) => set({ single })} hint="Bereits vorhandene weitere Verknüpfungen bleiben bestehen.">
          Höchstens eine Verknüpfung pro Zeile
        </Check>
        <Check checked={config.backlink} onChange={(backlink) => set({ backlink })}>Rückverweis in der Zieltabelle anzeigen</Check>
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

export const TEXT = new TextColumn()
export const NUMBER = new NumberColumn()
export const RELATION = new RelationColumn()
export const FILE = new FileColumn()
export const SELECT = new SelectColumn()

const REGISTRY: Record<ColType, ColumnType<any>> = { text: TEXT, number: NUMBER, relation: RELATION, file: FILE, select: SELECT }
export const columnTypeOf = (type: ColType): ColumnType<any> => REGISTRY[type]
