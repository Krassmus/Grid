import { describe, expect, it } from 'vitest'
import { offsetsOf, visibleRange } from './virtualRows'

const ids = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`)

describe('virtuelle Zeilen', () => {
  it('Positionen aus gemessenen Höhen und Schätzung', () => {
    const h = new Map([['r1', 100]])
    expect(offsetsOf(ids(3), h, 50)).toEqual([0, 50, 150, 200])
  })

  it('zeichnet den sichtbaren Bereich plus je einen Bildschirm davor und danach', () => {
    const o = offsetsOf(ids(1000), new Map(), 50) // 50 px je Zeile
    const r = visibleRange(o, 10000, 500) // Sichtbereich 10000–10500
    expect(o[r.start]).toBeLessThanOrEqual(9500) // ein Bildschirm davor
    expect(o[r.start + 1]).toBeGreaterThan(9500)
    expect(o[r.end]).toBeGreaterThanOrEqual(11000) // Sichtbereich plus ein Bildschirm dahinter
    expect(r.end - r.start).toBeLessThan(40)
  })

  it('am Anfang und am Ende bleibt der Bereich gültig und nicht zu klein', () => {
    const o = offsetsOf(ids(500), new Map(), 50)
    expect(visibleRange(o, -100, 500).start).toBe(0)
    const end = visibleRange(o, 1e9, 500)
    expect(end.end).toBe(500)
    expect(end.end - end.start).toBeGreaterThanOrEqual(12)
    expect(visibleRange(o, 0, 10).end).toBeGreaterThanOrEqual(12) // Mindestzahl, auch bei winzigem Fenster
  })

  it('leere und sehr kurze Listen', () => {
    expect(visibleRange(offsetsOf([], new Map()), 0, 500)).toEqual({ start: 0, end: 0 })
    expect(visibleRange(offsetsOf(ids(3), new Map()), 0, 500)).toEqual({ start: 0, end: 3 })
  })

  it('unterschiedliche Höhen: Bereich folgt den Positionen', () => {
    const h = new Map(ids(100).map((id, i) => [id, i < 50 ? 200 : 40] as [string, number]))
    const o = offsetsOf(ids(100), h)
    const r = visibleRange(o, 10000, 400) // Zeile 50 beginnt bei 10000
    expect(r.start).toBeLessThanOrEqual(50)
    expect(r.start).toBeGreaterThanOrEqual(45) // 400 px Puffer = 2 hohe Zeilen davor
    expect(r.end).toBeGreaterThan(50)
  })
})
