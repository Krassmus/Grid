import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Heartbeat, PING_EVERY, PONG_WAIT, PROBE_WAIT, watchWake } from './heartbeat'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

const make = () => {
  const io = { pings: 0, deaths: 0, left: 0 }
  const beat = new Heartbeat({ ping: () => { io.pings++ }, dead: () => { io.deaths++ }, buffered: () => io.left })
  beat.start()
  return { io, beat }
}

describe('Lebenszeichen', () => {
  it('fragt erst nach, wenn es still ist, und bleibt bei einer Antwort verbunden', () => {
    const { io, beat } = make()
    for (let i = 0; i < 5; i++) { vi.advanceTimersByTime(PING_EVERY - 1000); beat.heard() }
    expect(io.pings).toBe(0)
    vi.advanceTimersByTime(PING_EVERY)
    expect(io.pings).toBe(1)
    beat.heard()
    vi.advanceTimersByTime(PONG_WAIT)
    expect(io.deaths).toBe(0)
  })

  it('gibt die Verbindung auf, wenn keine Antwort kommt, und zwar nur einmal', () => {
    const { io } = make()
    vi.advanceTimersByTime(PING_EVERY + PONG_WAIT - 1)
    expect(io.deaths).toBe(0)
    vi.advanceTimersByTime(1)
    expect(io.deaths).toBe(1)
    vi.advanceTimersByTime(10 * PING_EVERY)
    expect(io).toMatchObject({ pings: 1, deaths: 1 })
  })

  it('prüft auf Anlass sofort und mit kurzer Frist', () => {
    const { io, beat } = make()
    beat.probe()
    expect(io.pings).toBe(1)
    vi.advanceTimersByTime(PROBE_WAIT)
    expect(io.deaths).toBe(1)
  })

  it('wartet, solange ein großer Upload vorankommt', () => {
    const { io, beat } = make()
    io.left = 1000
    beat.probe()
    io.left = 600
    vi.advanceTimersByTime(PROBE_WAIT)
    expect(io.deaths).toBe(0)
    // steht der Upload, zählt die ausbleibende Antwort
    vi.advanceTimersByTime(PROBE_WAIT)
    expect(io.deaths).toBe(1)
  })

  it('fragt noch einmal, wenn die App angehalten war', () => {
    const { io, beat } = make()
    beat.probe()
    vi.setSystemTime(Date.now() + 60 * 60_000) // geschlafen: die Frist läuft viel zu spät ab
    vi.advanceTimersByTime(PROBE_WAIT)
    expect(io).toMatchObject({ pings: 2, deaths: 0 })
    vi.advanceTimersByTime(PROBE_WAIT)
    expect(io.deaths).toBe(1)
  })

  it('tut nach dem Anhalten nichts mehr', () => {
    const { io, beat } = make()
    beat.stop()
    beat.probe()
    beat.heard()
    vi.advanceTimersByTime(10 * PING_EVERY)
    expect(io).toMatchObject({ pings: 0, deaths: 0 })
  })
})

describe('Anlässe zum Nachprüfen', () => {
  it('meldet Rückkehr in die App, neues Netz und Ruhezustand', () => {
    const page = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    const win = new EventTarget()
    vi.stubGlobal('document', page)
    vi.stubGlobal('window', win)
    const seen: [string, number][] = []
    const off = watchWake((reason, away) => seen.push([reason, away]))

    page.visibilityState = 'hidden'; page.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(20_000)
    page.visibilityState = 'visible'; page.dispatchEvent(new Event('visibilitychange'))
    win.dispatchEvent(new Event('online'))
    expect(seen).toEqual([['visible', 20_000], ['online', 0]])

    seen.length = 0
    vi.setSystemTime(Date.now() + 10 * 60_000)
    vi.advanceTimersByTime(5_000)
    expect(seen.map((s) => s[0])).toEqual(['sleep'])
    expect(seen[0][1]).toBeGreaterThan(10 * 60_000 - 1)

    off()
    seen.length = 0
    win.dispatchEvent(new Event('online'))
    expect(seen).toEqual([])
  })
})
