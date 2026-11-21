import { describe, expect, it } from 'vitest'
import { GLIDE_MS, easeInOut, glide, type Clock, type Tag } from './markerGlide'

/** Eine Uhr, die man von Hand vorstellt. */
function fakeClock(reduce = false) {
  let now = 0, next = 1
  const pending = new Map<number, (t: number) => void>()
  const clock: Clock = {
    now: () => now,
    raf: (fn) => { pending.set(next, fn); return next++ },
    caf: (id) => { pending.delete(id) },
    reduceMotion: () => reduce,
  }
  const advance = (ms: number) => { now += ms; for (const [id, fn] of [...pending]) { pending.delete(id); fn(now) } }
  return { clock, advance, running: () => pending.size }
}

function tag(lat = 50, lon = 10, dragging = false) {
  const pos = { lat, lng: lon }
  const t: Tag = {
    marker: { getLatLng: () => ({ ...pos }), setLatLng: ([a, b]) => { pos.lat = a; pos.lng = b } },
    host: { classList: { contains: (c: string) => dragging && c === 'dragging' } } as unknown as HTMLElement,
    anim: 0, target: { lat, lng: lon },
  }
  return { t, pos }
}

describe('Marker gleiten', () => {
  it('beschleunigt und bremst sanft', () => {
    expect(easeInOut(0)).toBe(0)
    expect(easeInOut(1)).toBe(1)
    expect(easeInOut(0.5)).toBeCloseTo(0.5)
    expect(easeInOut(0.25)).toBeLessThan(0.25)
    expect(easeInOut(0.75)).toBeGreaterThan(0.75)
  })

  it('braucht eine Sekunde für den Weg und landet genau am Ziel', () => {
    const { clock, advance } = fakeClock()
    const { t, pos } = tag(50, 10)
    glide(t, 52, 14, clock)
    expect(pos).toEqual({ lat: 50, lng: 10 }) // erst einmal bleibt er stehen
    advance(500)
    expect(pos.lat).toBeCloseTo(51) // zur Hälfte der Zeit auf halbem Weg
    expect(pos.lng).toBeCloseTo(12)
    advance(GLIDE_MS / 2 - 1)
    expect(pos.lat).toBeLessThan(52)
    advance(1)
    expect(pos).toEqual({ lat: 52, lng: 14 })
    expect(t.anim).toBe(0)
  })

  it('startet bei einer neuen Position mittendrin neu von dort', () => {
    const { clock, advance } = fakeClock()
    const { t, pos } = tag(50, 10)
    glide(t, 52, 10, clock); advance(500)
    const mid = pos.lat
    glide(t, 50, 10, clock) // zurück
    advance(1000)
    expect(mid).toBeCloseTo(51)
    expect(pos.lat).toBe(50)
  })

  it('tut nichts, wenn der Marker schon dort ist oder dorthin unterwegs ist', () => {
    const { clock, advance, running } = fakeClock()
    const { t } = tag(50, 10)
    glide(t, 50, 10, clock)
    expect(running()).toBe(0)
    glide(t, 52, 10, clock); advance(300)
    glide(t, 52, 10, clock) // gleiches Ziel: die Animation läuft weiter, ohne Neustart
    expect(running()).toBe(1)
  })

  it('springt bei winzigen Änderungen, bei reduzierter Bewegung und lässt gezogene Marker in Ruhe', () => {
    const tiny = fakeClock(); const a = tag(50, 10)
    glide(a.t, 50.00000005, 10, tiny.clock) // gleiche Stelle (Rundungsrest): nichts zu tun
    expect(a.pos.lat).toBe(50); expect(tiny.running()).toBe(0)
    const small = tag(50, 10)
    glide(small.t, 50.0000005, 10, tiny.clock) // ein paar Millimeter: springt, statt zu gleiten
    expect(small.pos.lat).toBe(50.0000005); expect(tiny.running()).toBe(0)

    const calm = fakeClock(true); const b = tag(50, 10)
    glide(b.t, 60, 20, calm.clock)
    expect(b.pos).toEqual({ lat: 60, lng: 20 }); expect(calm.running()).toBe(0)

    const clock = fakeClock(); const c = tag(50, 10, true)
    glide(c.t, 60, 20, clock.clock)
    expect(c.pos).toEqual({ lat: 50, lng: 10 }); expect(clock.running()).toBe(0)
  })
})
