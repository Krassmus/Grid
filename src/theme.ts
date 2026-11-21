import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './gridFile'

/** Erscheinungsbild: wie das System, immer hell oder immer dunkel. Die Farben stehen in theme.css. */
export type ThemeChoice = 'system' | 'light' | 'dark'
const KEY = 'grid-theme'

export const isThemeChoice = (v: unknown): v is ThemeChoice => v === 'system' || v === 'light' || v === 'dark'

export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY)
    return isThemeChoice(v) ? v : 'system'
  } catch { return 'system' }
}

/** Setzt `data-theme` am <html>-Element; ohne Eintrag entscheidet die Systemeinstellung. */
export function applyTheme(choice: ThemeChoice, root: HTMLElement = document.documentElement) {
  if (choice === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', choice)
}

/** Wählt das Erscheinungsbild: merkt es sich, wendet es an und gibt es an die App-Hülle weiter (Haken im Menü, Titelleiste). */
export function setTheme(choice: ThemeChoice) {
  try { localStorage.setItem(KEY, choice) } catch { /* egal */ }
  applyTheme(choice)
  if (isTauri) void invoke('set_theme', { choice }).catch(() => {})
}

/** Beim Start: gemerktes Erscheinungsbild anwenden (vor dem ersten Zeichnen, damit nichts aufblitzt) und dem Menü melden. */
export function initTheme() {
  const choice = readTheme()
  applyTheme(choice)
  if (isTauri) void invoke('set_theme', { choice }).catch(() => {})
}

/** Gilt gerade das dunkle Erscheinungsbild (eingestellt oder vom System verlangt)? */
export function isDark(): boolean {
  const t = document.documentElement.getAttribute('data-theme')
  return t === 'dark' || (t !== 'light' && typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches)
}

/** Ruft `fn` bei jedem Wechsel des Erscheinungsbilds auf (Einstellung oder Systemwechsel); liefert die Abmeldung. */
export function onThemeChange(fn: () => void): () => void {
  const observer = new MutationObserver(fn)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null
  media?.addEventListener('change', fn)
  return () => { observer.disconnect(); media?.removeEventListener('change', fn) }
}
