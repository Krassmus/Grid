/** Link-Spalte: Web-Adresse, E-Mail oder Telefonnummer. Gespeichert wird der eingetippte Text. */
export type LinkKind = 'url' | 'email' | 'phone'

/** Adresse zum Öffnen (`https:`, `mailto:`, `tel:`) oder `null`, wenn der Text dafür nicht taugt. */
export function linkHref(kind: LinkKind, text: string): string | null {
  const t = text.trim()
  if (!t) return null
  if (kind === 'email') return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(t) ? `mailto:${t}` : null
  if (kind === 'phone') {
    const digits = t.replace(/[\s().\-/]/g, '')
    return /^\+?\d{3,}$/.test(digits) ? `tel:${digits}` : null
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`
  if (!/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(withScheme) && !/^https?:\/\/(localhost|\d+\.\d+\.\d+\.\d+)/i.test(withScheme)) return null
  try { return new URL(withScheme).href } catch { return null }
}
