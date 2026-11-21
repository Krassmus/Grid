import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'

/** Erst ab so vielen Zeilen wird virtualisiert; darunter ist alles gezeichnet (einfacher und sofort durchsuchbar). */
export const VIRTUAL_FROM = 120
/** Geschätzte Höhe einer noch nie gezeichneten Zeile (Mindesthöhe 64 px plus Trennlinie). */
const ESTIMATE = 65
const MIN_ROWS = 12

/** Position von Zeilen aus ihren Höhen: `offsets[i]` = Oberkante der Zeile i, `offsets[n]` = Gesamthöhe. */
export function offsetsOf(ids: string[], heights: Map<string, number>, estimate = ESTIMATE): number[] {
  const out = new Array<number>(ids.length + 1)
  out[0] = 0
  for (let i = 0; i < ids.length; i++) out[i + 1] = out[i] + (heights.get(ids[i]) ?? estimate)
  return out
}

/**
 * Welche Zeilen gezeichnet werden: alles im sichtbaren Bereich plus je ein Bildschirm davor und danach,
 * damit beim Scrollen nichts nachspringt. `top` = Abstand der Sichtkante von der Oberkante der Zeilen.
 */
export function visibleRange(offsets: number[], top: number, viewport: number, minRows = MIN_ROWS): { start: number; end: number } {
  const n = offsets.length - 1
  const from = Math.max(0, top - viewport), to = Math.max(0, top + 2 * viewport)
  // erste Zeile, deren Unterkante unter `from` liegt
  let lo = 0, hi = n
  while (lo < hi) { const mid = (lo + hi) >> 1; if (offsets[mid + 1] > from) hi = mid; else lo = mid + 1 }
  const start = Math.min(lo, Math.max(0, n - minRows))
  // erste Zeile, deren Oberkante hinter `to` liegt
  lo = start; hi = n
  while (lo < hi) { const mid = (lo + hi) >> 1; if (offsets[mid] >= to) hi = mid; else lo = mid + 1 }
  return { start, end: Math.min(n, Math.max(lo, start + minRows)) }
}

const scrollParent = (el: HTMLElement): HTMLElement => {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY
    if (o === 'auto' || o === 'scroll') return p
  }
  return document.documentElement
}

/**
 * Zeichnet nur die Zeilen in und um den sichtbaren Bereich. Zeilenhöhen werden gemessen (Zeilen mit umbrechenden Kacheln
 * sind höher); noch nicht gezeichnete Zeilen zählen mit einer Schätzung. Davor und dahinter hält je ein Abstandshalter
 * (`topPad`, `bottomPad`) die Gesamthöhe, damit die Bildlaufleiste stimmt.
 *
 * `anchorRef` gehört an den oberen Abstandshalter (dessen Elternelement enthält die Zeilen mit `data-row`).
 */
