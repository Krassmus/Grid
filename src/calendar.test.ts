import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { changedValues, movedLanes, DAY, HOUR, dayWidth, dragRange, dragStep, dragValues, intervalOf, isoWeek, leftFor, momentText, page, parseMoment, periods, stack, ticks, weekStart } from './calendar'
import { NO_FILTER, calendarData, calendarRows, clashes, overlapWarnings, overlapping, shownLanes, type CalendarData, type CalendarFilter, type Row } from './calendarData'
import { computeRepr } from './repr'
import { addBookingCalendar, addCalendar, addColumn, addLink, addRow, addTable, deleteCalendar, deleteColumn, readCalendars, readTables, readTabs, setCell, updateCalendar, type CalendarDef } from './model'
import { createUndoManager } from './undo'

const at = (s: string) => parseMoment(s)!.min

describe('Zeiträume', () => {
  it('reine Datumsangaben zählen den letzten Tag mit', () => {
    expect(intervalOf('2026-12-03', '2026-12-05')).toEqual({ from: at('2026-12-03'), to: at('2026-12-06'), kind: 'span' })
    expect(intervalOf('2026-12-03', '2026-12-03')).toMatchObject({ to: at('2026-12-04'), kind: 'span' })
  })

  it('mit Uhrzeit zählt das Ende nicht mit; gemischt meint ein Datum den ganzen Tag', () => {
    expect(intervalOf('2026-12-03T14:00', '2026-12-03T16:00')).toEqual({ from: at('2026-12-03T14:00'), to: at('2026-12-03T16:00'), kind: 'span' })
    expect(intervalOf('2026-12-03T14:00', '2026-12-03')).toMatchObject({ to: at('2026-12-04'), kind: 'span' })
    expect(intervalOf('2026-12-03', '2026-12-04T10:00')).toMatchObject({ from: at('2026-12-03'), to: at('2026-12-04T10:00') })
  })

  it('ohne Ende: ein ganzer Tag bzw. eine Marke; ohne Beginn nichts', () => {
    expect(intervalOf('2026-12-03', null)).toMatchObject({ to: at('2026-12-04'), kind: 'span' })
    expect(intervalOf('2026-12-03T14:00', '')).toMatchObject({ to: at('2026-12-03T14:00'), kind: 'mark' })
    expect(intervalOf('2026-12-03T14:00', '2026-12-03T14:00')).toMatchObject({ kind: 'mark' })
    expect(intervalOf(null, '2026-12-03')).toBeNull()
    expect(intervalOf('irgendwann', '2026-12-03')).toBeNull()
  })

  it('Ende vor dem Beginn wird als verdreht erkannt', () => {
    expect(intervalOf('2026-12-03', '2026-12-02')).toMatchObject({ kind: 'reversed', from: at('2026-12-03'), to: at('2026-12-03') })
    expect(intervalOf('2026-12-03T14:00', '2026-12-03T13:00')).toMatchObject({ kind: 'reversed' })
    expect(intervalOf('2026-12-03T14:00', '2026-12-02')).toMatchObject({ kind: 'reversed' })
  })

  it('Werte lassen sich zurückschreiben, auch über die Sommerzeitumstellung', () => {
    expect(momentText(at('2026-03-29') + DAY)).toBe('2026-03-30')
    expect(momentText(at('2026-10-25T02:30'), true)).toBe('2026-10-25T02:30')
    expect(at('2026-03-30') - at('2026-03-29')).toBe(DAY)
  })
})

describe('Stapeln', () => {
  const box = (from: number, to: number) => ({ from, to })
  it('nur Überlappendes kommt untereinander; Anschließendes nicht', () => {
    const [a, b, c, d] = [box(0, 10), box(10, 20), box(5, 12), box(12, 14)]
    const s = stack([d, c, b, a])
    expect(s.rows).toBe(2)
    expect([a, b, c, d].map((x) => s.row.get(x))).toEqual([0, 0, 1, 1])
  })
  it('die Mindestlänge hält kurze Einträge auseinander', () => {
    expect(stack([box(0, 0), box(1, 1)]).rows).toBe(1)
    expect(stack([box(0, 0), box(1, 1)], 5).rows).toBe(2)
    expect(stack([]).rows).toBe(0)
  })
})

