import { describe, expect, it } from 'vitest'
// @ts-ignore – die Typen für Node sind im Projekt nicht eingebunden
import { readFileSync } from 'node:fs'
import { applyTheme, isThemeChoice } from './theme'

const read = (f: string): string => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')
const css = read('styles.css'), theme = read('theme.css'), tsx = read('SelectCell.tsx')

const defined = (block: string) => new Set([...block.matchAll(/(--[\w-]+):/g)].map((m) => m[1]))
const blocks = theme.split(/^(?=:root|@media|\s*:root)/m)
// erster Block: hell; danach zweimal dunkel (Systemeinstellung und data-theme)
const light = defined(theme.slice(theme.indexOf(':root {'), theme.indexOf('@media')))
const dark = defined(theme.slice(theme.indexOf('@media'), theme.indexOf(':root[data-theme="dark"]')))
const darkExplicit = defined(theme.slice(theme.indexOf(':root[data-theme="dark"]')))

describe('Erscheinungsbild', () => {
  it('erkennt gültige Auswahlwerte', () => {
    expect(['system', 'light', 'dark'].every(isThemeChoice)).toBe(true)
    expect(isThemeChoice('blau')).toBe(false)
    expect(isThemeChoice(null)).toBe(false)
  })

  it('setzt data-theme nur für Hell und Dunkel, bei Systemstandard wird es entfernt', () => {
    const attrs = new Map<string, string>()
    const root = { setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k) } as unknown as HTMLElement
    applyTheme('dark', root)
    expect(attrs.get('data-theme')).toBe('dark')
    applyTheme('light', root)
    expect(attrs.get('data-theme')).toBe('light')
    applyTheme('system', root)
    expect(attrs.has('data-theme')).toBe(false)
  })

  it('jede benutzte Farbvariable ist hell und dunkel definiert', () => {
    const used = new Set([...css.matchAll(/var\((--c-[\w-]+)\)/g), ...tsx.matchAll(/var\((--opt-[\w-]+)\)/g)].map((m) => m[1]))
    expect(used.size).toBeGreaterThan(30)
    for (const v of used) {
      expect(light.has(v), `${v} hell`).toBe(true)
      expect(dark.has(v), `${v} dunkel (System)`).toBe(true)
      expect(darkExplicit.has(v), `${v} dunkel (eingestellt)`).toBe(true)
    }
    expect(blocks.length).toBeGreaterThan(2)
  })

  it('beide dunklen Blöcke sind gleich', () => {
    expect([...dark].sort()).toEqual([...darkExplicit].sort())
  })

  it('Farben stehen nicht mehr als Hex-Wert im Stylesheet (außer Akzente, Schatten und weißer Text)', () => {
    const rest = new Set([...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase()))
    const allowed = new Set(['#fff', '#0a84ff', '#0a84ff55', '#0a84ff80', '#0a84ff88', '#1456c8', '#1a7f37', '#2e9e4f', '#c0392b', '#c0392b44', '#d92d20', '#ff9f0a'])
    for (const c of rest) expect(allowed.has(c) || /^#000[0-9a-f]$/.test(c), c).toBe(true)
  })
})
