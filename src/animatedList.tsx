import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/**
 * Animiertes Ein-/Ausblenden von Listeneinträgen (Kacheln, Datei-Chips) in 300 ms:
 *  - neu: wächst von links nach rechts auf seine Breite, Opacity 0 → 1
 *  - entfernt: wird von rechts abgeschnitten, bis er weg ist, Opacity 1 → 0
 * Die Breite ändert sich dabei kontinuierlich, dadurch passt sich auch die Spaltenbreite fließend an.
 * Beim ersten Anzeigen der Liste (Seitenaufbau, Tabellenwechsel) wird nicht animiert.
 */
export const ANIM_MS = 300

export type Phase = 'enter' | 'idle' | 'exit'
export interface AnimEntry<T> { key: string; item: T; phase: Phase }

interface Ghost<T> { key: string; item: T; index: number }

export function useAnimatedList<T>(items: T[], keyOf: (t: T) => string) {
  const [ghosts, setGhosts] = useState<Ghost<T>[]>([])
  const prevItems = useRef<T[] | null>(null)
  const known = useRef<Set<string>>(new Set())
  const initial = useRef(true)

  const currentKeys = new Set(items.map(keyOf))
  const entries: AnimEntry<T>[] = items.map((item) => {
    const key = keyOf(item)
    return { key, item, phase: !initial.current && !known.current.has(key) ? 'enter' : 'idle' }
  })
  // Entfernte Einträge an ihrer alten Position als „Geist“ weiter anzeigen, bis die Ausblend-Animation fertig ist.
  const live = ghosts.filter((g) => !currentKeys.has(g.key)).sort((a, b) => a.index - b.index)
  for (const g of live) entries.splice(Math.min(g.index, entries.length), 0, { key: g.key, item: g.item, phase: 'exit' })

  useLayoutEffect(() => {
    const prev = prevItems.current
    if (prev) {
      const removed = prev
        .map((item, index) => ({ item, key: keyOf(item), index }))
        .filter((x) => !currentKeys.has(x.key))
      if (removed.length || ghosts.some((g) => currentKeys.has(g.key))) {
        setGhosts((g) => [...g.filter((x) => !currentKeys.has(x.key) && !removed.some((r) => r.key === x.key)), ...removed])
      }
    }
    prevItems.current = items
    known.current = currentKeys // nur aktuelle Schlüssel: ein wieder hinzugefügter Eintrag zählt als neu
    initial.current = false
  })

  const done = (key: string) => setGhosts((g) => g.filter((x) => x.key !== key))
  return { entries, done }
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export function AnimItem(props: { phase: Phase; onExited: () => void; children: ReactNode }) {
  const { phase } = props
  const ref = useRef<HTMLDivElement>(null)
  const running = useRef<{ anim: Animation; kind: Phase } | null>(null)
  const onExited = useRef(props.onExited)
  onExited.current = props.onExited

  const reset = () => {
    const el = ref.current
    const inner = el?.firstElementChild as HTMLElement | null
    if (el) el.style.overflowX = ''
    if (inner) { inner.style.width = ''; inner.style.flex = '' }
  }

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (phase === 'idle') {
      // Taucht ein gerade ausblendender Eintrag wieder auf: Ausblenden abbrechen. Einblenden läuft weiter.
      if (running.current?.kind === 'exit') { running.current.anim.cancel(); running.current = null; reset() }
      return
    }
    if (running.current) { running.current.anim.cancel(); running.current = null; reset() } // z. B. Ausblenden → Einblenden
    if (reducedMotion() || typeof el.animate !== 'function') { if (phase === 'exit') onExited.current(); return }

    const inner = el.firstElementChild as HTMLElement
    const w = inner.offsetWidth // natürliche Breite, bevor eingeschränkt wird
    inner.style.width = `${w}px` // Inhalt behält seine Breite, der Wrapper schneidet nur ab
    inner.style.flex = 'none'
    el.style.overflowX = 'clip'
    const frames = [{ width: '0px', opacity: 0 }, { width: `${w}px`, opacity: 1 }]
    const anim = el.animate(phase === 'enter' ? frames : [...frames].reverse(), {
      duration: ANIM_MS,
      easing: 'ease',
      fill: phase === 'exit' ? 'forwards' : 'none',
    })
    running.current = { anim, kind: phase }
    anim.onfinish = () => {
      running.current = null
      reset()
      if (phase === 'exit') onExited.current()
    }
  }, [phase])

  useLayoutEffect(() => () => { running.current?.anim.cancel() }, [])

  return (
    <div ref={ref} className="anim-item" style={phase === 'exit' ? { pointerEvents: 'none' } : undefined}>
      <div className="anim-inner">{props.children}</div>
    </div>
  )
}