describe('Neuer Eintrag durch Ziehen', () => {
  const values = (a: string, b: string, step: number) => dragValues(dragRange(at(a), at(b), step), step)

  it('ganze Tage: jeder berührte Tag zählt, in beide Richtungen', () => {
    const expected = { start: '2026-12-03', end: '2026-12-05' }
    expect(values('2026-12-03T18:00', '2026-12-05T02:00', DAY)).toEqual(expected)
    expect(values('2026-12-05T02:00', '2026-12-03T18:00', DAY)).toEqual(expected)
    expect(values('2026-12-03T10:00', '2026-12-03T11:00', DAY)).toEqual({ start: '2026-12-03', end: '2026-12-03' })
  })

  it('Uhrzeiten rasten ein, in beide Richtungen, mindestens ein Raster lang', () => {
    const quarter = HOUR / 4
    expect(values('2026-12-03T14:04', '2026-12-03T15:57', quarter)).toEqual({ start: '2026-12-03T14:00', end: '2026-12-03T16:00' })
    expect(values('2026-12-03T15:57', '2026-12-03T14:04', quarter)).toEqual({ start: '2026-12-03T14:00', end: '2026-12-03T16:00' })
    expect(values('2026-12-03T14:05', '2026-12-03T14:06', quarter)).toEqual({ start: '2026-12-03T14:00', end: '2026-12-03T14:15' })
    expect(values('2026-12-03T23:00', '2026-12-04T00:02', quarter)).toEqual({ start: '2026-12-03T23:00', end: '2026-12-04T00:00' })
  })

  it('das Raster richtet sich nach Maßstab und Spalten', () => {
    expect([dragStep('day', true), dragStep('week', true), dragStep('month', true), dragStep('day', false)]).toEqual([15, 60, DAY, DAY])
  })

  it('der gezogene Zeitraum ergibt wieder denselben Balken', () => {
    for (const step of [DAY, HOUR]) {
      const r = dragRange(at('2026-12-03T08:00'), at('2026-12-04T17:00'), step)
      const v = dragValues(r, step)
      expect(intervalOf(v.start, v.end)).toMatchObject(r)
    }
  })
})

