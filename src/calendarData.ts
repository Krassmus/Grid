/**
 * Was ein Kalender zeigt (docs/KALENDER.md): aus Dokument, Einstellung und Rechten die Zeilen und Einträge, und daraus
 * mit den persönlichen Filtern die Zeilen der Zeitleiste.
 */
import * as Y from 'yjs'
import { buildLinkIndex, type CalendarDef, type CalendarLayer, type ColumnInfo, type SelectOption, type TableInfo } from './model'
import { columnCells, newCtx, type Cell, type CellCtx } from './cells'
import { reprMap, type Repr, type ReprAvatar } from './repr'
import { sortedRowIds } from './sorting'
import { CHECKBOX, DATE } from './columnTypes'
import { DAY, intervalOf, momentText, stack, type Interval } from './calendar'
import { formatDate } from './dateFormat'
import { ringOf } from './colCrypt'
import { hiddenByRights } from './rightsView'
import { t } from './i18n'

export interface Entry extends Interval {
  id: string
  label: string
  avatar?: ReprAvatar
  color?: SelectOption
  /** Die gespeicherten Werte von Beginn und Ende (`''` = leer) */
  values: { start: string; end: string }
  /** belegt nicht (z. B. storniert) */
  free: boolean
  /** Zeilen der Zeitleiste; leer = ohne Zuordnung */
  lanes: string[]
}

export interface Lane {
  id: string
  repr: Repr
  /** Werte der Filterspalten: Options-ID bzw. '1'/'0'; '' = leer */
  values: Record<string, string>
  group: string
}

export interface Choice { value: string; label: string; option?: SelectOption }
export interface LaneFilter { col: ColumnInfo; choices: Choice[] }

export interface CalendarData {
  source: TableInfo
  layer: CalendarLayer
  laneTable: TableInfo
  lanes: Lane[]
  entries: Entry[]
  /** Einträge ohne lesbaren Beginn */
  untimed: { id: string; title: string }[]
  /** Gruppen der Zeilen in der Reihenfolge der Optionen (`''` = ohne Angabe, am Ende); `null` = nicht gruppiert */
  groups: { id: string; name: string; option?: SelectOption }[] | null
  laneFilters: LaneFilter[]
  colors: SelectOption[]
  /** Mindestens eine Datumsspalte gibt Uhrzeiten an */
  timed: boolean
  /** Beginn und (sofern eingestellt) Ende geben Uhrzeiten an: beim Ziehen darf nach Uhrzeit gerastet werden */
  dragTimed: boolean
}

/** Darf der Betrachter die Spalte lesen: Recht (auch über das, worauf sie aufbaut) und, bei vertraulichen, Schlüssel? */
export function readableColumns(doc: Y.Doc, tables: TableInfo[], access: (tableId: string, colId: string) => string) {
  const unreadable = new Set(tables.flatMap((x) => x.columns.filter((c) => access(x.id, c.id) === 'none').map((c) => c.id)))
  const hidden = new Map<string, Set<string>>()
  return (table: TableInfo, col: { id: string }) => {
    let set = hidden.get(table.id)
    if (!set) hidden.set(table.id, (set = hiddenByRights(table, tables, unreadable)))
    return !set.has(col.id) && !ringOf(doc).locked(col.id)
  }
}

export type CalendarProblem = 'incomplete' | 'rights'

/**
 * `tables`: die für den Betrachter sichtbaren Tabellen; `readable`: darf er die Spalte lesen (Recht und Schlüssel)?
 * `all`: alle Tabellen, um „gibt es nicht“ von „darf ich nicht sehen“ zu unterscheiden.
 */
