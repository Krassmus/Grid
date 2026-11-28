import { useState } from 'react'
import { Modal } from './Modal'
import type { BookingWho, CalendarDef, CalendarLayer, ColumnInfo, TableInfo } from './model'
import { CHECKBOX } from './columnTypes'
import { IconPicker } from './icons'
import { Pill } from './SelectCell'
import { t } from './i18n'

const ofType = (table: TableInfo | undefined, ...types: string[]): ColumnInfo[] => table?.columns.filter((c) => types.includes(c.type)) ?? []
const relations = (table: TableInfo | undefined, tables: TableInfo[]) => ofType(table, 'relation').filter((c) => tables.some((x) => x.id === c.target))

/** Tabellen, aus denen ein Kalender entstehen kann: mit Datums- und Relationsspalte. */
export const calendarSources = (tables: TableInfo[]) => tables.filter((x) => ofType(x, 'date').length > 0 && relations(x, tables).length > 0)

/** Angaben, um die Buchungstabelle gleich mit anzulegen (`addBookingCalendar`) */
export interface NewBookings { tableName: string; objects: string; who: BookingWho; time: boolean; groupBy?: string; filters: string[] }

/** Klingt der Tabellenname nach Menschen? Nur für die Vorbelegung. */
const PEOPLE = /person|mitglied|leute|member|people|user|ausleih|kunde|customer|kontakt|contact|team/i

/** Vorschlag, was gebucht wird und wer bucht. Tabellen, die selbst nach Buchungen aussehen, kommen erst zuletzt in Frage. */
export function suggestBookings(tables: TableInfo[]): { objects: string; who: string } {
  const bookings = new Set(calendarSources(tables).map((x) => x.id))
  const candidates = [...tables.filter((x) => !bookings.has(x.id)), ...tables.filter((x) => bookings.has(x.id))]
  const objects = candidates.find((x) => !PEOPLE.test(x.name)) ?? candidates[0]
  const others = candidates.filter((x) => x.id !== objects?.id && !bookings.has(x.id))
  const who = others.find((x) => PEOPLE.test(x.name)) ?? others[0]
  return { objects: objects?.id ?? '', who: who?.id ?? 'text' }
}