describe('Verschieben und Dauer ändern', () => {
  const days = { start: '2026-12-03', end: '2026-12-05' }
  const hours = { start: '2026-12-03T14:10', end: '2026-12-03T16:10' }
  const quarter = HOUR / 4

  it('verschieben behält die Dauer; ganze Tage wandern nur um ganze Tage', () => {
    expect(changedValues('move', days, 2 * DAY + 3 * HOUR, DAY)).toEqual({ start: '2026-12-05', end: '2026-12-07' })
    expect(changedValues('move', days, -DAY, quarter)).toEqual({ start: '2026-12-02', end: '2026-12-04' })
    expect(changedValues('move', days, 5 * HOUR, quarter)).toBe(days) // weniger als ein halber Tag: nichts
  })

  it('Uhrzeiten wandern im Raster, krumme Zeiten bleiben krumm; im Monat nur um ganze Tage', () => {
    expect(changedValues('move', hours, 50, quarter)).toEqual({ start: '2026-12-03T14:55', end: '2026-12-03T16:55' })
    expect(changedValues('move', hours, DAY + HOUR, DAY)).toEqual({ start: '2026-12-04T14:10', end: '2026-12-04T16:10' })
    expect(changedValues('move', { start: '2026-12-03T14:00', end: '2026-12-05' }, 3 * HOUR, quarter).start).toBe('2026-12-03T14:00') // gemischt: ganze Tage
  })

  it('am Ende ziehen verlängert und verkürzt, aber nie unter einen Tag oder ein Raster', () => {
    expect(changedValues('end', days, 2 * DAY, DAY)).toEqual({ start: '2026-12-03', end: '2026-12-07' })
    expect(changedValues('end', days, -9 * DAY, DAY)).toEqual({ start: '2026-12-03', end: '2026-12-03' })
    expect(changedValues('end', hours, -5 * HOUR, quarter)).toEqual({ start: '2026-12-03T14:10', end: '2026-12-03T14:25' })
    expect(changedValues('end', { start: '2026-12-03', end: '' }, 2 * DAY, DAY)).toEqual({ start: '2026-12-03', end: '2026-12-05' })
  })

  it('am Anfang ziehen lässt das Ende stehen', () => {
    expect(changedValues('start', days, -2 * DAY, DAY)).toEqual({ start: '2026-12-01', end: '2026-12-05' })
    expect(changedValues('start', days, 9 * DAY, DAY)).toEqual({ start: '2026-12-05', end: '2026-12-05' })
    expect(changedValues('start', hours, 9 * HOUR, quarter)).toEqual({ start: '2026-12-03T15:55', end: '2026-12-03T16:10' })
    // ohne Ende: der bisherige Tag wird zum Ende, sonst wanderte der ganze Eintrag
    expect(changedValues('start', { start: '2026-12-03', end: '' }, -DAY, DAY)).toEqual({ start: '2026-12-02', end: '2026-12-03' })
    expect(changedValues('start', { start: '2026-12-03', end: '' }, 0, DAY)).toEqual({ start: '2026-12-03', end: '' })
  })

  it('das Ergebnis ist immer ein gültiger Zeitraum', () => {
    for (const mode of ['move', 'start', 'end'] as const) for (const delta of [-40 * DAY, -HOUR, 0, HOUR, 40 * DAY]) for (const v of [days, hours]) {
      const r = changedValues(mode, v, delta, quarter)
      expect(intervalOf(r.start, r.end)?.kind, `${mode} ${delta}`).toBe('span')
    }
  })

  it('die Zeile wechselt, weitere Zeilen bleiben', () => {
    expect(movedLanes(['a'], 'a', 'b')).toEqual(['b'])
    expect(movedLanes(['a', 'c'], 'a', 'b')).toEqual(['c', 'b'])
    expect(movedLanes(['a', 'c'], 'a', 'c')).toEqual(['a', 'c'])
    expect(movedLanes(['a'], 'a', 'a')).toEqual(['a'])
    expect(movedLanes(['a'], 'a', '')).toEqual([])
    expect(movedLanes([], '', 'b')).toEqual(['b'])
  })
})

describe('Zeitachse', () => {
  it('Woche beginnt am Montag, Kalenderwochen nach ISO', () => {
    expect(momentText(weekStart(at('2026-12-06T23:00')))).toBe('2026-11-30')
    expect(isoWeek(at('2026-01-01'))).toBe(1)
    expect(isoWeek(at('2026-12-31'))).toBe(53)
    expect(isoWeek(at('2027-01-03'))).toBe(53)
    expect(isoWeek(at('2027-01-04'))).toBe(1)
  })
  it('Blättern in Monaten bleibt am Monatsende im Monat', () => {
    expect(momentText(page('month', at('2027-01-31'), 1))).toBe('2027-02-28')
    expect(momentText(page('quarter', at('2026-11-30'), 1))).toBe('2027-02-28')
    expect(momentText(page('week', at('2026-12-03'), -1))).toBe('2026-11-26')
  })
  it('Heute steht gut sichtbar; Einteilung und obere Zeile decken den Bereich ab', () => {
    expect(momentText(leftFor('week', at('2026-12-03')))).toBe('2026-11-30')
    expect(momentText(leftFor('day', at('2026-12-03T14:20'), true), true)).toBe('2026-12-03T12:00')
    expect(ticks('week', at('2026-11-30'), at('2026-12-07'))).toHaveLength(7)
    expect(ticks('day', at('2026-11-30'), at('2026-12-01'))).toHaveLength(24)
    expect(ticks('week', at('2026-11-30'), at('2026-12-07')).filter((x) => x.weekend)).toHaveLength(2)
    expect(periods('month', at('2026-11-15'), at('2027-01-02')).map((p) => momentText(p.from))).toEqual(['2026-11-01', '2026-12-01', '2027-01-01'])
    expect(dayWidth('week', 1400)).toBe(200)
    expect(dayWidth('week', 300)).toBe(96)
    expect(ticks('day', 0, 2 * HOUR)[0].major).toBe(true)
  })
})