export function calendarData(
  doc: Y.Doc, tables: TableInfo[], def: CalendarDef, readable: (table: TableInfo, col: ColumnInfo) => boolean,
  all: TableInfo[] = tables, ctx: CellCtx = newCtx(),
): CalendarData | { problem: CalendarProblem } {
  const layer = def.layers[0]
  if (!layer) return { problem: 'incomplete' }
  // Zuerst prüfen, ob die Einstellung überhaupt noch passt
  const fullSource = all.find((x) => x.id === layer.table)
  const need = [layer.start, layer.lane, ...(layer.end ? [layer.end] : [])]
  if (!fullSource || need.some((id) => !fullSource.columns.some((c) => c.id === id))) return { problem: 'incomplete' }
  const fullLane = fullSource.columns.find((c) => c.id === layer.lane)!
  if (fullLane.type !== 'relation' || !all.some((x) => x.id === fullLane.target)) return { problem: 'incomplete' }
  const source = tables.find((x) => x.id === layer.table)
  const laneTable = tables.find((x) => x.id === fullLane.target)
  if (!source || !laneTable) return { problem: 'rights' }
  const column = (table: TableInfo, id: string | undefined) => (id ? table.columns.find((c) => c.id === id) : undefined)
  const usable = (table: TableInfo, id: string | undefined) => { const c = column(table, id); return c && readable(table, c) ? c : undefined }
  // Ohne eine dieser Spalten sähe Belegtes frei aus: dann lieber gar nichts zeigen
  if (need.some((id) => !usable(source, id))) return { problem: 'rights' }

  const startCol = usable(source, layer.start)!, endCol = usable(source, layer.end), laneCol = usable(source, layer.lane)!
  const cells = (table: TableInfo, col: ColumnInfo) => columnCells(doc, tables, table, col, ctx)
  const starts = cells(source, startCol), ends = endCol && cells(source, endCol)
  const linkIds = (ctx.links ??= buildLinkIndex(doc).forward)

  const labelSet = !!column(source, layer.label)
  const labelCol = usable(source, layer.label)
  const labels = labelCol && cells(source, labelCol)
  const labelTarget = labelCol?.type === 'relation' ? tables.find((x) => x.id === labelCol.target) : undefined
  const sourceReprs = reprMap(doc, tables, source, ctx)

  const colorCol = usable(source, layer.color)
  const colors = colorCol?.type === 'select' ? colorCol.options ?? [] : []
  const colorCells = colorCol && cells(source, colorCol)
  // Darf die Spalte, die über „belegt nicht“ entscheidet, nicht gelesen werden, belegt jeder Eintrag
  const freeCol = layer.free && usable(source, layer.free.col)
  const freeCells = freeCol && cells(source, freeCol)
  const isFree = (id: string): boolean => {
    if (!freeCol) return false
    const raw = freeCells!.get(id)?.raw
    if (freeCol.type === 'checkbox') return !!raw && layer.free!.values.includes('1')
    return typeof raw === 'string' && layer.free!.values.includes(raw)
  }

  const laneRows = laneTable.sort ? sortedRowIds(doc, laneTable.id, laneTable.sort.colId, laneTable.sort.dir) : laneTable.rowIds
  const laneSet = new Set(laneRows)

  const entries: Entry[] = []
  const untimed: CalendarData['untimed'] = []
  for (const id of source.rowIds) {
    const interval = intervalOf(starts.get(id)?.raw, ends?.get(id)?.raw)
    const title = sourceReprs.get(id)?.title ?? ''
    if (!interval) { untimed.push({ id, title: labels?.get(id)?.text || (labelSet && !labelCol ? t('Belegt') : title) }); continue }
    const free = isFree(id)
    let label = title
    let avatar: ReprAvatar | undefined
    if (labelSet) {
      if (!labels) label = free ? '' : t('Belegt')
      else {
        label = labels.get(id)?.text || (free ? '' : t('Belegt')) // ein leerer Balken sagte nicht, dass hier belegt ist
        const first = labelTarget && (linkIds.get(`${id}|${labelCol!.id}`) ?? [])[0]
        if (first) avatar = reprMap(doc, tables, labelTarget!, ctx).get(first)?.avatar
      }
    }
    const raw = colorCells?.get(id)?.raw
    entries.push({
      ...interval, id, label, avatar, free,
      values: { start: String(starts.get(id)?.raw ?? ''), end: String(ends?.get(id)?.raw ?? '') },
      color: colors.find((o) => o.id === raw),
      lanes: (linkIds.get(`${id}|${laneCol.id}`) ?? []).filter((x) => laneSet.has(x)),
    })
  }

  // Zeilen der Zeitleiste samt Werten für Gruppen und Filter
  const laneReprs = reprMap(doc, tables, laneTable, ctx)
  const choosable = (c: ColumnInfo | undefined) => !!c && (c.type === 'select' || c.type === 'checkbox')
  const filterCols = def.filters.map((id) => usable(laneTable, id)).filter((c): c is ColumnInfo => choosable(c))
  const groupCandidate = usable(laneTable, def.groupBy)
  const groupCol = groupCandidate?.type === 'select' ? groupCandidate : undefined
  const valueCols = [...filterCols, ...(groupCol && !filterCols.includes(groupCol) ? [groupCol] : [])]
  const valueCells = new Map<string, Map<string, Cell>>(valueCols.map((c) => [c.id, cells(laneTable, c)]))
  const valueOf = (c: ColumnInfo, id: string): string => {
    const raw = valueCells.get(c.id)!.get(id)?.raw
    if (c.type === 'checkbox') return raw ? '1' : '0'
    return typeof raw === 'string' && (c.options ?? []).some((o) => o.id === raw) ? raw : ''
  }
  const lanes: Lane[] = laneRows.map((id) => ({
    id,
    repr: laneReprs.get(id)!,
    values: Object.fromEntries(filterCols.map((c) => [c.id, valueOf(c, id)])),
    group: groupCol ? valueOf(groupCol, id) : '',
  }))

  const laneFilters: LaneFilter[] = filterCols.map((col) => ({
    col,
    choices: col.type === 'checkbox'
      ? [{ value: '1', label: CHECKBOX.config(col).label || t('Ja') }, { value: '0', label: t('Nein') }]
      : [
          ...(col.options ?? []).map((o) => ({ value: o.id, label: o.name, option: o })),
          ...(lanes.some((l) => l.values[col.id] === '') ? [{ value: '', label: t('Ohne Angabe') }] : []),
        ],
  }))

  const groups = groupCol
    ? [
        ...(groupCol.options ?? []).filter((o) => lanes.some((l) => l.group === o.id)).map((o) => ({ id: o.id, name: o.name, option: o })),
        ...(lanes.some((l) => l.group === '') ? [{ id: '', name: t('Ohne Angabe') }] : []),
      ]
    : null

  const hasTime = (c: ColumnInfo | undefined) => c?.type === 'date' && DATE.config(c).time
  const timed = hasTime(startCol) || hasTime(endCol)
  const dragTimed = hasTime(startCol) && (!endCol || hasTime(endCol))
  return { source, layer, laneTable, lanes, entries, untimed, groups, laneFilters, colors, timed, dragTimed }
}

