/** Dauer: gespeichert in Sekunden, angezeigt als h:mm (oder h:mm:ss). */
export type DurationFormat = 'hm' | 'hms'

const pad = (n: number) => String(n).padStart(2, '0')

export function formatDuration(seconds: number, format: DurationFormat = 'hm'): string {
  const neg = seconds < 0
  let s = Math.round(Math.abs(seconds))
  if (format === 'hm') s = Math.round(s / 60) * 60
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return `${neg ? '−' : ''}${h}:${pad(m)}${format === 'hms' ? `:${pad(sec)}` : ''}`
}

/**
 * Liest eine eingetippte Dauer: „1:30“, „1:30:15“, „1h 30m“, „90m“, „1,5 h“, „45s“; eine nackte Zahl zählt als Minuten.
 * `null` = nicht lesbar, `''` (leere Eingabe) wird vom Aufrufer als „leer“ behandelt.
 */
export function parseDuration(input: string): number | null {
  const t = input.trim().toLowerCase().replace(/−/g, '-')
  if (!t) return null
  const neg = t.startsWith('-')
  const body = neg ? t.slice(1).trim() : t
  let total: number | null = null
  let m: RegExpMatchArray | null
  if ((m = body.match(/^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/))) total = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0)
  else if (/^[\d.,]+$/.test(body)) { const n = Number(body.replace(',', '.')); total = Number.isFinite(n) ? n * 60 : null }
  else if (/^(\s*[\d.,]+\s*(d|tage?|h|std|stunden?|m|min|minuten?|s|sek|sekunden?)\b\s*)+$/.test(body)) {
    total = 0
    for (const part of body.matchAll(/([\d.,]+)\s*(d|tage?|h|std|stunden?|m|min|minuten?|s|sek|sekunden?)\b/g)) {
      const n = Number(part[1].replace(',', '.'))
      if (!Number.isFinite(n)) return null
      const u = part[2][0] === 't' ? 'd' : part[2].startsWith('mi') || part[2] === 'm' ? 'm' : part[2][0]
      total += n * (u === 'd' ? 86400 : u === 'h' || u === 's' && part[2].startsWith('st') ? 3600 : u === 'm' ? 60 : 1)
    }
  }
  if (total === null) return null
  return Math.round(neg ? -total : total)
}