/** Belegungsplan: Objekte (mit Kategorie), Personen, Buchungen */
function plan() {
  const doc = new Y.Doc()
  const objects = addTable(doc, 'Objekte', { firstRow: false }), people = addTable(doc, 'Personen', { firstRow: false }), bookings = addTable(doc, 'Buchungen', { firstRow: false })
  const nameCol = (id: string) => readTables(doc).find((t) => t.id === id)!.columns[0].id
  const category = addColumn(doc, objects, 'Kategorie', 'select', undefined, ['Zelte', 'Technik'])
  const object = addColumn(doc, bookings, 'Objekt', 'relation', objects, [], { multiTarget: true })
  const person = addColumn(doc, bookings, 'Person', 'relation', people, [], { multiTarget: true })
  const from = addColumn(doc, bookings, 'Von', 'date'), until = addColumn(doc, bookings, 'Bis', 'date')
  const status = addColumn(doc, bookings, 'Status', 'select', undefined, ['bestätigt', 'storniert'])
  const opts = (t: string, c: string) => readTables(doc).find((x) => x.id === t)!.columns.find((x) => x.id === c)!.options!
  const [tents, tech] = opts(objects, category), [ok, cancelled] = opts(bookings, status)
  const row = (t: string, name: string, values: Record<string, string> = {}) => {
    const r = addRow(doc, t); setCell(doc, t, r, nameCol(t), name)
    for (const [c, v] of Object.entries(values)) setCell(doc, t, r, c, v)
    return r
  }
  const beamer = row(objects, 'Beamer', { [category]: tech.id }), jurte = row(objects, 'Jurte', { [category]: tents.id }), spare = row(objects, 'Kiste')
  const kim = row(people, 'Kim'), alex = row(people, 'Alex')
  const book = (title: string, a: string | null, b: string | null, targets: string[], who?: string, state = ok.id) => {
    const r = row(bookings, title, { [status]: state, ...(a ? { [from]: a } : {}), ...(b ? { [until]: b } : {}) })
    for (const x of targets) addLink(doc, bookings, r, object, x)
    if (who) addLink(doc, bookings, r, person, who)
    return r
  }
  const def: CalendarDef = {
    layers: [{ table: bookings, start: from, end: until, lane: object, label: person, color: status, free: { col: status, values: [cancelled.id] } }],
    groupBy: category, filters: [category],
  }
  const b1 = book('A', '2026-12-01', '2026-12-03', [beamer, jurte], kim)
  const b2 = book('B', '2026-12-02', '2026-12-04', [beamer], alex)
  const b3 = book('C', '2026-12-02', '2026-12-04', [jurte], alex, cancelled.id)
  const b4 = book('D', null, '2026-12-04', [jurte])
  const b5 = book('E', '2026-12-10', null, [])
  const data = (readable: (table: string, col: string) => boolean = () => true, visible?: string[]) => {
    const all = readTables(doc)
    return calendarData(doc, visible ? all.filter((t) => visible.includes(t.id)) : all, def, (t, c) => readable(t.id, c.id), all)
  }
  return { doc, def, data, ids: { objects, people, bookings, category, object, person, from, until, status, beamer, jurte, spare, b1, b2, b3, b4, b5 }, tents, tech, ok, cancelled }
}

const lanesOf = (rows: Row[]) => rows.map((r) => (r.type === 'group' ? `# ${r.name} (${r.count})` : `${r.lane?.repr.title ?? 'ohne'}: ${r.bars.map((b) => `${b.entry.label}${b.dim ? '~' : ''}${b.row ? `↓${b.row}` : ''}`).join(', ')}`))
const filter = (patch: Partial<CalendarFilter>): CalendarFilter => ({ ...NO_FILTER, ...patch })

