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
  else if (style === 'long') day = date.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' })
  else if (style === 'weekday') day = date.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/^(\p{L}+)\.?,?\s*/u, '$1, ')
  else day = `${pad(d)}.${pad(mo)}.${y}`
  if (withTime && m[4]) day += style === 'iso' ? ` ${m[4]}:${m[5]}` : `, ${m[4]}:${m[5]} Uhr`
  return day
}

/** Wert für das passende <input>: nur Datum oder Datum + Uhrzeit. */
export function toInputValue(value: unknown, withTime: boolean): string {
  if (typeof value !== 'string' || !PATTERN.test(value)) return ''
  return withTime ? (value.length === 10 ? `${value}T00:00` : value) : value.slice(0, 10)
}