/** „3.12. – 5.12.“ bzw. mit Uhrzeiten; reine Tagesangaben nennen den letzten Tag. */
export function rangeText(e: Pick<Interval, 'from' | 'to' | 'kind'>): string {
  const whole = (m: number) => m % DAY === 0
  const text = (min: number, timed: boolean) => formatDate(momentText(min, timed), 'short', timed)
  if (e.kind !== 'span') return text(e.from, !whole(e.from))
  if (whole(e.from) && whole(e.to)) return e.to - e.from <= DAY ? text(e.from, false) : `${text(e.from, false)} – ${text(e.to - DAY, false)}`
  return `${text(e.from, true)} – ${text(e.to, true)}`
}

// ---------- Überschneidungen ----------

/** Belegt der Eintrag eine Zeit? Was nicht belegt, Marken und verdrehte Zeiträume zählen nicht. */
const occupies = (e: Pick<Entry, 'kind' | 'free'>) => !e.free && e.kind === 'span'

/** Belegende Einträge der Zeile, die in den Zeitraum hineinreichen (Anschließendes nicht), außer `except`. */
export function overlapping(data: CalendarData, lane: string, time: Pick<Interval, 'from' | 'to' | 'kind'>, except?: string): Entry[] {
  if (!lane || time.kind !== 'span') return []
  return data.entries.filter((e) => e.id !== except && occupies(e) && e.from < time.to && time.from < e.to && e.lanes.includes(lane))
}

export interface Clash { lane: string; /** Beginn der ersten doppelt belegten Zeit */ at: number; ids: string[] }
export interface Clashes {
  /** `Zeile|Eintrag` aller Balken, die sich mit einem anderen derselben Zeile überschneiden (auch vergangene) */
  marked: Set<string>
  /** Doppelbelegungen, die noch nicht vorbei sind, der Zeit nach. Eine Kette sich überschneidender Einträge zählt einmal. */
  upcoming: Clash[]
}