describe('Inhalt eines Kalenders', () => {
  it('Zeilen sind alle Objekte, auch freie; Einträge ohne Zeitraum werden gezählt', () => {
    const { data, ids } = plan()
    const d = data() as CalendarData
    expect(d.lanes.map((l) => l.repr.title)).toEqual(['Beamer', 'Jurte', 'Kiste'])
    expect(d.entries.map((e) => [e.id, e.label, e.free])).toEqual([[ids.b1, 'Kim', false], [ids.b2, 'Alex', false], [ids.b3, 'Alex', true], [ids.b5, 'Belegt', false]])
    expect(d.untimed).toHaveLength(1)
    expect(d.timed).toBe(false)
  })

  it('gruppiert nach Auswahlspalte, stapelt Überlappendes und zeigt Einträge in jeder ihrer Zeilen', () => {
    const { data } = plan()
    expect(lanesOf(calendarRows(data() as CalendarData, NO_FILTER))).toEqual([
      '# Zelte (1)', 'Jurte: Kim', '# Technik (1)', 'Beamer: Kim, Alex↓1', '# Ohne Angabe (1)', 'Kiste: ', 'ohne: Belegt',
    ])
  })

  it('Zeilenfilter lassen Unpassendes verschwinden, auch „Ohne Zuordnung“', () => {
    const { data, tech, ids } = plan()
    const d = data() as CalendarData
    expect(lanesOf(calendarRows(d, filter({ laneValues: { [ids.category]: [tech.id] } })))).toEqual(['# Technik (1)', 'Beamer: Kim, Alex↓1'])
    expect(lanesOf(calendarRows(d, filter({ query: 'jur' })))).toEqual(['# Zelte (1)', 'Jurte: Kim'])
  })

  it('eine Suche findet Zeilen und Einträge: gefundene Zeilen bleiben, nicht Gefundenes wird nur abgeblasst', () => {
    const { data } = plan()
    const d = data() as CalendarData
    // „kim“ steht an Einträgen in beiden Zeilen; der andere Eintrag beim Beamer belegt weiter
    expect(lanesOf(calendarRows(d, filter({ query: 'kim' })))).toEqual(['# Zelte (1)', 'Jurte: Kim', '# Technik (1)', 'Beamer: Kim, Alex~↓1'])
    expect(lanesOf(calendarRows(d, filter({ query: 'alex' })))).toEqual(['# Technik (1)', 'Beamer: Kim~, Alex↓1'])
    // die Zeile selbst gefunden: alles darin erscheint normal
    expect(lanesOf(calendarRows(d, filter({ query: 'BEAM' })))).toEqual(['# Technik (1)', 'Beamer: Kim, Alex↓1'])
    expect(lanesOf(calendarRows(d, filter({ query: 'niemand' })))).toEqual([])
    expect(lanesOf(calendarRows(d, filter({ query: 'belegt' })))).toEqual(['ohne: Belegt'])
    // was nicht belegt, zählt nur, wenn es gezeigt wird
    expect(lanesOf(calendarRows(d, filter({ query: 'alex', showFree: true })))).toEqual(['# Zelte (1)', 'Jurte: Kim~, Alex↓1', '# Technik (1)', 'Beamer: Kim~, Alex↓1'])
    expect(shownLanes(calendarRows(d, filter({ query: 'kim' })), true)).toBe(2)
  })

  it('Balkenfilter blassen Belegtes nur ab; was nicht belegt, erscheint nur auf Wunsch', () => {
    const { data, tents, cancelled, ok } = plan()
    const d = data() as CalendarData
    const jurte = (f: Partial<CalendarFilter>) => lanesOf(calendarRows(d, filter(f))).find((x) => x.startsWith('Jurte'))
    expect(jurte({ showFree: true })).toBe('Jurte: Kim, Alex↓1')
    expect(jurte({ showFree: true, colors: [cancelled.id] })).toBe('Jurte: Kim~, Alex↓1')
    expect(jurte({ colors: [cancelled.id] })).toBe('Jurte: Kim~') // belegt: bleibt sichtbar
    expect(jurte({ colors: ['gibt-es-nicht'] })).toBe('Jurte: Kim')
    expect(jurte({ colors: [ok.id] })).toBe('Jurte: Kim')
    expect(lanesOf(calendarRows(d, filter({ collapsed: [tents.id] })))[1]).toBe('# Technik (1)')
  })

  it('ohne Leserecht an der Beschriftung steht „Belegt“ da, und kein Name verrät sich', () => {
    const { data, ids } = plan()
    const d = data((_t, c) => c !== ids.person) as CalendarData
    expect(d.entries.filter((e) => !e.free).map((e) => e.label)).toEqual(['Belegt', 'Belegt', 'Belegt'])
    expect(d.entries.find((e) => e.id === ids.b3)!.label).toBe('')
    expect(d.untimed[0].title).toBe('Belegt')
    expect(d.entries.every((e) => !e.avatar)).toBe(true)
  })

  it('ohne Leserecht an „belegt nicht“ belegt alles', () => {
    const { data, ids } = plan()
    const d = data((_t, c) => c !== ids.status) as CalendarData
    expect(d.entries.every((e) => !e.free)).toBe(true)
    expect(d.colors).toEqual([])
  })

  it('ohne Zugriff auf Nötiges zeigt er nichts', () => {
    const { data, ids } = plan()
    for (const col of [ids.from, ids.until, ids.object]) expect(data((_t, c) => c !== col)).toEqual({ problem: 'rights' })
    expect(data(undefined, [ids.bookings, ids.people])).toEqual({ problem: 'rights' })
    expect(data(undefined, [ids.objects])).toEqual({ problem: 'rights' })
  })

  it('eine gelöschte nötige Spalte macht ihn unvollständig, statt Belegtes frei zu zeigen', () => {
    const { doc, data, ids } = plan()
    deleteColumn(doc, ids.bookings, ids.until)
    expect(data()).toEqual({ problem: 'incomplete' })
  })
})

