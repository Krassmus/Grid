import { describe, expect, it } from 'vitest'
import { FILE, NUMBER, TEXT, columnTypeOf } from './columnTypes'

describe('Spaltentypen', () => {
  it('liefern Standardwerte und übernehmen nur bekannte Einstellungen mit passendem Typ', () => {
    expect(TEXT.config({})).toEqual({ mode: 'single', bold: false })
    expect(TEXT.config({ config: { mode: 'rich', bold: true, fremd: 1 } })).toEqual({ mode: 'rich', bold: true })
    expect(TEXT.config({ config: { bold: 'ja' } })).toEqual({ mode: 'single', bold: false })
    expect(NUMBER.config({ config: { decimals: 2, unit: '€' } })).toEqual({ decimals: 2, unit: '€' })
    expect(FILE.config({ config: { accept: 'images' } }).single).toBe(false)
  })
  it('jeder Spaltentyp hat eine Klasse', () => {
    for (const t of ['text', 'number', 'relation', 'file', 'select'] as const) expect(columnTypeOf(t).type).toBe(t)
  })
})