export function useVirtualRows(ids: string[]) {
  const virtual = ids.length > VIRTUAL_FROM
  const anchorRef = useRef<HTMLDivElement>(null)
  const heights = useRef(new Map<string, number>())
  const [version, setVersion] = useState(0)
  const [range, setRange] = useState({ start: 0, end: MIN_ROWS })
  const offsets = useMemo(() => offsetsOf(ids, heights.current), [ids, version])
  const live = useRef({ offsets, ids, virtual })
  live.current = { offsets, ids, virtual }

  const recalc = useCallback(() => {
    const anchor = anchorRef.current
    if (!anchor || !live.current.virtual) return
    const scroller = scrollParent(anchor)
    const box = scroller === document.documentElement ? { top: 0, height: window.innerHeight } : scroller.getBoundingClientRect()
    const next = visibleRange(live.current.offsets, box.top - anchor.getBoundingClientRect().top, box.height)
    setRange((r) => (r.start === next.start && r.end === next.end ? r : next))
  }, [])

  // Scrollen und Größenänderung des Fensters
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (!virtual || !anchor) return
    const scroller = scrollParent(anchor)
    const target: HTMLElement | Window = scroller === document.documentElement ? window : scroller
    let frame = 0
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; recalc() }) }
    target.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    recalc()
    return () => { target.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); cancelAnimationFrame(frame) }
  }, [virtual, recalc])

  // Neue Zeilenliste (Suche, Sortierung, neue Zeilen): Bereich neu bestimmen
  useLayoutEffect(() => { recalc() }, [offsets, recalc])

  // Höhen der gezeichneten Zeilen messen und beobachten. Neue Zeilen werden sofort nach dem Zeichnen gemessen (noch vor der
  // Darstellung), später ändern sich Höhen nur noch über den ResizeObserver (z. B. wenn Kacheln umbrechen).
  const observer = useRef<ResizeObserver | null>(null)
  const observed = useRef(new Set<Element>())
  /** Übernimmt gemessene Höhen. Zeilen oberhalb des Sichtbereichs verschieben den Inhalt: der Bildlauf gleicht das aus. */
  const apply = useCallback((measured: [HTMLElement, number][]) => {
    const a = anchorRef.current
    if (!a) return
    const scroller = scrollParent(a)
    const edge = scroller === document.documentElement ? 0 : scroller.getBoundingClientRect().top
    let changed = false, shift = 0
    for (const [el, h] of measured) {
      const id = el.dataset.row
      if (!id) continue
      const old = heights.current.get(id) ?? ESTIMATE
      heights.current.set(id, h)
      if (Math.abs(h - old) < 0.5) continue
      changed = true
      if (el.getBoundingClientRect().top < edge) shift += h - old
    }
    if (shift) { if (scroller === document.documentElement) window.scrollBy(0, shift); else scroller.scrollTop += shift }
    if (changed) setVersion((v) => v + 1)
  }, [])
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (!virtual || !anchor) return
    if (!observer.current) {
      observer.current = new ResizeObserver((entries) =>
        apply(entries.map((e) => [e.target as HTMLElement, e.borderBoxSize?.[0]?.blockSize ?? e.target.getBoundingClientRect().height])))
    }
    const present = new Set(anchor.parentElement!.querySelectorAll<HTMLElement>('[data-row]'))
    const fresh: [HTMLElement, number][] = []
    for (const el of present) {
      if (observed.current.has(el)) continue
      observer.current.observe(el)
      observed.current.add(el)
      fresh.push([el, el.getBoundingClientRect().height])
    }
    for (const el of [...observed.current]) if (!present.has(el as HTMLElement)) { observer.current.unobserve(el); observed.current.delete(el) }
    if (fresh.length) apply(fresh)
  })
  useLayoutEffect(() => () => { observer.current?.disconnect(); observer.current = null; observed.current.clear() }, [])

  /** Scrollt so, dass die Zeile mit diesem Index etwa in der Mitte des sichtbaren Bereichs steht. */
  const scrollToIndex = useCallback((index: number) => {
    const anchor = anchorRef.current
    if (!anchor || !live.current.virtual) return
    const scroller = scrollParent(anchor)
    const box = scroller === document.documentElement ? { top: 0, height: window.innerHeight } : scroller.getBoundingClientRect()
    const relTop = box.top - anchor.getBoundingClientRect().top
    const i = Math.max(0, Math.min(index, live.current.ids.length - 1))
    const delta = live.current.offsets[i] - relTop - box.height / 2
    if (scroller === document.documentElement) window.scrollBy(0, delta); else scroller.scrollTop += delta
  }, [])

  const n = ids.length
  const start = virtual ? Math.min(range.start, n) : 0
  const end = virtual ? Math.min(range.end, n) : n
  return {
    virtual, anchorRef, scrollToIndex, start, end,
    topPad: virtual ? offsets[start] : 0,
    bottomPad: virtual ? offsets[n] - offsets[end] : 0,
  }
}