describe('Überschneidungen', () => {
  const today = at('2026-11-28')

  it('zählt je Zeile, was sich überschneidet; was nicht belegt und „Ohne Zuordnung“ zählen nicht', () => {
    const { data, ids } = plan()
    const d = data() as CalendarData
    const c = clashes(d, today)
    // Beamer: A (1.–3.) und B (2.–4.). Bei der Jurte überschneidet A nur die stornierte C
    expect(c.upcoming).toEqual([{ lane: ids.beamer, at: at('2026-12-02'), ids: [ids.b1, ids.b2] }])
    expect([...c.marked].sort()).toEqual([`${ids.beamer}|${ids.b1}`, `${ids.beamer}|${ids.b2}`].sort())
  })

  it('Vergangenes bleibt markiert, zählt aber nicht mehr', () => {
    const { data } = plan()
    const c = clashes(data() as CalendarData, at('2026-12-05'))
    expect(c.upcoming).toEqual([])
    expect(c.marked.size).toBe(2)
    expect(clashes(data() as CalendarData, at('2026-12-03')).upcoming).toHaveLength(1) // am letzten doppelten Tag noch
  })

  const make = (spans: [string, string][]) => {
    const { doc, def, ids } = plan()
    const entries = spans.map(([a, b]) => {
      const r = addRow(doc, ids.bookings)
      setCell(doc, ids.bookings, r, ids.from, a); setCell(doc, ids.bookings, r, ids.until, b)
      addLink(doc, ids.bookings, r, ids.object, ids.spare)
      return r
    })
    const d = calendarData(doc, readTables(doc), def, () => true) as CalendarData
    return { d, ids, entries }
  }
  const inSpare = (d: CalendarData, lane: string, when: string) => clashes(d, at(when)).upcoming.filter((x) => x.lane === lane)

  it('eine Kette zählt einmal, Anschließendes nicht; ein langer Eintrag verbindet mehrere', () => {
    const chain = make([['2027-01-01', '2027-01-05'], ['2027-01-04', '2027-01-08'], ['2027-01-07', '2027-01-09'], ['2027-01-10', '2027-01-12'], ['2027-02-01', '2027-02-20'], ['2027-02-02', '2027-02-03'], ['2027-02-10', '2027-02-11']])
    const found = inSpare(chain.d, chain.ids.spare, '2026-11-28')
    expect(found.map((x) => [momentText(x.at), x.ids.length])).toEqual([['2027-01-04', 3], ['2027-02-02', 3]])
    // ist der Anfang einer Kette vorbei, führt der Sprung zum noch kommenden Teil
    expect(inSpare(chain.d, chain.ids.spare, '2027-01-06').map((x) => momentText(x.at))[0]).toBe('2027-01-07')
  })

  it('mit Uhrzeit: 14–16 und 16–18 Uhr überschneiden sich nicht', () => {
    const touch = make([['2027-01-01T14:00', '2027-01-01T16:00'], ['2027-01-01T16:00', '2027-01-01T18:00']])
    expect(inSpare(touch.d, touch.ids.spare, '2026-11-28')).toEqual([])
    expect(overlapping(touch.d, touch.ids.spare, intervalOf('2027-01-01T15:00', '2027-01-01T17:00')!)).toHaveLength(2)
    expect(overlapping(touch.d, touch.ids.spare, intervalOf('2027-01-01T15:00', '')!)).toEqual([]) // eine Marke belegt nichts
  })

  it('das Formular nennt, womit sich ein Eintrag überschneidet', () => {
    const { data, ids, cancelled } = plan()
    const d = data() as CalendarData
    const values = { [ids.from]: '2026-12-03', [ids.until]: '2026-12-05' }
    expect(overlapWarnings(d, values, { [ids.object]: [ids.beamer, ids.spare] })).toEqual([
      '„Beamer“ ist in dieser Zeit schon belegt: Kim, 01.12.2026 – 03.12.2026; Alex, 02.12.2026 – 04.12.2026',
    ])
    expect(overlapWarnings(d, values, { [ids.object]: [ids.beamer] }, ids.b1)[0]).not.toContain('Kim') // sich selbst zählt er nicht
    expect(overlapWarnings(d, { ...values, [ids.status]: cancelled.id }, { [ids.object]: [ids.beamer] })).toEqual([])
    expect(overlapWarnings(d, { [ids.until]: '2026-12-05' }, { [ids.object]: [ids.beamer] })).toEqual([])
    expect(overlapWarnings(d, values, {})).toEqual([])
  })

  it('die Warnung verrät ohne Leserecht keinen Namen und nennt höchstens drei', () => {
    const { data, ids } = plan()
    const hidden = data((_t, c) => c !== ids.person) as CalendarData
    expect(overlapWarnings(hidden, { [ids.from]: '2026-12-02' }, { [ids.object]: [ids.beamer] })[0]).toContain('Belegt, 01.12.2026')
    const many = make(Array.from({ length: 5 }, () => ['2027-01-01', '2027-01-02'] as [string, string]))
    expect(overlapWarnings(many.d, { [many.ids.from]: '2027-01-01' }, { [many.ids.object]: [many.ids.spare] })[0]).toMatch(/; 2 weitere$/)
  })
})

