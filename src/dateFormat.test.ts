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

import { editText, isoDate, parseDateInput } from './dateFormat'

describe('Datumseingabe', () => {
  const today = new Date(2026, 10, 21) // 21.11.2026
  const p = (s: string) => parseDateInput(s, today)
  it('liest übliche Schreibweisen', () => {
    for (const s of ['17.11.2026', '17.11.26', '17. 11. 2026', '17/11/2026', '17-11-2026', '2026-11-17', '17112026', '171126', '17.11.2026.'])
      expect(p(s), s).toEqual({ date: '2026-11-17', time: null })
    expect(p('17.11.')).toEqual({ date: '2026-11-17', time: null }) // ohne Jahr: dieses Jahr
    expect(p('17.11')).toEqual({ date: '2026-11-17', time: null })
    expect(p('1711')).toEqual({ date: '2026-11-17', time: null })
    expect(p('1.3.')).toEqual({ date: '2026-03-01', time: null })
  })
  it('zweistellige Jahre', () => {
    expect(p('1.1.69')!.date).toBe('2069-01-01')
    expect(p('1.1.70')!.date).toBe('1970-01-01')
  })
  it('liest Uhrzeiten', () => {
    expect(p('17.11.2026 14:30')).toEqual({ date: '2026-11-17', time: '14:30' })
    expect(p('17.11.2026, 14.30 Uhr')).toEqual({ date: '2026-11-17', time: '14:30' })
    expect(p('2026-11-17T09:05')).toEqual({ date: '2026-11-17', time: '09:05' })
    expect(p('17.11. 1430')).toEqual({ date: '2026-11-17', time: '14:30' })
    expect(p('17.11. 930')).toEqual({ date: '2026-11-17', time: '09:30' })
    expect(p('17.11. 8')).toEqual({ date: '2026-11-17', time: '08:00' })
  })
  it('Stichwörter', () => {
    expect(p('heute')).toEqual({ date: '2026-11-21', time: null })
    expect(p('Morgen')).toEqual({ date: '2026-11-22', time: null })
    expect(p('gestern 8:00')).toEqual({ date: '2026-11-20', time: '08:00' })
  })
  it('lehnt Ungültiges ab statt Unsinn zu speichern', () => {
    for (const s of ['', '31.02.2026', '32.1.2026', '1.13.2026', '17.11.202', '17.11.20266', 'abc', '17.11.2026 25:00', '17.11.2026 14:70', '17.11.2026 14:30 x', '17'])
      expect(p(s), s).toBeNull()
    expect(p('17.11.0202')).toBeNull() // Jahr unter 1000
  })
  it('Schaltjahre', () => {
    expect(isoDate(2028, 2, 29)).toBe('2028-02-29')
    expect(isoDate(2026, 2, 29)).toBeNull()
  })
  it('Eingabetext', () => {
    expect(editText('2026-11-17', false)).toBe('17.11.2026')
    expect(editText('2026-11-17T14:30', true)).toBe('17.11.2026 14:30')
    expect(editText('2026-11-17', true)).toBe('17.11.2026 00:00')
    expect(editText(null, false)).toBe('')
  })
})
