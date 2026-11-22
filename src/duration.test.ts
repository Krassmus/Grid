import { describe, expect, it } from 'vitest'
import { formatDuration, parseDuration } from './duration'

describe('Dauer', () => {
  it('formatiert', () => {
    expect(formatDuration(5400)).toBe('1:30')
    expect(formatDuration(5400, 'hms')).toBe('1:30:00')
    expect(formatDuration(90000)).toBe('25:00')
    expect(formatDuration(-60)).toBe('−0:01')
    expect(formatDuration(3599)).toBe('1:00')
  })
  it('liest verschiedene Schreibweisen', () => {
    expect(parseDuration('1:30')).toBe(5400)
    expect(parseDuration('1:30:15')).toBe(5415)
    expect(parseDuration('1h 30m')).toBe(5400)
    expect(parseDuration('90m')).toBe(5400)
    expect(parseDuration('1,5 h')).toBe(5400)
    expect(parseDuration('1.5h')).toBe(5400)
    expect(parseDuration('45s')).toBe(45)
    expect(parseDuration('2 Std 15 Min')).toBe(8100)
    expect(parseDuration('1 Tag')).toBe(86400)
    expect(parseDuration('45')).toBe(2700)
    expect(parseDuration('-0:30')).toBe(-1800)
  })
  it('lehnt Unsinn ab', () => {
    for (const s of ['', 'abc', '1:75', '1h x', '::']) expect(parseDuration(s)).toBeNull()
  })
})