describe('Kalender samt Buchungstabelle anlegen', () => {
  const setup = (who: 'none' | 'text' | 'table', time = false) => {
    const doc = new Y.Doc()
    const objects = addTable(doc, 'Zelte', { firstRow: false }), people = addTable(doc, 'Personen', { firstRow: false })
    const id = addBookingCalendar(doc, 'Belegung', 'calendar', { tableName: 'Buchungen', objects, who: who === 'table' ? { kind: 'table', table: people } : { kind: who }, time })
    const def = readCalendars(doc).find((c) => c.id === id)!.def
    const table = readTables(doc).find((x) => x.id === def.ownTable)!
    const col = (colId?: string) => table.columns.find((c) => c.id === colId)
    return { doc, id, def, table, col, layer: def.layers[0], objects, people }
  }

  it('mit Verknüpfung zu Personen: Objekt, Person, Von, Bis, Notiz', () => {
    const { table, col, layer, objects, people } = setup('table')
    expect(table.columns.map((c) => [c.name, c.type])).toEqual([['Zelte', 'relation'], ['Personen', 'relation'], ['Von', 'date'], ['Bis', 'date'], ['Notiz', 'text']])
    expect(col(layer.lane)).toMatchObject({ target: objects, config: { multiTarget: true, backlink: false, single: false } })
    expect(col(layer.label)).toMatchObject({ target: people, config: { multiTarget: true, backlink: false, single: true } })
    expect([col(layer.start)?.name, col(layer.end)?.name]).toEqual(['Von', 'Bis'])
    expect(col(layer.start)?.config?.time).toBeFalsy()
  })

  it('mit Namen als Text oder ganz ohne Person', () => {
    const text = setup('text', true)
    expect(text.table.columns.map((c) => c.name)).toEqual(['Zelte', 'Name', 'Von', 'Bis'])
    expect(text.col(text.layer.label)?.name).toBe('Name')
    expect(text.col(text.layer.start)?.config).toMatchObject({ time: true })
    const none = setup('none')
    expect(none.table.columns.map((c) => c.name)).toEqual(['Zelte', 'Von', 'Bis', 'Notiz'])
  })

  it('ein Eintrag ohne Namen oder Notiz zeigt „Belegt“, und das Datum wird nie zum Titel', () => {
    for (const who of ['none', 'text'] as const) {
      const { doc, def, layer, objects } = setup(who)
      const tent = addRow(doc, objects), booking = addRow(doc, def.ownTable!)
      setCell(doc, def.ownTable!, booking, layer.start, '2026-12-03')
      addLink(doc, def.ownTable!, booking, layer.lane, tent)
      const data = calendarData(doc, readTables(doc), def, () => true) as CalendarData
      expect(data.entries.map((e) => e.label)).toEqual(['Belegt'])
    }
    const { doc, def, layer } = setup('table')
    const booking = addRow(doc, def.ownTable!)
    setCell(doc, def.ownTable!, booking, layer.start, '2026-12-03')
    const table = readTables(doc).find((x) => x.id === def.ownTable)!
    expect(computeRepr(doc, readTables(doc), table).get(booking)!.title).toBe('Ohne Titel')
  })

  it('alles entsteht in einem Schritt: einmal Rückgängig entfernt Tabelle und Kalender', () => {
    const doc = new Y.Doc()
    const objects = addTable(doc, 'Zelte')
    const undo = createUndoManager(doc)
    addBookingCalendar(doc, 'K', '', { tableName: 'Buchungen', objects, who: { kind: 'none' }, time: false })
    undo.undo()
    expect(readTabs(doc).map((x) => x.name)).toEqual(['Zelte'])
  })

  it('die eigene Tabelle gilt nur, solange der Kalender aus ihr liest', () => {
    const { doc, id, def } = setup('none')
    updateCalendar(doc, id, { def: { ...def, layers: [{ ...def.layers[0], table: 'andere' }] } })
    expect(readCalendars(doc)[0].def.ownTable).toBeUndefined()
  })
})

