import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import * as Y from 'yjs'
import { addLink, buildLinkIndex, removeLink, rowExists, setCell, type CalendarInfo, type SelectOption, type TableInfo } from './model'
import { targetAvailable } from './relationRules'
import { DAY, SCALES, changedValues, dayStart, intervalOf, movedLanes, type ChangeMode, dayWidth, dragRange, dragStep, dragValues, drawnDays, isoWeek, leftFor, momentText, nowMinutes, page, parseMoment, periods, ticks, type Scale } from './calendar'
import { NO_FILTER, calendarData, calendarRows, clashes, laneFilterActive, overlapping, rangeText, readableColumns, shownLanes, type Clash, type Bar, type CalendarData, type CalendarFilter, type Entry, type Row } from './calendarData'
import { beginTimelineDrag } from './calendarDrag'
import { useFileIndex, useLinkIndex, useRingVersion } from './useTables'
import { useRights } from './rights'
import { offsetsOf, visibleRange } from './virtualRows'
import { ItemMenu, beginLongPress } from './ItemMenu'
import { Avatar, TileContent, tileClasses } from './ReprTile'
import { Pill, paletteOf } from './SelectCell'
import { DatePicker } from './DatePicker'
import { locale, t, tn } from './i18n'

/** Höhe der Zeitachse (siehe .cal-head) */
const HEAD_HEIGHT = 48
const BAR_HEIGHT = 24, BAR_GAP = 4, LANE_PADDING = 8, LANE_MIN = 52, GROUP_HEIGHT = 34
/** Kleinste Breite eines Balkens: auch sehr Kurzes muss man treffen können */
const MIN_BAR = 14
const heightOf = (row: Row) => (row.type === 'group' ? GROUP_HEIGHT : Math.max(LANE_MIN, row.subRows * (BAR_HEIGHT + BAR_GAP) - BAR_GAP + 2 * LANE_PADDING))

const scaleLabel = (s: Scale) => ({ day: t('Tag'), week: t('Woche'), month: t('Monat'), quarter: t('Quartal') })[s]

// ---------- Persönliche Einstellung: bleibt auf diesem Gerät und ändert das Dokument nicht ----------

interface Saved { filter: CalendarFilter; scale?: Scale }
const storageKey = (id: string) => `grid.calendar.${id}`
function loadSaved(id: string): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(id)) ?? '{}')
    const f = raw.filter ?? {}
    const list = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v) => typeof v === 'string') : [])
    return {
      scale: SCALES.includes(raw.scale) ? raw.scale : undefined,
      filter: {
        query: '', // die Suche gilt wie bei Tabellen nur bis zum Beenden: eine vergessene verbärge sonst Zeilen
        laneValues: Object.fromEntries(Object.entries(f.laneValues ?? {}).map(([k, v]) => [k, list(v)])),
        colors: list(f.colors), collapsed: list(f.collapsed), showFree: f.showFree === true,
      },
    }
  } catch { return { filter: NO_FILTER } }
}
/** Der angesehene Zeitpunkt gilt nur bis zum Beenden: beim nächsten Start zeigt der Kalender wieder heute. */
const positions = new Map<string, number>()

// ---------- Beschriftungen ----------

const utc = (min: number, options: Intl.DateTimeFormatOptions) => new Date(min * 60000).toLocaleDateString(locale(), { ...options, timeZone: 'UTC' })

