/** Dateinamen für Dokumente im App-Ordner (iPad/iPhone). */

/** Entfernt Zeichen, die in Dateinamen Ärger machen; leer wird zu „Neues Dokument“. */
import { t, locale } from './i18n'
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').trim().slice(0, 80)
  return cleaned || t('Neues Dokument')
}

/** Name, der noch nicht vergeben ist: „Name“, „Name 2“, „Name 3“ … (ohne Beachtung der Groß-/Kleinschreibung). */
export function uniqueName(base: string, taken: string[]): string {
  const used = new Set(taken.map((t) => t.toLowerCase()))
  const name = safeFileName(base)
  if (!used.has(name.toLowerCase())) return name
  for (let i = 2; ; i++) if (!used.has(`${name} ${i}`.toLowerCase())) return `${name} ${i}`
}

/** „vor 5 Minuten“, „gestern“, sonst Datum. */
export function ago(seconds: number, now = Date.now()): string {
  const diff = Math.max(0, Math.round(now / 1000 - seconds))
  if (diff < 60) return t('gerade eben')
  if (diff < 3600) return t('vor {n} Min.', { n: Math.floor(diff / 60) })
  if (diff < 86400) return t('vor {n} Std.', { n: Math.floor(diff / 3600) })
  if (diff < 172800) return t('gestern')
  return new Date(seconds * 1000).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' })
}