describe('Kalender im Dokument', () => {
  it('anlegen, ändern, löschen; steht bei den Reitern und lässt sich rückgängig machen', () => {
    const { doc, def } = plan()
    const undo = createUndoManager(doc)
    const id = addCalendar(doc, 'Plan', def, 'calendar'); undo.stopCapturing()
    expect(readTabs(doc).at(-1)).toMatchObject({ kind: 'calendar', id, name: 'Plan' })
    expect(readCalendars(doc)[0].def.layers[0]).toMatchObject({ start: def.layers[0].start, free: def.layers[0].free })
    updateCalendar(doc, id, { name: 'Neu', def: { layers: def.layers, filters: [] } }); undo.stopCapturing()
    expect(readCalendars(doc)[0]).toMatchObject({ name: 'Neu', def: { filters: [] } })
    expect(readCalendars(doc)[0].def.groupBy).toBeUndefined()
    deleteCalendar(doc, id); undo.stopCapturing()
    expect(readCalendars(doc)).toEqual([])
    undo.undo()
    expect(readCalendars(doc)).toHaveLength(1)
  })

  it('liest auch eine kaputte Einstellung, ohne zu stolpern', () => {
    const { doc } = plan()
    addCalendar(doc, 'X', { layers: [{ table: 't', start: '', lane: 'l' }], filters: [] })
    expect(readCalendars(doc)[0].def).toEqual({ layers: [], filters: [], groupBy: undefined, ownTable: undefined })
  })
})