const freeName = (base: string, tables: TableInfo[]) => {
  const taken = new Set(tables.map((x) => x.name.trim().toLowerCase()))
  let name = base
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} ${i}`
  return name
}

/** Sinnvolle Vorbelegung für eine Tabelle. */
function suggest(table: TableInfo | undefined, tables: TableInfo[]): CalendarDef {
  if (!table) return { layers: [], filters: [] }
  const dates = ofType(table, 'date'), rels = relations(table, tables)
  const target = tables.find((x) => x.id === rels[0]?.target)
  const layer: CalendarLayer = { table: table.id, start: dates[0]?.id ?? '', end: dates[1]?.id, lane: rels[0]?.id ?? '', label: rels[1]?.id, color: ofType(table, 'select')[0]?.id }
  return { layers: [layer], filters: ofType(target, 'select').map((c) => c.id) }
}

/** Kalender anlegen oder bearbeiten (docs/KALENDER.md). */
export function CalendarDialog(props: {
  tables: TableInfo[]
  initial?: { name: string; def: CalendarDef; icon?: string }
  onSubmit: (name: string, def: CalendarDef, icon: string) => void
  /** Neuer Kalender, dessen Buchungstabelle mit angelegt wird */
  onCreate?: (name: string, icon: string, bookings: NewBookings) => void
  onClose: () => void
  onDelete?: () => void
}) {
  const { tables } = props
  const sources = calendarSources(tables)
  const [name, setName] = useState(props.initial?.name ?? t('Kalender'))
  const [icon, setIcon] = useState(props.initial?.icon ?? '')
  const [def, setDef] = useState<CalendarDef>(() => (props.initial?.def.layers.length ? props.initial.def : suggest(sources[0], tables)))
  // Beim Anlegen: Buchungstabelle mit anlegen (üblich) oder eine vorhandene verwenden
  const [mode, setMode] = useState<'new' | 'existing'>(props.initial ? 'existing' : 'new')
  const creating = mode === 'new'
  const [bookings, setBookings] = useState<NewBookings>(() => {
    const s = suggestBookings(tables)
    return {
      tableName: freeName(t('Buchungen'), tables), objects: s.objects, time: false,
      who: s.who === 'text' ? { kind: 'text' } : { kind: 'table', table: s.who },
      filters: ofType(tables.find((x) => x.id === s.objects), 'select').map((c) => c.id),
    }
  })
  const setObjects = (objects: string) => setBookings((b) => ({
    ...b, objects, groupBy: undefined, filters: ofType(tables.find((x) => x.id === objects), 'select').map((c) => c.id),
    who: b.who.kind === 'table' && b.who.table === objects ? { kind: 'text' } : b.who,
  }))
  const whoValue = bookings.who.kind === 'table' ? bookings.who.table : bookings.who.kind
  const layer: CalendarLayer | undefined = def.layers[0]
  const source = tables.find((x) => x.id === layer?.table)
  const dates = ofType(source, 'date'), rels = relations(source, tables)
  const target = tables.find((x) => x.id === (creating ? bookings.objects : rels.find((c) => c.id === layer?.lane)?.target))
  const groupable = ofType(target, 'select'), filterable = ofType(target, 'select', 'checkbox')
  const freeCols = ofType(source, 'select', 'checkbox')
  const freeCol = freeCols.find((c) => c.id === layer?.free?.col)
  const valid = creating ? !!target && !!bookings.tableName.trim() : !!layer && !!source && dates.some((c) => c.id === layer.start) && !!target
  // Gruppen und Zeilenfilter beziehen sich auf das, was gebucht wird: in beiden Fällen dieselben Felder
  const rows = creating ? bookings : def
  const setRows = (patch: { groupBy?: string; filters?: string[] }) => (creating ? setBookings((b) => ({ ...b, ...patch })) : setDef((d) => ({ ...d, ...patch })))

  const setLayer = (patch: Partial<CalendarLayer>) => setDef((d) => ({ ...d, layers: [{ ...d.layers[0], ...patch }] }))
  const setLane = (lane: string) => {
    const next = tables.find((x) => x.id === rels.find((c) => c.id === lane)?.target)
    setDef((d) => ({
      layers: [{ ...d.layers[0], lane }],
      ...(next?.id === target?.id ? { groupBy: d.groupBy, filters: d.filters } : { filters: ofType(next, 'select').map((c) => c.id) }),
    }))
  }
  const setFreeCol = (id: string) => {
    const col = freeCols.find((c) => c.id === id)
    setLayer({ free: col ? { col: col.id, values: col.type === 'checkbox' ? ['1'] : [] } : undefined })
  }
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id])

  const submit = () => {
    if (!name.trim() || !valid) return
    if (creating) {
      props.onCreate!(name.trim(), icon, {
        ...bookings, tableName: bookings.tableName.trim(),
        groupBy: groupable.some((c) => c.id === bookings.groupBy) ? bookings.groupBy : undefined,
        filters: bookings.filters.filter((id) => filterable.some((c) => c.id === id)),
      })
      return
    }
    if (!layer || !source) return
    // Verweise auf gelöschte oder nicht (mehr) passende Spalten fallen beim Speichern weg
    const has = (list: ColumnInfo[], id: string | undefined) => (list.some((c) => c.id === id) ? id : undefined)
    const free = layer.free && freeCol && layer.free.values.length ? layer.free : undefined
    props.onSubmit(name.trim(), {
      ownTable: def.ownTable === layer.table ? layer.table : undefined,
      layers: [{ table: layer.table, start: layer.start, lane: layer.lane, end: has(dates, layer.end), label: has(source.columns, layer.label), color: has(ofType(source, 'select'), layer.color), free }],
      groupBy: has(groupable, def.groupBy),
      filters: def.filters.filter((id) => filterable.some((c) => c.id === id)),
    }, icon)
  }

  /** Auswahl einer Spalte; `none`: Text für „keine“ (fehlt bei Pflichtangaben) */
  const columnSelect = (label: string, cols: ColumnInfo[], value: string | undefined, onChange: (id: string) => void, none?: string) => (
    <label>{label}
      <select value={cols.some((c) => c.id === value) ? value : ''} onChange={(e) => onChange(e.target.value)}>
        {none !== undefined ? <option value="">{none}</option> : !cols.some((c) => c.id === value) && <option value="" disabled>–</option>}
        {cols.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </label>
  )

  const rowSettings = (
    <>
      {groupable.length > 0 && columnSelect(t('Zeilen gruppieren nach'), groupable, rows.groupBy, (groupBy) => setRows({ groupBy: groupBy || undefined }), t('– nicht gruppieren –'))}
      {filterable.length > 0 && (
        <fieldset className="cal-checks">
          <legend>{t('Zeilen filtern nach')}</legend>
          {filterable.map((c) => (
            <label key={c.id} className="check"><input type="checkbox" checked={rows.filters.includes(c.id)} onChange={() => setRows({ filters: toggle(rows.filters, c.id) })} /> {c.name}</label>
          ))}
        </fieldset>
      )}
    </>
  )

  return (
    <Modal onClose={props.onClose}>
      <form className="dialog caldialog" onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); submit() }} onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>{props.initial ? t('Kalender bearbeiten') : t('Neuer Kalender')}</h3>
        <label>{t('Name')}<input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
        <IconPicker value={icon} kind="calendar" onChange={setIcon} />
        {!props.initial && sources.length > 0 && (
          <label>{t('Buchungen')}
            <select value={mode} onChange={(e) => setMode(e.target.value as 'new' | 'existing')}>
              <option value="new">{t('Neue Tabelle dafür anlegen')}</option>
              <option value="existing">{t('Vorhandene Tabelle verwenden')}</option>
            </select>
          </label>
        )}
        {creating && tables.length === 0 && <p className="hint">{t('Lege zuerst eine Tabelle mit dem an, was gebucht werden soll, zum Beispiel „Räume“.')}</p>}
        {creating && tables.length > 0 && (
          <>
            <label>{t('Was wird gebucht?')}
              <select value={bookings.objects} onChange={(e) => setObjects(e.target.value)}>
                {tables.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </label>
            <label>{t('Wer bucht?')}
              <select value={whoValue} onChange={(e) => { const v = e.target.value; setBookings((b) => ({ ...b, who: v === 'none' || v === 'text' ? { kind: v } : { kind: 'table', table: v } })) }}>
                {tables.filter((x) => x.id !== bookings.objects).map((x) => <option key={x.id} value={x.id}>{t('Auswahl aus „{name}“', { name: x.name })}</option>)}
                <option value="text">{t('Name als Text eintragen')}</option>
                <option value="none">{t('Ohne Angabe: nur „belegt“')}</option>
              </select>
            </label>
            <label>{t('Zeitraum')}
              <select value={bookings.time ? 'time' : 'days'} onChange={(e) => setBookings((b) => ({ ...b, time: e.target.value === 'time' }))}>
                <option value="days">{t('Ganze Tage')}</option>
                <option value="time">{t('Mit Uhrzeit')}</option>
              </select>
            </label>
            {rowSettings}
            <label>{t('Name der neuen Tabelle')}<input value={bookings.tableName} onChange={(e) => setBookings((b) => ({ ...b, tableName: e.target.value }))} /></label>
            <p className="hint">{t('Die Tabelle steht danach im Menü des Kalenders. Weitere Spalten, etwa einen Status, kannst du dort ergänzen.')}</p>
          </>
        )}
        {!creating && sources.length === 0 && <p className="hint">{t('Ein Kalender braucht eine Tabelle mit einer Datumsspalte und einer Relationsspalte. Zum Beispiel „Buchungen“ mit „Von“, „Bis“ und einer Relation zu „Objekte“.')}</p>}
        {!creating && sources.length > 0 && (
          <>
            <label>{t('Einträge aus der Tabelle')}
              <select value={sources.some((x) => x.id === source?.id) ? source!.id : ''} onChange={(e) => setDef(suggest(sources.find((x) => x.id === e.target.value), tables))}>
                {!sources.some((x) => x.id === source?.id) && <option value="" disabled>–</option>}
                {sources.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </label>
            {layer && source && (
              <>
                <div className="cal-pair">
                  {columnSelect(t('Beginn'), dates, layer.start, (start) => setLayer({ start }))}
                  {columnSelect(t('Ende'), dates, layer.end, (end) => setLayer({ end: end || undefined }), t('– ohne –'))}
                </div>
                {columnSelect(t('Zeilen der Zeitleiste (Relation)'), rels, layer.lane, setLane)}
                {columnSelect(t('Beschriftung der Balken'), source.columns.filter((c) => c.id !== layer.lane && c.type !== 'file'), layer.label, (label) => setLayer({ label: label || undefined }), t('Titel des Eintrags'))}
                {columnSelect(t('Farbe nach'), ofType(source, 'select'), layer.color, (color) => setLayer({ color: color || undefined }), t('– einheitlich –'))}
                {rowSettings}
                {freeCols.length > 0 && columnSelect(t('Nicht belegt, wenn …'), freeCols, layer.free?.col, setFreeCol, t('– jeder Eintrag belegt –'))}
                {freeCol?.type === 'select' && (
                  <fieldset className="cal-checks">
                    <legend>{t('Diese Werte belegen nicht')}</legend>
                    {(freeCol.options ?? []).map((o) => (
                      <label key={o.id} className="check"><input type="checkbox" checked={!!layer.free?.values.includes(o.id)} onChange={() => setLayer({ free: { col: freeCol.id, values: toggle(layer.free?.values ?? [], o.id) } })} /> <Pill option={o} /></label>
                    ))}
                    {(freeCol.options ?? []).length === 0 && <p className="hint">{t('Noch keine Optionen.')}</p>}
                  </fieldset>
                )}
                {freeCol?.type === 'checkbox' && <p className="hint">{t('Einträge mit Haken bei „{name}“ belegen nicht.', { name: CHECKBOX.config(freeCol).label || freeCol.name })}</p>}
                {props.initial && source && (
                  <label className="check cal-own"><input type="checkbox" checked={def.ownTable === layer.table} onChange={(e) => setDef((d) => ({ ...d, ownTable: e.target.checked ? layer.table : undefined }))} /> {t('„{name}“ ohne eigenen Reiter: im Menü dieses Kalenders', { name: source.name })}</label>
                )}
              </>
            )}
          </>
        )}
        <div className="actions split">
          {props.onDelete ? <button type="button" className="danger-outline" onClick={props.onDelete}>{t('Löschen …')}</button> : <span />}
          <span className="actions-right">
            <button type="button" onClick={props.onClose}>{t('Abbrechen')}</button>
            <button type="submit" className="primary" disabled={!name.trim() || !valid}>{props.initial ? t('Speichern') : t('Anlegen')}</button>
          </span>
        </div>
      </form>
    </Modal>
  )
}