/** Alle Doppelbelegungen, unabhängig von Suche und Filtern. `today`: Beginn des heutigen Tages. „Ohne Zuordnung“ belegt nichts. */
export function clashes(data: CalendarData, today: number): Clashes {
  const byLane = new Map<string, Entry[]>()
  for (const e of data.entries) {
    if (!occupies(e)) continue
    for (const lane of e.lanes) {
      const list = byLane.get(lane)
      if (list) list.push(e); else byLane.set(lane, [e])
    }
  }
  const marked = new Set<string>()
  const upcoming: Clash[] = []
  for (const [lane, list] of byLane) {
    list.sort((a, b) => a.from - b.from || a.to - b.to)
    let chain: string[] = [], end = -Infinity, at = Infinity, doubleEnd = -Infinity
    const close = () => {
      if (chain.length > 1) {
        for (const id of chain) marked.add(`${lane}|${id}`)
        if (doubleEnd > today) upcoming.push({ lane, at, ids: chain })
      }
    }
    for (const e of list) {
      if (e.from < end) {
        const until = Math.min(e.to, end)
        // Ist ein früherer Teil der Kette schon vorbei, zählt der erste noch kommende
        if (until > today && doubleEnd <= today) at = e.from
        else if (at === Infinity) at = e.from
        doubleEnd = Math.max(doubleEnd, until)
        chain.push(e.id)
        end = Math.max(end, e.to)
      } else {
        close()
        chain = [e.id]; end = e.to; at = Infinity; doubleEnd = -Infinity
      }
    }
    close()
  }
  const order = new Map(data.lanes.map((l, i) => [l.id, i]))
  upcoming.sort((a, b) => a.at - b.at || (order.get(a.lane) ?? 0) - (order.get(b.lane) ?? 0))
  return { marked, upcoming }
}

const LISTED = 3

/**
 * Warnungen für ein Formular: Womit überschneidet sich der Eintrag mit diesen (noch nicht gespeicherten) Werten und
 * Verknüpfungen? `rowId`: der bearbeitete Eintrag selbst zählt nicht. Je betroffener Zeile ein Satz.
 */
export function overlapWarnings(data: CalendarData, values: Record<string, unknown>, relations: Record<string, string[]>, rowId?: string): string[] {
  const { layer } = data
  const time = intervalOf(values[layer.start], layer.end ? values[layer.end] : null)
  if (!time) return []
  if (layer.free) {
    const v = values[layer.free.col]
    const checkbox = data.source.columns.find((c) => c.id === layer.free!.col)?.type === 'checkbox'
    if (checkbox ? !!v && layer.free.values.includes('1') : typeof v === 'string' && layer.free.values.includes(v)) return []
  }
  return (relations[layer.lane] ?? []).flatMap((id) => {
    const lane = data.lanes.find((l) => l.id === id)
    const found = lane ? overlapping(data, id, time, rowId).sort((a, b) => a.from - b.from) : []
    if (!found.length) return []
    const list = found.slice(0, LISTED).map((e) => `${e.label || t('Belegt')}, ${rangeText(e)}`)
    if (found.length > LISTED) list.push(t('{n} weitere', { n: found.length - LISTED }))
    return [t('„{name}“ ist in dieser Zeit schon belegt: {list}', { name: lane!.repr.title, list: list.join('; ') })]
  })
}

// ---------- Persönliche Filter ----------

export interface CalendarFilter {
  /** Suche: findet Zeilen (Titel, Untertitel) und Einträge (Beschriftung) */
  query: string
  /** Je Filterspalte die gewählten Werte; leer = alle */
  laneValues: Record<string, string[]>
  /** Gewählte Farboptionen; leer = alle */
  colors: string[]
  /** Auch zeigen, was nicht belegt */
  showFree: boolean
  collapsed: string[]
}
export const NO_FILTER: CalendarFilter = { query: '', laneValues: {}, colors: [], showFree: false, collapsed: [] }

export interface Bar { entry: Entry; from: number; to: number; /** passt nicht zu Suche oder Filter, belegt aber: nur abgeblasst */ dim: boolean; row: number }

export type Row =
  | { type: 'group'; key: string; id: string; name: string; option?: SelectOption; count: number; collapsed: boolean }
  | { type: 'lane'; key: string; lane: Lane | null; bars: Bar[]; subRows: number }

const lower = (s: string) => s.trim().toLowerCase()

