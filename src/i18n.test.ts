import { afterEach, describe, expect, it } from 'vitest'
import { en } from './locales/en'
import { language, setLanguage, systemLanguage, t, tn } from './i18n'

const files = import.meta.glob(['./*.ts', './*.tsx', '!./*.test.ts', '!./i18n.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const unescape = (s: string) => s.replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\\\/g, '\\')

/** Alle Texte, die als Wortlaut in t('…'), tr('…') oder tn(n, '…', '…') stehen. */
function usedKeys(): Map<string, string> {
  const keys = new Map<string, string>()
  for (const [f, src] of Object.entries(files)) {
    for (const m of src.matchAll(/(?<![\w.])(?:t|tr)\(\s*'((?:[^'\\\n]|\\.)*)'/g)) keys.set(unescape(m[1]), f)
    for (const m of src.matchAll(/(?<![\w.])tn\([^,]+,\s*'((?:[^'\\\n]|\\.)*)'\s*,\s*'((?:[^'\\\n]|\\.)*)'/g)) { keys.set(unescape(m[1]), f); keys.set(unescape(m[2]), f) }
  }
  return keys
}
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')

afterEach(() => setLanguage('de'))

describe('Übersetzungen', () => {
  it('jeder Text im Quelltext hat eine englische Übersetzung', () => {
    const missing = [...usedKeys()].filter(([k]) => !(k in en)).map(([k, f]) => `${f}: ${k}`)
    expect(missing).toEqual([])
  })

  it('Platzhalter stimmen in beiden Sprachen überein', () => {
    const bad = Object.entries(en).filter(([de, e]) => !de.includes('{{') && placeholders(de) !== placeholders(e)).map(([de]) => de)
    expect(bad).toEqual([])
  })

  it('Deutsch gibt den Text unverändert aus, Englisch übersetzt und füllt Platzhalter', () => {
    expect(t('Speichern')).toBe('Speichern')
    expect(t('{n} Zeilen', { n: 3 })).toBe('3 Zeilen')
    setLanguage('en')
    expect(language()).toBe('en')
    expect(t('Speichern')).toBe('Save')
    expect(t('{n} Zeilen', { n: 3 })).toBe('3 rows')
    expect(t('Gibt es nicht im Wörterbuch')).toBe('Gibt es nicht im Wörterbuch')
  })

  it('Systemstandard: Deutsch nur, wenn es die bevorzugte unterstützte Sprache ist, sonst Englisch', () => {
    expect(systemLanguage(['de-DE', 'en-US'])).toBe('de')
    expect(systemLanguage(['de'])).toBe('de')
    expect(systemLanguage(['en-GB', 'de'])).toBe('en')
    expect(systemLanguage(['fr-FR', 'de-AT'])).toBe('de')
    expect(systemLanguage(['fr-FR', 'ja'])).toBe('en')
    expect(systemLanguage([])).toBe('en')
  })

  it('tn wählt Einzahl und Mehrzahl', () => {
    setLanguage('en')
    expect(tn(1, '{n} Zeile', '{n} Zeilen')).toBe('1 row')
    expect(tn(2, '{n} Zeile', '{n} Zeilen')).toBe('2 rows')
  })
})
