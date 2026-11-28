/**
 * Rechnen für den Kalender (docs/KALENDER.md), ohne Oberfläche: Zeiträume aus Datumswerten, Zeilen der Zeitleiste,
 * Verteilen überlappender Balken auf Unterzeilen und die Zeitachse.
 *
 * Zeiten sind wie die Datumswerte „schwebend“ (ohne Zeitzone). Gerechnet wird in Minuten, als wäre alles UTC:
 * so gibt es keine Sprünge durch die Sommerzeit.
 */
export const HOUR = 60
export const DAY = 1440

const PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/

export interface Moment { min: number; timed: boolean }

export function parseMoment(value: unknown): Moment | null {
  const m = typeof value === 'string' ? PATTERN.exec(value) : null
  if (!m) return null
  return { min: Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0)) / 60000, timed: m[4] !== undefined }
}

export const dayStart = (min: number) => Math.floor(min / DAY) * DAY

/** Der Kalendertag dieses Geräts bzw. die Uhrzeit, schwebend. */
export function nowMinutes(now = new Date()): number {
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes()) / 60000
}

const pad = (n: number) => String(n).padStart(2, '0')
/** `2026-12-03` bzw. mit Uhrzeit `2026-12-03T14:00` */
export function momentText(min: number, timed = false): string {
  const d = new Date(min * 60000)
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  return timed ? `${day}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : day
}

/**
 * `span`: belegt die Zeit von `from` bis vor `to`. `mark`: ein Zeitpunkt ohne Dauer. `reversed`: Ende vor dem Beginn.
 * Marken haben `to === from`.
 */
export interface Interval { from: number; to: number; kind: 'span' | 'mark' | 'reversed' }

/** Zeitraum eines Eintrags; `null` ohne lesbaren Beginn. Ein Ende ohne Uhrzeit zählt den ganzen Tag mit. */
export function intervalOf(startValue: unknown, endValue: unknown): Interval | null {
  const start = parseMoment(startValue)
  if (!start) return null
  const end = parseMoment(endValue)
  const from = start.min
  if (!end) return start.timed ? { from, to: from, kind: 'mark' } : { from, to: from + DAY, kind: 'span' }
  if (end.timed ? end.min < from : end.min < dayStart(from)) return { from, to: from, kind: 'reversed' }
  const to = end.timed ? end.min : end.min + DAY
  return to > from ? { from, to, kind: 'span' } : { from, to: from, kind: 'mark' }
}

/**
 * Verteilt die Balken einer Zeile auf Unterzeilen, sodass sich nichts überdeckt. `minLength` ist die kleinste Länge,
 * mit der ein Balken gezeichnet wird (kurze Einträge und Marken brauchen auf dem Bildschirm mehr Platz als ihre Dauer).
 */
export function stack<T extends { from: number; to: number }>(items: T[], minLength = 0): { rows: number; row: Map<T, number> } {
  const sorted = [...items].sort((a, b) => a.from - b.from || a.to - b.to)
  const ends: number[] = []
  const row = new Map<T, number>()
  for (const x of sorted) {
    let i = ends.findIndex((end) => end <= x.from)
    if (i < 0) i = ends.length
    ends[i] = Math.max(x.to, x.from + minLength)
    row.set(x, i)
  }
  return { rows: ends.length, row }
}

// ---------- Neuer Eintrag durch Ziehen ----------

/**
 * Raster beim Ziehen in Minuten. Nach Uhrzeit wird nur gerastet, wenn die Datumsspalten Uhrzeiten angeben und der Maßstab
 * fein genug ist: im Tag auf Viertelstunden, in der Woche auf Stunden. Sonst auf ganze Tage.
 */
export const dragStep = (scale: Scale, timed: boolean): number => (!timed ? DAY : scale === 'day' ? HOUR / 4 : scale === 'week' ? HOUR : DAY)

/**
 * Zeitraum zwischen den Punkten, an denen das Ziehen begann und gerade steht (in beliebiger Richtung); `to` zählt nicht mit.
 * Tage: jeder berührte Tag gehört dazu. Uhrzeiten: die Ränder rasten auf den nächsten Rasterpunkt, mindestens ein Raster lang.
 */
export function dragRange(a: number, b: number, step: number): { from: number; to: number } {
  const lo = Math.min(a, b), hi = Math.max(a, b)
  if (step >= DAY) return { from: Math.floor(lo / step) * step, to: (Math.floor(hi / step) + 1) * step }
  const from = Math.round(lo / step) * step, to = Math.round(hi / step) * step
  if (to > from) return { from, to }
  const cell = Math.floor(lo / step) * step
  return { from: cell, to: cell + step }
}

/** Werte für Beginn und Ende eines so gezogenen Eintrags. Bei ganzen Tagen nennt das Ende den letzten Tag. */
export function dragValues(range: { from: number; to: number }, step: number): { start: string; end: string } {
  const timed = step < DAY
  return { start: momentText(range.from, timed), end: momentText(timed ? range.to : range.to - DAY, timed) }
}

// ---------- Eintrag verschieben und Dauer ändern ----------

/** `move`: ganz verschieben; `start`/`end`: nur Beginn bzw. Ende ziehen */
export type ChangeMode = 'move' | 'start' | 'end'
/** Die gespeicherten Werte; `''` = leer */
export interface Values { start: string; end: string }

const snapped = (delta: number, step: number) => Math.round(delta / step) * step || 0

/**
 * Neue Werte, nachdem um `delta` Minuten gezogen wurde. `timedStep` ist das Raster für Uhrzeiten (`dragStep(scale, true)`).
 * Gerastet wird die Verschiebung, nicht der Zeitpunkt: Uhrzeiten bleiben so erhalten. Reine Datumsangaben bleiben reine
 * Datumsangaben und wandern nur um ganze Tage. Beim Ziehen eines Randes bleibt mindestens ein Raster bzw. ein Tag übrig.
 * `hasEnd`: der Kalender hat eine Spalte für das Ende.
 */
export function changedValues(mode: ChangeMode, values: Values, delta: number, timedStep: number, hasEnd = true): Values {
  const s = parseMoment(values.start)
  if (!s) return values
  const e = parseMoment(values.end)
  const stepOf = (m: Moment) => (m.timed ? timedStep : DAY)
  const text = (m: Moment, by: number) => momentText(m.min + by, m.timed)
  if (mode === 'move') {
    const d = snapped(delta, s.timed && (!e || e.timed) ? timedStep : DAY)
    return d ? { start: text(s, d), end: e ? text(e, d) : values.end } : values
  }
  if (mode === 'start') {
    const step = stepOf(s)
    let to = s.min + snapped(delta, step)
    // Ohne Ende dauert ein reiner Tag genau diesen Tag: der bisherige Tag wird dann zum Ende
    const end = e ?? (hasEnd && !s.timed ? s : null)
    if (end) to = Math.min(to, end.timed ? end.min - step : s.timed ? end.min + DAY - step : end.min)
    if (to === s.min) return values
    return { start: momentText(to, s.timed), end: e ? values.end : end ? momentText(end.min, end.timed) : values.end }
  }
  const last = e ?? s
  const step = stepOf(last)
  let to = last.min + snapped(delta, step)
  to = Math.max(to, last.timed ? s.min + step : dayStart(s.min))
  return to === last.min ? values : { start: values.start, end: momentText(to, last.timed) }
}

/**
 * Zeilen eines Eintrags, nachdem er aus der Zeile `from` nach `to` gezogen wurde (`''` = „Ohne Zuordnung“). Weitere Zeilen
 * eines Eintrags bleiben. Gehört er schon in die Zielzeile, ändert sich nichts an den Zeilen.
 */
export function movedLanes(lanes: string[], from: string, to: string): string[] {
  if (from === to || lanes.includes(to)) return lanes
  const rest = lanes.filter((x) => x !== from)
  return to ? [...rest, to] : rest
}

// ---------- Zeitachse ----------

export type Scale = 'day' | 'week' | 'month' | 'quarter'
export const SCALES: Scale[] = ['day', 'week', 'month', 'quarter']

/** Je Maßstab: sichtbare Tage (bei genügend Platz), kleinste Breite eines Tages in Pixeln, gezeichnete Tage. */
const SCALE: Record<Scale, { visible: number; minDay: number; drawn: number }> = {
  day: { visible: 1, minDay: 960, drawn: 14 },
  week: { visible: 7, minDay: 96, drawn: 98 },
  month: { visible: 31, minDay: 32, drawn: 372 },
  quarter: { visible: 92, minDay: 9, drawn: 1104 },
}
export const drawnDays = (scale: Scale) => SCALE[scale].drawn
export const dayWidth = (scale: Scale, available: number) => Math.max(SCALE[scale].minDay, Math.round(available / SCALE[scale].visible))

/** Montag der Woche */
export const weekStart = (min: number) => { const d = dayStart(min); return d - ((new Date(d * 60000).getUTCDay() + 6) % 7) * DAY }

const addMonths = (min: number, n: number) => {
  const d = new Date(min * 60000)
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  return Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes()) / 60000
}

/** Eine Seite vor oder zurück */
export function page(scale: Scale, left: number, dir: 1 | -1): number {
  if (scale === 'day') return left + dir * DAY
  if (scale === 'week') return left + dir * 7 * DAY
  return addMonths(left, dir * (scale === 'month' ? 1 : 3))
}

/** Linker Rand, mit dem `at` gut sichtbar ist: Wochenanfang bzw. etwas davor */
export function leftFor(scale: Scale, at: number, timed = false): number {
  if (scale === 'day') return timed ? Math.floor(at / HOUR) * HOUR - 2 * HOUR : dayStart(at)
  if (scale === 'week') return weekStart(at)
  return dayStart(at) - (scale === 'month' ? 3 : 7) * DAY
}

export interface Tick {
  from: number
  to: number
  /** erster Tag einer Woche, eines Monats usw.: kräftigere Linie */
  major: boolean
  weekend: boolean
}

/** Feine Einteilung zwischen `from` und `to`: Stunden, Tage oder (im Quartal) Wochen. */
export function ticks(scale: Scale, from: number, to: number): Tick[] {
  const out: Tick[] = []
  const step = scale === 'day' ? HOUR : scale === 'quarter' ? 7 * DAY : DAY
  const first = scale === 'day' ? Math.floor(from / HOUR) * HOUR : scale === 'quarter' ? weekStart(from) : dayStart(from)
  for (let at = first; at < to; at += step) {
    const d = new Date(at * 60000)
    const weekday = d.getUTCDay()
    out.push({
      from: at, to: at + step,
      major: scale === 'day' ? d.getUTCHours() === 0 : scale === 'quarter' ? d.getUTCDate() <= 7 : weekday === 1,
      weekend: scale !== 'quarter' && (weekday === 0 || weekday === 6),
    })
  }
  return out
}

/** Obere Zeile der Achse: Tage (im Tagesmaßstab) bzw. Monate. */
export function periods(scale: Scale, from: number, to: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  let at = dayStart(from)
  if (scale !== 'day') { const d = new Date(at * 60000); at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 60000 }
  while (at < to) {
    let next = at + DAY
    if (scale !== 'day') { const d = new Date(at * 60000); next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 60000 }
    out.push({ from: at, to: next })
    at = next
  }
  return out
}

/** Kalenderwoche nach ISO 8601 */
export function isoWeek(min: number): number {
  const thursday = weekStart(min) + 3 * DAY
  const jan1 = Date.UTC(new Date(thursday * 60000).getUTCFullYear(), 0, 1) / 60000
  return Math.floor((thursday - jan1) / (7 * DAY)) + 1
}
