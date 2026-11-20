import { describe, expect, it } from 'vitest'
import { formatArea, formatLength, pathLength, ringArea } from './mapGeometry'

describe('mapGeometry', () => {
  it('Länge: 1° Breite ≈ 111,2 km', () => {
    expect(pathLength([[50, 10], [51, 10]]) / 1000).toBeCloseTo(111.2, 0)
    expect(pathLength([[50, 10]])).toBe(0)
  })
  it('Fläche: 0,01° × 0,01° bei 50° N ≈ 0,79 km²', () => {
    const a = ringArea([[50, 10], [50.01, 10], [50.01, 10.01], [50, 10.01]])
    expect(a).toBeGreaterThan(0.78e6)
    expect(a).toBeLessThan(0.81e6)
    expect(ringArea([[1, 1], [2, 2]])).toBe(0)
  })
  it('Formatierung', () => {
    expect(formatLength(850)).toBe('850 m')
    expect(formatLength(12345)).toBe('12,3 km')
    expect(formatArea(500)).toBe('500 m²')
    expect(formatArea(250000)).toBe('25 ha')
    expect(formatArea(3_500_000)).toBe('3,5 km²')
  })
})
