/**
 * Mehrsprachigkeit der App-Texte (nicht der Inhalte). Der deutsche Text selbst ist der Schlüssel: `t('Speichern')`.
 * Für Englisch (US) gibt es das Wörterbuch `locales/en.ts`; fehlt ein Eintrag, erscheint der deutsche Text.
 * Platzhalter: `t('{n} Zeilen', { n: 3 })`. Die Sprache gilt nach `setLanguage` sofort (die Oberfläche baut sich neu auf).
 */
import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { en } from './locales/en'

export type Language = 'en' | 'de'
/** Auswahl in den Einstellungen: feste Sprache oder die des Systems. */
export type LanguageChoice = Language | 'system'
const KEY = 'grid-language'

export const isLanguage = (v: unknown): v is Language => v === 'en' || v === 'de'
export const isLanguageChoice = (v: unknown): v is LanguageChoice => v === 'system' || isLanguage(v)

/** Auswahlliste für die Einstellungen (Bezeichnungen der Sprachen bleiben in ihrer eigenen Sprache). */
export const languageOptions = (): { value: LanguageChoice; label: string }[] => [
  { value: 'system', label: t('Systemstandard') }, { value: 'en', label: 'English (US)' }, { value: 'de', label: 'Deutsch' },
]

export function readLanguageChoice(): LanguageChoice {
  try {
    const v = localStorage.getItem(KEY)
    return isLanguageChoice(v) ? v : 'en'
  } catch { return 'en' }
}

/** Sprache des Systems: die erste bevorzugte, die Grid kann (Deutsch oder Englisch); sonst Englisch. */
export function systemLanguage(prefs: readonly string[] = typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : []): Language {
  for (const p of prefs) {
    const base = p.toLowerCase().split(/[-_]/)[0]
    if (base === 'de') return 'de'
    if (base === 'en') return 'en'
  }
  return 'en'
}

const resolve = (c: LanguageChoice): Language => (c === 'system' ? systemLanguage() : c)

let choice: LanguageChoice = readLanguageChoice()
let current: Language = resolve(choice)
const listeners = new Set<() => void>()

export const language = (): Language => current
export const languageChoice = (): LanguageChoice => choice
/** Gebietsschema für Datum, Zahlen und Sortierung der Oberfläche. */
export const locale = (): string => (current === 'de' ? 'de-DE' : 'en-US')

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

function apply() {
  if (typeof document !== 'undefined') document.documentElement.lang = current
  if (isTauri) void invoke('set_language', { lang: current }).catch(() => {})
}

/** Beim Start: Sprache der Seite setzen und dem Menü melden. */
export function initLanguage() { apply() }

function update(c: LanguageChoice) {
  choice = c
  const next = resolve(c)
  const changed = next !== current
  current = next
  if (changed) { apply(); listeners.forEach((f) => f()) }
}

export function setLanguage(c: LanguageChoice) {
  try { localStorage.setItem(KEY, c) } catch { /* egal */ }
  const wasChoice = choice
  update(c)
  if (wasChoice !== c) listeners.forEach((f) => f()) // auch die Auswahl selbst hat sich geändert
}

// Ändert das System seine Sprache, folgt Grid (nur bei „Systemstandard“)
if (typeof window !== 'undefined') window.addEventListener('languagechange', () => { if (choice === 'system') update('system') })

/** Für Komponenten: liefert die Sprache und rendert bei Wechsel neu. */
export function useLanguage(): Language {
  return useSyncExternalStore((f) => { listeners.add(f); return () => { listeners.delete(f) } }, language)
}

/** Wie `useLanguage`, liefert aber die Auswahl (auch „system“). */
export function useLanguageChoice(): LanguageChoice {
  return useSyncExternalStore((f) => { listeners.add(f); return () => { listeners.delete(f) } }, languageChoice)
}

const fill = (s: string, vars?: Record<string, string | number>) =>
  vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s

/** Text in der gewählten Sprache. Schlüssel ist der deutsche Text. */
export function t(de: string, vars?: Record<string, string | number>): string {
  return fill(current === 'de' ? de : en[de] ?? de, vars)
}

/** Einzahl/Mehrzahl: `tn(n, '{n} Zeile', '{n} Zeilen')`. */
export const tn = (n: number, one: string, many: string): string => t(n === 1 ? one : many, { n })
