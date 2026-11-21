/** Sanftes Verschieben von Markern auf der Karte, wenn sich ihre Position im Dokument ändert (z. B. durch eine andere Person). */

export const GLIDE_MS = 1000

export interface Tag {
  marker: { getLatLng(): { lat: number; lng: number }; setLatLng(ll: [number, number]): unknown }
  /** Element, in dem die Kachel des Markers gezeichnet wird; trägt die Klasse „dragging“, solange man den Marker selbst zieht */
  host: HTMLElement
  /** laufende Animation (requestAnimationFrame-Nummer, 0 = keine) */
  anim: number
  /** wohin der Marker unterwegs ist bzw. wo er steht */
  target: { lat: number; lng: number }
}

export interface Clock {
  now(): number
  raf(fn: (t: number) => void): number
  caf(id: number): void
  /** Bewegung reduzieren (Systemeinstellung): dann springt der Marker */
  reduceMotion(): boolean
}

const browserClock: Clock = {
  now: () => performance.now(),
  raf: (fn) => requestAnimationFrame(fn),
  caf: (id) => cancelAnimationFrame(id),
  reduceMotion: () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
}

/** Langsam anfangen, schnell in der Mitte, langsam ankommen. */
export const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2)

/** Lässt den Marker zur neuen Position gleiten (eine Sekunde). Eigenes Ziehen und kaum spürbare Änderungen setzen ihn direkt. */
export function glide(tag: Tag, lat: number, lon: number, clock: Clock = browserClock, ms = GLIDE_MS) {
  if (tag.host.classList.contains('dragging')) return // wer den Marker gerade selbst zieht, behält ihn
  if (Math.abs(tag.target.lat - lat) < 1e-7 && Math.abs(tag.target.lng - lon) < 1e-7) return // schon dort oder unterwegs dorthin
  clock.caf(tag.anim)
  tag.anim = 0
  tag.target = { lat, lng: lon }
  const from = tag.marker.getLatLng()
  if (clock.reduceMotion() || Math.hypot(from.lat - lat, from.lng - lon) < 1e-6) { tag.marker.setLatLng([lat, lon]); return }
  const t0 = clock.now()
  const step = (now: number) => {
    const k = Math.min(1, Math.max(0, (now - t0) / ms))
    const e = easeInOut(k)
    tag.marker.setLatLng(k >= 1 ? [lat, lon] : [from.lat + (lat - from.lat) * e, from.lng + (lon - from.lng) * e])
    tag.anim = k < 1 ? clock.raf(step) : 0
  }
  tag.anim = clock.raf(step)
}
