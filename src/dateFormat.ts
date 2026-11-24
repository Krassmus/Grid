import { language, locale } from './i18n'
/** Datumswerte sind „schwebend“ (ohne Zeitzone) als Text gespeichert: `2026-11-17` oder `2026-11-17T14:30`. */
export type DateStyle = 'short' | 'long' | 'weekday' | 'iso'

export const DATE_STYLES: { value: DateStyle; label: string }[] = [
  { value: 'short', label: '17.11.2026' },
  { value: 'long', label: '17. November 2026' },
  { value: 'weekday', label: 'Di, 17.11.2026' },
  { value: 'iso', label: '2026-11-17' },
]

const PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/

export function formatDate(value: unknown, style: DateStyle, withTime: boolean): string {
  if (typeof value !== 'string') return ''
  const m = PATTERN.exec(value)
  if (!m) return value
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(y, mo - 1, d)
  const pad = (n: number) => String(n).padStart(2, '0')
  let day: string
  if (style === 'iso') day = `${m[1]}-${m[2]}-${m[3]}`
  else if (style === 'long') day = date.toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' })
  else if (style === 'weekday') day = `${date.toLocaleDateString(locale(), { weekday: 'short' }).replace('.', '')}, ${pad(d)}.${pad(mo)}.${y}`
  else day = `${pad(d)}.${pad(mo)}.${y}`
  if (withTime && m[4]) day += style === 'iso' ? ` ${m[4]}:${m[5]}` : `, ${m[4]}:${m[5]}${language() === 'de' ? ' Uhr' : ''}`
  return day
}

/** Wert für das passende <input>: nur Datum oder Datum + Uhrzeit. */
export function toInputValue(value: unknown, withTime: boolean): string {
  if (typeof value !== 'string' || !PATTERN.test(value)) return ''
  return withTime ? (value.length === 10 ? `${value}T00:00` : value) : value.slice(0, 10)
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** `YYYY-MM-DD`, wenn das ein echter Kalendertag ist (kein 31.02., Jahr vierstellig), sonst `null`. */
export function isoDate(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1) return null
  const t = new Date(y, m - 1, d)
  if (t.getFullYear() !== y || t.getMonth() !== m - 1 || t.getDate() !== d) return null
  return `${y}-${pad2(m)}-${pad2(d)}`
}

/** Text für das Eingabefeld des Datumswählers: `17.11.2026`, mit Uhrzeit `17.11.2026 14:30`. */
export function editText(value: unknown, withTime: boolean): string {
  if (typeof value !== 'string') return ''
  const m = PATTERN.exec(value)
  if (!m) return value
  return `${m[3]}.${m[2]}.${m[1]}${withTime ? ` ${m[4] ?? '00'}:${m[5] ?? '00'}` : ''}`
}

const parseTime = (t: string): string | null => {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(t) ?? /^(\d{1,2})(\d{2})$/.exec(t) ?? /^(\d{1,2})()$/.exec(t)
  if (!m) return null
  const h = Number(m[1]), min = m[2] ? Number(m[2]) : 0
  return h <= 23 && min <= 59 ? `${pad2(h)}:${pad2(min)}` : null
}

/**
 * Liest eine getippte Datums- (und Zeit-)Angabe. Erlaubt sind u. a. `17.11.2026`, `17.11.26`, `17.11.` (dieses Jahr),
 * `17112026`, `171126`, `1711`, `17/11/2026`, `2026-11-17`, `heute`, `morgen`, `gestern`, dazu eine Uhrzeit (`14:30`, `1430`, `14`).
 * Zweistellige Jahre: 00–69 → 2000er, 70–99 → 1900er. Ungültiges (31.02., Jahr unter 1000 oder mit drei oder fünf Ziffern, Buchstaben) → `null`: so landen keine Jahreszahlen wie „6202“ im Dokument.
 */
export function parseDateInput(text: string, today: Date = new Date()): { date: string; time: string | null } | null {
  const t = text.trim().toLowerCase().replace(/(\d)t(\d)/, '$1 $2').replace(/\s*uhr$/, '')
  if (!t) return null
  const tokens = t.split(/[\s,]+/)
  // „17. 11. 2026“ (Leerzeichen nach den Punkten) gehört zusammen; „17.11. 1430“ ist Datum und Uhrzeit
  if (/^\d{1,2}\.$/.test(tokens[0]) && /^\d{1,2}\.?$/.test(tokens[1] ?? '')) {
    const n = tokens[1].endsWith('.') && /^\d{2,4}$/.test(tokens[2] ?? '') ? 3 : 2
    tokens.splice(0, n, tokens.slice(0, n).join(''))
  }
  const [first, second, ...rest] = tokens
  if (rest.length) return null
  const time = second === undefined ? null : parseTime(second)
  if (second !== undefined && time === null) return null
  const day = (offset: number) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset)
    return isoDate(d.getFullYear(), d.getMonth() + 1, d.getDate())
  }
  const words: Record<string, number> = { heute: 0, morgen: 1, gestern: -1, übermorgen: 2, vorgestern: -2, today: 0, tomorrow: 1, yesterday: -1 }
  if (first in words) { const date = day(words[first]); return date ? { date, time } : null }

  const year = (s: string | undefined): number | null => {
    if (s === undefined || s === '') return today.getFullYear()
    if (s.length === 4) return Number(s)
    if (s.length <= 2) return 2000 + Number(s) - (Number(s) >= 70 ? 100 : 0)
    return null
  }
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(first)
  let y: number | null, mo: number, d: number
  if (m) { y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]) }
  else if ((m = /^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{1,4}))?\.?$/.exec(first))) { d = Number(m[1]); mo = Number(m[2]); y = year(m[3]) }
  else if ((m = /^(\d{2})(\d{2})(\d{2}|\d{4})?$/.exec(first))) { d = Number(m[1]); mo = Number(m[2]); y = year(m[3]) }
  else return null
  if (y === null) return null
  const date = isoDate(y, mo, d)
  return date ? { date, time } : null
}

/** Zeitpunkt (Millisekunden) als schwebender Text in der Ortszeit: `2026-11-17T14:30`. */
export function floatingFromMs(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