/** Passt die Zeile zu den Auswahlknöpfen? */
export function laneChosen(lane: Lane, f: CalendarFilter, filters: LaneFilter[]): boolean {
  return filters.every(({ col }) => { const chosen = f.laneValues[col.id]; return !chosen?.length || chosen.includes(lane.values[col.id]) })
}
/** Findet die Suche die Zeile selbst? (Ohne Suchtext: ja) */
const laneFound = (lane: Lane | null, q: string) => !q || (!!lane && [lane.repr.title, ...lane.repr.subs].join(' ').toLowerCase().includes(q))
const entryFound = (entry: Entry, q: string) => !!q && entry.label.toLowerCase().includes(q)

/**
 * Wie ein Eintrag in einer Zeile erscheint. `found`: die Suche findet die Zeile oder den Eintrag.
 * Was belegt, verschwindet nie, sonst sähe Belegtes frei aus.
 */
export function barState(entry: Entry, f: CalendarFilter, colors: SelectOption[], found: boolean): 'normal' | 'dim' | 'hidden' {
  // Optionen, die es nicht mehr gibt, zählen im gespeicherten Filter nicht
  const chosen = f.colors.filter((id) => id === '' || colors.some((o) => o.id === id))
  const hit = found && (!chosen.length || chosen.includes(entry.color?.id ?? ''))
  if (entry.free) return f.showFree && hit ? 'normal' : 'hidden'
  return hit ? 'normal' : 'dim'
}

export const laneFilterActive = (f: CalendarFilter, filters: LaneFilter[]) => filters.some(({ col }) => !!f.laneValues[col.id]?.length)

/** Zeilen der Zeitleiste: Gruppenköpfe und Zeilen mit ihren Balken. `minLength`: kleinste gezeichnete Länge in Minuten. */
export function calendarRows(data: CalendarData, f: CalendarFilter, minLength = 0): Row[] {
  const q = lower(f.query)
  const byLane = new Map<string, Entry[]>()
  for (const entry of data.entries) {
    for (const lane of entry.lanes.length ? entry.lanes : ['']) {
      const list = byLane.get(lane)
      if (list) list.push(entry); else byLane.set(lane, [entry])
    }
  }
  const barsOf = (lane: Lane | null) => {
    const whole = laneFound(lane, q)
    return (byLane.get(lane?.id ?? '') ?? []).flatMap((entry) => {
      const found = whole || entryFound(entry, q)
      const state = barState(entry, f, data.colors, found)
      return state === 'hidden' ? [] : [{ entry, from: entry.from, to: entry.to, dim: state === 'dim', found }]
    })
  }
  /** Bei einer Suche bleibt eine Zeile, wenn die Suche sie selbst oder einen ihrer gezeigten Einträge findet */
  const searched = (lane: Lane | null, bars: ReturnType<typeof barsOf>) => laneFound(lane, q) || bars.some((b) => b.found && (!b.entry.free || !b.dim))
  const laneRow = ({ lane, bars }: { lane: Lane | null; bars: ReturnType<typeof barsOf> }): Row => {
    const placed = stack(bars, minLength)
    return { type: 'lane', key: lane ? lane.id : '·ohne', lane, bars: bars.map((b) => ({ entry: b.entry, from: b.from, to: b.to, dim: b.dim, row: placed.row.get(b)! })), subRows: Math.max(1, placed.rows) }
  }
  const shown = data.lanes.filter((l) => laneChosen(l, f, data.laneFilters)).map((lane) => ({ lane, bars: barsOf(lane) })).filter((x) => searched(x.lane, x.bars))
  const out: Row[] = []
  if (data.groups) {
    for (const g of data.groups) {
      const members = shown.filter((x) => x.lane.group === g.id)
      if (!members.length) continue
      const collapsed = f.collapsed.includes(g.id)
      out.push({ type: 'group', key: `·g${g.id}`, id: g.id, name: g.name, option: g.option, count: members.length, collapsed })
      if (!collapsed) out.push(...members.map(laneRow))
    }
  } else out.push(...shown.map(laneRow))
  if (!laneFilterActive(f, data.laneFilters)) {
    const bars = barsOf(null)
    if (bars.length && (!q || bars.some((b) => b.found))) out.push(laneRow({ lane: null, bars }))
  }
  return out
}

/** Wie viele Zeilen (ohne „Ohne Zuordnung“) gezeigt werden, auch die in eingeklappten Gruppen */
export const shownLanes = (rows: Row[], grouped: boolean) =>
  rows.reduce((n, r) => n + (r.type === 'group' ? r.count : !grouped && r.lane ? 1 : 0), 0)
