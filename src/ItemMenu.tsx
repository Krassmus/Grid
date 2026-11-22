import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** Touch: so lange muss der Finger liegen bleiben, bis das Kontextmenü erscheint. */
const MENU_HOLD_MS = 450
const SLOP = 10

/**
 * Langes Drücken mit dem Finger: nach einer kurzen Pause ruft `cb` mit der Fingerposition auf (Bewegen vorher = Scrollen,
 * kein Menü). Der Klick, der auf das Loslassen folgt, wird verschluckt, damit das Element nicht zusätzlich öffnet.
 */
export function beginLongPress(down: PointerEvent, cb: (x: number, y: number) => void) {
  if (down.pointerType !== 'touch') return
  let fired = false
  const stop = () => {
    clearTimeout(timer)
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
  }
  const move = (e: PointerEvent) => {
    if (e.pointerId === down.pointerId && Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) > SLOP) stop()
  }
  const up = (e: PointerEvent) => {
    if (e.pointerId !== down.pointerId) return
    stop()
    if (fired) {
      const swallow = (ev: Event) => { ev.stopPropagation(); ev.preventDefault() }
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 400)
    }
  }
  const timer = window.setTimeout(() => { fired = true; cb(down.clientX, down.clientY) }, MENU_HOLD_MS)
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
}

/** Kleines Kontextmenü mit der Option zum Entfernen; schließt beim Tippen daneben. */
export function ItemMenu(props: { x: number; y: number; label: string; onRemove: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: props.x, top: props.y })
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    // über dem Finger, damit er das Menü nicht verdeckt; im Fenster halten
    const top = Math.max(8, Math.min(props.y - r.height - 18, innerHeight - r.height - 8))
    const left = Math.max(8, Math.min(props.x - r.width / 2, innerWidth - r.width - 8))
    setPos({ left, top })
  }, [props.x, props.y])
  useEffect(() => {
    const away = (e: Event) => { if (!ref.current?.contains(e.target as Node)) props.onClose() }
    const t = setTimeout(() => window.addEventListener('pointerdown', away, true), 0) // nicht vom noch gedrückten Finger schließen
    const key = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
    window.addEventListener('keydown', key)
    return () => { clearTimeout(t); window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', key) }
  }, [])
  return createPortal(
    <div ref={ref} className="item-menu" role="menu" style={pos} onContextMenu={(e) => e.preventDefault()} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <button type="button" role="menuitem" className="danger" onClick={() => { props.onClose(); props.onRemove() }}>{props.label}</button>
    </div>,
    document.body,
  )
}
