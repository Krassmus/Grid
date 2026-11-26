/**
 * Lebt die Verbindung noch? Eine Strecke kann abreißen, ohne dass eine Seite davon erfährt (Ruhezustand, Wechsel zwischen
 * WLAN und Mobilfunk, App im Hintergrund): Die Verbindung sieht dann offen aus, aber nichts kommt an.
 * Darum fragt der Client regelmäßig nach (`ping`) und gibt die Verbindung auf, wenn nichts zurückkommt.
 */

/** So lange darf es still sein, bevor nachgefragt wird */
export const PING_EVERY = 25_000
/** So lange darf die Antwort auf sich warten lassen */
export const PONG_WAIT = 15_000
/** Kürzere Frist, wenn es einen Anlass zum Zweifel gibt (Gerät aufgewacht, neues Netz) */
export const PROBE_WAIT = 5_000
/** Kommt eine Frist so viel zu spät, hat das System die App angehalten: dann erst noch einmal fragen */
const LATE = 5_000

export class Heartbeat {
  private idle: ReturnType<typeof setTimeout> | undefined
  private wait: ReturnType<typeof setTimeout> | undefined
  running = false

  constructor(private io: {
    ping: () => void
    dead: () => void
    /** Bytes, die noch auf das Absenden warten: solange es weniger werden, läuft gerade ein großer Upload */
    buffered: () => number
  }) {}

  start() {
    this.stop()
    this.running = true
    this.rest()
  }

  stop() {
    this.running = false
    clearTimeout(this.idle)
    clearTimeout(this.wait)
    this.wait = undefined
  }

  /** Etwas ist angekommen: die Verbindung lebt. */
  heard() {
    if (!this.running) return
    clearTimeout(this.wait)
    this.wait = undefined
    this.rest()
  }

  /** Jetzt nachfragen und auf die Antwort warten. */
  probe(within = PROBE_WAIT) {
    if (!this.running) return
    clearTimeout(this.idle)
    clearTimeout(this.wait)
    this.io.ping()
    this.expect(within)
  }

  private rest() {
    clearTimeout(this.idle)
    this.idle = setTimeout(() => this.probe(PONG_WAIT), PING_EVERY)
  }

  private expect(within: number) {
    const due = Date.now() + within
    const before = this.io.buffered()
    this.wait = setTimeout(() => {
      // Die App war angehalten: die Antwort liegt vielleicht schon bereit
      if (Date.now() - due > LATE) return this.probe()
      const left = this.io.buffered()
      if (left > 0 && left < before) return this.expect(within)
      this.stop()
      this.io.dead()
    }, within)
  }
}

/** Anlass, an einer Verbindung zu zweifeln: App wieder sichtbar, Netz wieder da, Gerät hat geschlafen. */
export type WakeReason = 'visible' | 'online' | 'sleep'

const TICK = 5_000
/** Läuft der Takt so viel zu spät, war das Gerät im Ruhezustand oder die App angehalten */
const SLEPT = 30_000

/** Meldet solche Anlässe; `away` ist die Dauer der Abwesenheit in Millisekunden (0, wenn unbekannt). */
export function watchWake(onWake: (reason: WakeReason, away: number) => void): () => void {
  const win = typeof window === 'undefined' ? null : window
  const page = typeof document === 'undefined' ? null : document
  let hidden = 0
  let last = Date.now()
  const visibility = () => {
    if (page!.visibilityState === 'hidden') { hidden = Date.now(); return }
    onWake('visible', hidden ? Date.now() - hidden : 0)
    hidden = 0
  }
  const online = () => onWake('online', 0)
  const tick = setInterval(() => {
    const gap = Date.now() - last
    last = Date.now()
    if (gap > SLEPT) onWake('sleep', gap)
  }, TICK)
  page?.addEventListener('visibilitychange', visibility)
  win?.addEventListener('online', online)
  return () => {
    clearInterval(tick)
    page?.removeEventListener('visibilitychange', visibility)
    win?.removeEventListener('online', online)
  }
}
