import { describe, expect, it } from 'vitest'
import { formatDate, toInputValue } from './dateFormat'

describe('Datum', () => {
  it('formatiert in den Darstellungen', () => {
    expect(formatDate('2026-11-17', 'short', false)).toBe('17.11.2026')
    expect(formatDate('2026-11-17', 'iso', false)).toBe('2026-11-17')
    expect(formatDate('2026-11-17', 'long', false)).toBe('17. November 2026')
    expect(formatDate('2026-11-17', 'weekday', false)).toBe('Di, 17.11.2026')
  })
  it('zeigt die Uhrzeit nur wenn gewünscht und vorhanden', () => {
    expect(formatDate('2026-11-17T14:30', 'short', true)).toBe('17.11.2026, 14:30 Uhr')
    expect(formatDate('2026-11-17T14:30', 'iso', true)).toBe('2026-11-17 14:30')
    expect(formatDate('2026-11-17T14:30', 'short', false)).toBe('17.11.2026')
    expect(formatDate('2026-11-17', 'short', true)).toBe('17.11.2026')
  })
  it('liefert Eingabewerte', () => {
    expect(toInputValue('2026-11-17T14:30', false)).toBe('2026-11-17')
    expect(toInputValue('2026-11-17', true)).toBe('2026-11-17T00:00')
    expect(toInputValue(null, true)).toBe('')
  })
})