function periodLabel(scale: Scale, from: number): string {
  return scale === 'day' ? utc(from, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : utc(from, { month: 'long', year: 'numeric' })
}
function tickLabel(scale: Scale, from: number): string {
  if (scale === 'day') return String(new Date(from * 60000).getUTCHours())
  if (scale === 'week') return utc(from, { weekday: 'short', day: 'numeric' })
  if (scale === 'month') return String(new Date(from * 60000).getUTCDate())
  return t('KW {n}', { n: isoWeek(from) })
}

/** Was ein neuer Eintrag mitbringt: Werte und Verknüpfungen, je Spalte */
export interface NewEntry { tableId: string; values: Record<string, string>; relations: Record<string, string[]> }

// ---------- Ansicht ----------

export function CalendarView(props: {
  doc: Y.Doc
  calendar: CalendarInfo
  /** Für den Betrachter sichtbare Tabellen */
  tables: TableInfo[]
  allTables: TableInfo[]
  /** `entry`: Beschreibung, wenn es ein Eintrag des Kalenders ist (er lässt sich dann dort auch löschen) */
  onOpenRecord: (tableId: string, rowId: string, entry?: string) => void
  /** Rückfrage zum Löschen eines Eintrags; darf man nicht löschen, liefert `canDelete` `false` */
  onDeleteEntry: (tableId: string, rowId: string, entry: string) => void
  canDelete: (table: TableInfo) => boolean
  /** Darf man diese Spalte jetzt ändern? (nicht in der Zeitreise) */
  canWrite: (table: TableInfo, colId: string) => boolean
  /** Neuen Eintrag anlegen; fehlt das Recht dazu, liefert `canAdd` `false` */
  onNew: (entry: NewEntry) => void
  canAdd: (table: TableInfo) => boolean
  onEdit?: () => void
  /** Platz in der Fußleiste für „+ Eintrag“ und die Suche */
  footer: HTMLElement | null
}) {
  const { doc, calendar, tables, allTables } = props
  const rights = useRights()
  const index = useLinkIndex(doc)
  const fileIndex = useFileIndex(doc)
  const ringVersion = useRingVersion(doc)
  const data = useMemo(() => {
    return calendarData(doc, tables, calendar.def, readableColumns(doc, tables, (tableId, colId) => rights.colAccess(tableId, colId)), allTables)
  }, [doc, tables, allTables, calendar.def, rights, index, fileIndex, ringVersion])

  if ('problem' in data) {
    return (
      <div className="calendar-problem">
        <p className="hint">{data.problem === 'rights'
          ? t('Für diesen Kalender fehlen dir Leserechte. Teilweise gezeigt sähe Belegtes frei aus.')
          : t('Die Einstellung dieses Kalenders passt nicht mehr: Eine Tabelle oder Spalte, die er braucht, fehlt.')}</p>
        {data.problem === 'incomplete' && props.onEdit && <button type="button" onClick={props.onEdit}>{t('Bearbeiten …')}</button>}
      </div>
    )
  }
  return <Timeline {...props} data={data} />
}

function Timeline(props: Parameters<typeof CalendarView>[0] & { data: CalendarData }) {
  const { calendar, data } = props
  const [saved, setSaved] = useState(() => loadSaved(calendar.id))
  useEffect(() => { try { localStorage.setItem(storageKey(calendar.id), JSON.stringify(saved)) } catch { /* egal */ } }, [calendar.id, saved])
  const filter = saved.filter
  const setFilter = (patch: Partial<CalendarFilter>) => setSaved((s) => ({ ...s, filter: { ...s.filter, ...patch } }))
  const scale: Scale = saved.scale ?? (data.timed ? 'week' : 'month')

  const [now, setNow] = useState(() => nowMinutes())
  useEffect(() => { const id = setInterval(() => setNow(nowMinutes()), 60_000); return () => clearInterval(id) }, [])

  // ---------- Ausschnitt ----------
  const scroller = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ width: 1000, height: 600 })
  useLayoutEffect(() => {
    const el = scroller.current!
    const measure = () => setBox((b) => (b.width === el.clientWidth && b.height === el.clientHeight ? b : { width: el.clientWidth, height: el.clientHeight }))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const laneWidth = Math.round(Math.min(220, Math.max(116, box.width * 0.26)))
  const available = Math.max(200, box.width - laneWidth)
  const perDay = dayWidth(scale, available)
  const perMinute = perDay / DAY
  const days = drawnDays(scale)
  const width = days * perDay

  // Gezeichnet wird ein begrenztes Stück der Zeitachse um `origin`; nahe am Rand rückt es nach, so läuft die Achse endlos.
  const [initial] = useState(() => positions.get(calendar.id) ?? leftFor(scale, nowMinutes(), true))
  const left = useRef(initial) // Zeitpunkt am linken Rand des Sichtbaren
  const originFor = (at: number) => dayStart(at) - Math.floor(days / 2) * DAY
  const [origin, setOrigin] = useState(() => originFor(initial))
  const pending = useRef<number | null>(initial)
  const [view, setView] = useState({ x: 0, y: 0 })
  const jump = (at: number) => {
    pending.current = at
    left.current = at
    positions.set(calendar.id, at)
    setOrigin(originFor(at))
    setView((v) => ({ ...v })) // auch ohne neuen Ausschnitt neu ausrichten
  }
  // Nach einem Sprung, einem neuen Maßstab oder anderer Breite: wieder auf denselben Zeitpunkt scrollen
  const geometry = useRef(`${scale}|${perDay}`)
  useLayoutEffect(() => {
    const el = scroller.current!
    const changed = geometry.current !== `${scale}|${perDay}`
    geometry.current = `${scale}|${perDay}`
    if (changed) {
      const next = originFor(left.current)
      if (next !== origin) { pending.current = left.current; setOrigin(next); return }
      pending.current = left.current
    }
    if (pending.current === null) return
    el.scrollLeft = (pending.current - origin) * perMinute
    pending.current = null
    setView({ x: el.scrollLeft, y: el.scrollTop })
  })
  const frame = useRef(0)
  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  const onScroll = () => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const el = scroller.current
      if (!el || pending.current !== null) return
      const at = origin + el.scrollLeft / perMinute
      left.current = at
      positions.set(calendar.id, at)
      const margin = el.clientWidth
      if (el.scrollLeft < margin || el.scrollLeft > el.scrollWidth - 2 * margin) {
        const next = originFor(at)
        if (next !== origin) { pending.current = at; setOrigin(next); return }
      }
      setView({ x: el.scrollLeft, y: el.scrollTop })
    })
  }
  const setScale = (next: Scale) => {
    if (next === scale) return
    // Ist heute zu sehen, bleibt heute im Blick, sonst die Mitte des Sichtbaren
    const end = left.current + available / perMinute
    const focus = now >= left.current && now < end ? now : (left.current + end) / 2
    const at = leftFor(next, focus, true)
    left.current = at
    positions.set(calendar.id, at)
    setSaved((s) => ({ ...s, scale: next }))
  }

  // ---------- Zeilen ----------
  const rows = useMemo(() => calendarRows(data, filter, (MIN_BAR + 2) / perMinute), [data, filter, perMinute])
  const keys = useMemo(() => rows.map((r) => r.key), [rows])
  const offsets = useMemo(() => offsetsOf(keys, new Map(rows.map((r) => [r.key, heightOf(r)]))), [keys, rows])
  const range = visibleRange(offsets, view.y, box.height)
  const total = offsets[rows.length] ?? 0

  // Nur zeichnen, was waagerecht in der Nähe ist
  const from = origin + Math.max(0, view.x - available) / perMinute
  const to = origin + Math.min(width, view.x + 2 * available) / perMinute
  const x = (min: number) => (min - origin) * perMinute
  const fine = ticks(scale, from, to)
  const coarse = periods(scale, from, to)
  const atLeft = origin + view.x / perMinute

  // ---------- Neuer Eintrag durch Ziehen ----------
  const rights = useRights()
  const { layer, source } = data
  // Nur wer alles ausfüllen darf, was das Ziehen vorbelegt
  const canDrag = props.canAdd(source) && [layer.start, layer.lane, layer.end].every((id) => !id || rights.colAccess(source.id, id) === 'write')
  const step = dragStep(scale, data.dragTimed)
  const [selection, setSelection] = useState<{ key: string; from: number; to: number } | null>(null)
  const geo = useRef({ origin, perMinute, laneWidth })
  useLayoutEffect(() => { geo.current = { origin, perMinute, laneWidth } })
  const abortDrag = useRef<() => void>(() => {})
  useEffect(() => () => abortDrag.current(), [])
  const startDrag = (e: ReactPointerEvent, row: Extract<Row, { type: 'lane' }>) => {
    if (!canDrag || (e.target as Element).closest('.cal-bar, .cal-lanehead')) return
    const el = scroller.current!
    const grid = step // bleibt während des Ziehens derselbe
    abortDrag.current()
    abortDrag.current = beginTimelineDrag(e.nativeEvent, {
      scroller: el,
      laneWidth: () => geo.current.laneWidth,
      timeAt: (clientX) => {
        const g = geo.current
        const inside = Math.max(g.laneWidth, Math.min(clientX - el.getBoundingClientRect().left, el.clientWidth - 1))
        return g.origin + (el.scrollLeft + inside - g.laneWidth) / g.perMinute
      },
      onChange: (a, b) => setSelection({ key: row.key, ...dragRange(a, b, grid) }),
      onEnd: (result) => {
        setSelection(null)
        if (!result) return
        const v = dragValues(dragRange(result.anchor, result.head, grid), grid)
        props.onNew({
          tableId: source.id,
          values: { [layer.start]: v.start, ...(layer.end ? { [layer.end]: v.end } : {}) },
          relations: row.lane ? { [layer.lane]: [row.lane.id] } : {},
        })
      },
    })
  }

  // ---------- Überschneidungen ----------
  const today = dayStart(now)
  const clash = useMemo(() => clashes(data, today), [data, today])
  const clashAt = useRef(-1) // zuletzt angesprungene Stelle
  const [flash, setFlash] = useState<string | null>(null) // Zeile, die nach dem Sprung kurz hervortritt
  const wanted = useRef<string | null>(null) // Zeile, zu der senkrecht gescrollt werden soll, sobald sie da ist
  useEffect(() => { if (!flash) return; const id = setTimeout(() => setFlash(null), 1600); return () => clearTimeout(id) }, [flash])
  useLayoutEffect(() => {
    const key = wanted.current
    const i = key ? rows.findIndex((r) => r.key === key) : -1
    if (i < 0) return
    wanted.current = null
    const el = scroller.current!
    el.scrollTop = Math.max(0, offsets[i] - (el.clientHeight - HEAD_HEIGHT - heightOf(rows[i])) / 2)
    setView((v) => ({ ...v, y: el.scrollTop }))
  })
  const showClash = (c: Clash) => {
    const lane = data.lanes.find((l) => l.id === c.lane)
    if (!lane) return
    // Versteckt ein Filter, die Suche oder eine eingeklappte Gruppe die Zeile, wird sie wieder sichtbar gemacht
    const hidden = !calendarRows(data, { ...filter, collapsed: [] }).some((r) => r.key === c.lane)
    setFilter({ ...(hidden ? { query: '', laneValues: {} } : {}), collapsed: filter.collapsed.filter((g) => g !== lane.group) })
    wanted.current = c.lane
    setFlash(c.lane)
    jump(leftFor(scale, c.at, true))
  }
  const nextClash = () => {
    clashAt.current = (clashAt.current + 1) % clash.upcoming.length
    showClash(clash.upcoming[clashAt.current])
  }

  const [showUntimed, setShowUntimed] = useState(false)
  const [showFilters, setShowFilters] = useState(false) // nur auf schmalen Bildschirmen: dort sind die Filter eingeklappt
  const filtering = laneFilterActive(filter, data.laneFilters) || filter.colors.length > 0 || filter.showFree // ohne die Suche: sie steht sichtbar unten
  const hasFilters = data.laneFilters.length > 0 || data.colors.length > 0 || data.entries.some((e) => e.free)
  const searchRef = useRef<HTMLInputElement>(null)
  // Tippen ohne Fokus (kein Feld, kein Dialog) landet in der Suche, wie bei Tabellen
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.key.length !== 1 || e.key === ' ' || e.metaKey || e.ctrlKey || e.altKey) return
      const focused = document.activeElement
      if (focused && focused !== document.body && focused !== document.documentElement) return
      if (document.querySelector('.dialog, .datepop, .backdrop') || !searchRef.current) return
      e.preventDefault()
      setSaved((s) => ({ ...s, filter: { ...s.filter, query: s.filter.query + e.key } }))
      searchRef.current.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((v) => v !== id) : [...list, id])
  const chip = (key: string, on: boolean, click: () => void, label: string, option?: SelectOption) => (
    <button type="button" key={key} className={`cal-chip${on ? ' on' : ''}`} aria-pressed={on} onClick={click}>{option ? <Pill option={option} /> : label}</button>
  )

  /** Womit ein Eintrag beim Löschen benannt wird */
  const describe = (e: Entry) => {
    const text = t('Eintrag „{name}“, {range}, aus „{table}“.', { name: e.label || t('Ohne Titel'), range: rangeText(e), table: data.source.name })
    return e.lanes.length > 1 ? `${text} ${t('Er belegt {n} Zeilen und verschwindet aus allen.', { n: e.lanes.length })}` : text
  }
  const describeUntimed = (u: { title: string }) => t('Eintrag „{name}“ aus „{table}“.', { name: u.title || t('Ohne Titel'), table: data.source.name })
  // Kontextmenü eines Balkens: Rechtsklick, mit dem Finger langes Drücken
  const mayDelete = props.canDelete(data.source)
  const [menu, setMenu] = useState<{ x: number; y: number; id: string; entry: string } | null>(null)

  // ---------- Verschieben und Dauer ändern ----------
  const may = { start: props.canWrite(source, layer.start), end: !!layer.end && props.canWrite(source, layer.end), lane: props.canWrite(source, layer.lane) }
  /** Was sich an diesem Eintrag ziehen lässt */
  const grips = (e: Entry) => ({
    move: may.start && (!e.values.end || may.end),
    // Ohne Ende schriebe das Ziehen am Anfang den bisherigen Tag als Ende fest
    start: e.kind === 'span' && may.start && (!layer.end || !!e.values.end || may.end),
    end: e.kind === 'span' && may.end,
  })
  const [moving, setMoving] = useState<{ id: string; sourceKey: string; from: number; to: number; kind: Entry['kind']; free: boolean; lanes: string[] } | null>(null)
  const rowsRef = useRef({ rows, offsets })
  useLayoutEffect(() => { rowsRef.current = { rows, offsets } })
  const touchDragging = useRef(false)
  const startMove = (ev: ReactPointerEvent<HTMLDivElement>, entry: Entry, laneId: string) => {
    const can = grips(entry)
    const touch = ev.pointerType === 'touch'
    const openMenu = (x: number, y: number) => setMenu({ x, y, id: entry.id, entry: describe(entry) })
    const box = ev.currentTarget.getBoundingClientRect()
    const zone = Math.min(touch ? 24 : 8, box.width / 3)
    const mode: ChangeMode = can.start && ev.clientX - box.left <= zone ? 'start' : can.end && box.right - ev.clientX <= zone ? 'end' : 'move'
    if (mode === 'move' && !can.move && !(may.lane && ev.button === 0)) {
      if (mayDelete) beginLongPress(ev.nativeEvent, openMenu)
      return
    }
    ev.stopPropagation()
    const el = scroller.current!
    const timedStep = dragStep(scale, true)
    let result: { values: { start: string; end: string }; lanes: string[] } | null = null
    let over = laneId // Zeile unter dem Zeiger
    touchDragging.current = touch
    abortDrag.current()
    abortDrag.current = beginTimelineDrag(ev.nativeEvent, {
      scroller: el,
      laneWidth: () => geo.current.laneWidth,
      // Nicht auf den sichtbaren Teil begrenzt: gerechnet wird nur mit der zurückgelegten Strecke
      timeAt: (clientX) => { const g = geo.current; return g.origin + (el.scrollLeft + clientX - el.getBoundingClientRect().left - g.laneWidth) / g.perMinute },
      anyDirection: true,
      onHold: mayDelete ? openMenu : undefined,
      onChange: (anchor, head, pointer) => {
        const values = mode === 'move' && !can.move ? entry.values : changedValues(mode, entry.values, head - anchor, timedStep, !!layer.end)
        if (mode === 'move' && may.lane) {
          const y = pointer.y - el.getBoundingClientRect().top - HEAD_HEIGHT + el.scrollTop
          const { rows: list, offsets: tops } = rowsRef.current
          const hit = list.find((_, i) => y >= tops[i] && y < tops[i + 1])
          // Über einem Gruppenkopf oder außerhalb bleibt es bei der letzten Zeile
          if (hit?.type === 'lane') over = hit.lane?.id ?? ''
        }
        let lanes = movedLanes(entry.lanes, laneId, over)
        // Ein Ziel, das die Relation nur einmal verknüpfen darf und das schon vergeben ist, nimmt nichts an
        const col = source.columns.find((c) => c.id === layer.lane)!
        if (over && over !== laneId && lanes.includes(over) && !entry.lanes.includes(over) && !targetAvailable(buildLinkIndex(props.doc), col, over, [entry.id], (id) => rowExists(props.doc, source.id, id))) lanes = entry.lanes
        result = { values, lanes }
        if (mode === 'move') document.body.classList.add('cal-move')
        const next = intervalOf(values.start, values.end) ?? entry
        setMoving({ id: entry.id, sourceKey: laneId || '·ohne', from: next.from, to: next.to, kind: next.kind, free: entry.free, lanes })
      },
      onEnd: (done) => {
        touchDragging.current = false
        document.body.classList.remove('cal-move')
        setMoving(null)
        if (!done || !result || !rowExists(props.doc, source.id, entry.id)) return
        const { values, lanes } = result
        props.doc.transact(() => {
          if (values.start !== entry.values.start) setCell(props.doc, source.id, entry.id, layer.start, values.start)
          if (layer.end && values.end !== entry.values.end) setCell(props.doc, source.id, entry.id, layer.end, values.end || null)
          for (const id of entry.lanes) if (!lanes.includes(id)) removeLink(props.doc, source.id, entry.id, layer.lane, id)
          for (const id of lanes) if (!entry.lanes.includes(id)) addLink(props.doc, source.id, entry.id, layer.lane, id)
        })
      },
    })
  }

  const bar = (b: Bar, laneId: string) => {
    const e = b.entry
    // Der gezogene Balken bleibt gezeichnet, auch wenn er aus dem Bild rückt: verschwände er, endete auf dem iPad die Geste
    if (moving?.id !== e.id) {
      if (b.to < from && x(b.from) + MIN_BAR < x(from)) return null
      if (b.from > to) return null
    }
    const can = grips(e)
    const doubled = clash.marked.has(`${laneId}|${e.id}`)
    const palette = paletteOf(data.layer.color ? e.color?.color ?? 'gray' : 'blue')
    const w = Math.max(MIN_BAR, (b.to - b.from) * perMinute - 2)
    const title = [e.label, rangeText(e), e.color?.name, doubled ? t('Überschneidet sich mit einem anderen Eintrag') : '', e.kind === 'reversed' ? t('Das Ende liegt vor dem Beginn') : ''].filter(Boolean).join('\n')
    return (
      <div key={e.id} role="button" tabIndex={0} data-entry={e.id} title={title} aria-label={title.replaceAll('\n', ', ')}
        className={`cal-bar ${e.kind}${b.dim ? ' dim' : ''}${e.free ? ' free' : ''}${can.move ? ' movable' : ''}${doubled ? ' clash' : ''}${moving?.id === e.id ? ' moving' : ''}`}
        style={{ left: laneWidth + x(b.from) + 1, width: w, top: LANE_PADDING + b.row * (BAR_HEIGHT + BAR_GAP), background: palette.bg, color: palette.fg, borderColor: palette.dot }}
        onClick={() => props.onOpenRecord(data.source.id, e.id, describe(e))}
        onContextMenu={(ev) => {
          ev.stopPropagation()
          if (touchDragging.current) ev.preventDefault() // manche Systeme melden langes Drücken auch so; das gehört hier zum Ziehen
          else if (mayDelete) { ev.preventDefault(); setMenu({ x: ev.clientX, y: ev.clientY, id: e.id, entry: describe(e) }) }
        }}
        onPointerDown={(ev) => startMove(ev, e, laneId)}
        onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); props.onOpenRecord(data.source.id, e.id, describe(e)) } }}>
        <span className="cal-bar-label" style={{ left: laneWidth + 6 }}>
          {e.kind === 'reversed' && '⚠ '}
          {e.avatar && w > 40 && <Avatar avatar={e.avatar} />}
          {w > 24 && e.label}
        </span>
        {can.start && <span className="cal-grip start" aria-hidden />}
        {can.end && <span className="cal-grip end" aria-hidden />}
      </div>
    )
  }

  return (
    <div className="calendar">
      <div className="cal-toolbar">
        <span className="cal-nav">
          <button type="button" onClick={() => jump(page(scale, left.current, -1))} aria-label={t('Zurück blättern')}>‹</button>
          <button type="button" onClick={() => jump(leftFor(scale, nowMinutes(), true))}>{t('Heute')}</button>
          <button type="button" onClick={() => jump(page(scale, left.current, 1))} aria-label={t('Weiter blättern')}>›</button>
        </span>
        <DatePicker className="date-field cal-date" value={momentText(atLeft)} withTime={false} style="weekday" placeholder={t('Datum wählen')}
          onChange={(d) => { const m = parseMoment(d); if (m) jump(leftFor(scale, m.min + (scale === 'day' && data.timed ? 9 * 60 : 0), data.timed)) }} />
        <span className="cal-scales" role="radiogroup" aria-label={t('Maßstab')}>
          {SCALES.map((s) => <button type="button" key={s} role="radio" aria-checked={s === scale} className={s === scale ? 'on' : ''} onClick={() => setScale(s)}>{scaleLabel(s)}</button>)}
        </span>
        {clash.upcoming.length > 0 && (
          <button type="button" className="cal-clashes" onClick={nextClash} title={t('Zur nächsten Überschneidung springen')}>⚠ {tn(clash.upcoming.length, '{n} Überschneidung', '{n} Überschneidungen')}</button>
        )}
        {data.untimed.length > 0 && (
          <button type="button" className="cal-untimed" aria-expanded={showUntimed} onClick={() => setShowUntimed((v) => !v)}>{tn(data.untimed.length, '{n} Eintrag ohne Zeitraum', '{n} Einträge ohne Zeitraum')}</button>
        )}
        {hasFilters && <button type="button" className={`cal-filtertoggle${filtering ? ' on' : ''}`} aria-expanded={showFilters} onClick={() => setShowFilters((v) => !v)}>{t('Filter')}{filtering && ' •'}</button>}
      </div>
      {showUntimed && data.untimed.length > 0 && (
        <div className="cal-untimed-list">
          {data.untimed.slice(0, 100).map((u) => <button type="button" key={u.id} onClick={() => props.onOpenRecord(data.source.id, u.id, describeUntimed(u))}>{u.title || t('Ohne Titel')}</button>)}
          {data.untimed.length > 100 && <span className="hint">…</span>}
        </div>
      )}
      {hasFilters && (
        <div className={`cal-filters${showFilters ? ' open' : ''}`}>
          {data.laneFilters.map(({ col, choices }) => (
            <span key={col.id} className="cal-chips" role="group" aria-label={col.name}>
              <small>{col.name}</small>
              {choices.map((c) => {
                const chosen = filter.laneValues[col.id] ?? []
                return chip(c.value, chosen.includes(c.value), () => setFilter({ laneValues: { ...filter.laneValues, [col.id]: toggle(chosen, c.value) } }), c.label, c.option)
              })}
            </span>
          ))}
          <span className="cal-filtergroup">
            {data.colors.length > 0 && (
              <span className="cal-chips" role="group" aria-label={t('Farbe')}>
                {data.colors.map((o) => chip(o.id, filter.colors.includes(o.id), () => setFilter({ colors: toggle(filter.colors, o.id) }), o.name, o))}
              </span>
            )}
            {data.entries.some((e) => e.free) && (
              <label className="check"><input type="checkbox" checked={filter.showFree} onChange={(e) => setFilter({ showFree: e.target.checked })} /> {t('Auch zeigen, was nicht belegt')}</label>
            )}
            {filtering && <button type="button" className="cal-reset" onClick={() => setFilter({ ...NO_FILTER, query: filter.query, collapsed: filter.collapsed })}>{t('Filter zurücksetzen')}</button>}
          </span>
        </div>
      )}

      <div className="cal-scroll" ref={scroller} onScroll={onScroll}>
        <div className="cal-canvas" style={{ width: laneWidth + width }}>
          <div className="cal-head">
            <div className="cal-corner" style={{ width: laneWidth }}>{data.laneTable.name}</div>
            <div className="cal-axis" style={{ width }}>
              {coarse.map((p) => (
                <div key={p.from} className="cal-period" style={{ left: x(p.from), width: (p.to - p.from) * perMinute }}>
                  <span style={{ left: laneWidth + 8 }}>{periodLabel(scale, p.from)}</span>
                </div>
              ))}
              {fine.map((k) => (
                <div key={k.from} className={`cal-tick${k.major ? ' major' : ''}${k.weekend ? ' weekend' : ''}${now >= k.from && now < k.to ? ' today' : ''}`} style={{ left: x(k.from), width: (k.to - k.from) * perMinute }}>{tickLabel(scale, k.from)}</div>
              ))}
            </div>
          </div>
          <div className="cal-body" style={{ height: total }}>
            <div className="cal-lines" style={{ left: laneWidth, width }} aria-hidden>
              {fine.map((k) => <div key={k.from} className={`cal-line${k.major ? ' major' : ''}${k.weekend ? ' weekend' : ''}`} style={{ left: x(k.from), width: (k.to - k.from) * perMinute }} />)}
              {now >= from && now < to && <div className="cal-now" style={{ left: x(now) }} />}
            </div>
            {rows.map((row, i) => {
              // Die Ausgangszeile eines gezogenen Balkens bleibt gezeichnet, auch wenn sie aus dem Bild rückt
              if ((i < range.start || i >= range.end) && row.key !== moving?.sourceKey) return null
              const top = offsets[i], height = heightOf(row)
              if (row.type === 'group') {
                return (
                  <div key={row.key} className="cal-group" style={{ top, height }}>
                    <button type="button" aria-expanded={!row.collapsed} onClick={() => setFilter({ collapsed: toggle(filter.collapsed, row.id) })}>
                      <span className="cal-caret">{row.collapsed ? '▸' : '▾'}</span>
                      {row.option ? <Pill option={row.option} /> : <strong>{row.name}</strong>}
                      <small>{row.count}</small>
                    </button>
                  </div>
                )
              }
              return (
                <div key={row.key} className={`cal-lane${canDrag ? ' drawable' : ''}${flash === row.key ? ' flash' : ''}`} data-lane={row.lane?.id ?? ''} style={{ top, height }}
                  onPointerDown={(e) => startDrag(e, row)} onContextMenu={canDrag ? (e) => e.preventDefault() : undefined}>
                  <div className="cal-lanehead" style={{ width: laneWidth }}>
                    {row.lane
                      ? <button type="button" className={`tile clickable ${tileClasses(row.lane.repr)}`} title={[row.lane.repr.title, ...row.lane.repr.subs].join('\n')} onClick={() => props.onOpenRecord(data.laneTable.id, row.lane!.id)}>
                          <TileContent repr={{ ...row.lane.repr, hideTitle: false }} />
                        </button>
                      : <span className="hint">{t('Ohne Zuordnung')}</span>}
                  </div>
                  {row.bars.map((b) => bar(b, row.lane?.id ?? ''))}
                  {moving && (row.lane ? moving.lanes.includes(row.lane.id) : moving.lanes.length === 0) && (
                    <div className={`cal-select${!moving.free && row.lane && overlapping(data, row.lane.id, moving, moving.id).length ? ' clash' : ''}`} style={{ left: laneWidth + x(moving.from), width: Math.max(MIN_BAR, (moving.to - moving.from) * perMinute) }}>
                      <span>{rangeText(moving)}</span>
                    </div>
                  )}
                  {selection?.key === row.key && (
                    <div className={`cal-select${row.lane && overlapping(data, row.lane.id, { ...selection, kind: 'span' }).length ? ' clash' : ''}`} style={{ left: laneWidth + x(selection.from), width: Math.max(2, (selection.to - selection.from) * perMinute) }}>
                      <span>{rangeText({ ...selection, kind: 'span' })}</span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
        {data.lanes.length === 0 && rows.length === 0 && <p className="cal-empty hint">{t('„{name}“ hat noch keine Zeilen.', { name: data.laneTable.name })}</p>}
        {data.lanes.length > 0 && !rows.some((r) => r.type === 'group' || r.lane) && <p className="cal-empty hint">{filter.query.trim() ? t('Die Suche findet nichts.') : t('Keine Zeile passt zum Filter.')}</p>}
      </div>

      {menu && <ItemMenu x={menu.x} y={menu.y} label={t('Löschen …')} onRemove={() => props.onDeleteEntry(data.source.id, menu.id, menu.entry)} onClose={() => setMenu(null)} />}

      {props.footer && createPortal(
        <>
          {props.canAdd(data.source) && <button type="button" className="add-row" onClick={() => props.onNew({ tableId: data.source.id, values: {}, relations: {} })}>{t('+ Eintrag')}</button>}
          <span className="rowsearch">
            <input ref={searchRef} type="search" placeholder={t('Suchen …')} aria-label={t('Kalender durchsuchen')} value={filter.query}
              onChange={(e) => setFilter({ query: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Escape') { setFilter({ query: '' }); e.currentTarget.blur() } }} />
            {!!filter.query.trim() && <small>{t('{shown} von {total}', { shown: shownLanes(rows, !!data.groups), total: data.lanes.length })}</small>}
          </span>
        </>,
        props.footer,
      )}
    </div>
  )
}
