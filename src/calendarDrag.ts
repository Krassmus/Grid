/**
 * Ziehen auf der Zeitleiste (docs/KALENDER.md): über eine freie Stelle (neuer Eintrag) oder an einem Balken (verschieben,
 * Dauer ändern). Maus und Stift ziehen sofort. Mit dem Finger bleibt Wischen Scrollen: erst nach kurzem Liegenlassen
 * beginnt das Ziehen.
 */

/** So lange muss der Finger liegen bleiben (wie beim langen Drücken sonst in Grid) */
const HOLD_MS = 450
/** So weit darf er dabei wackeln */
const TOUCH_SLOP = 10
/** Ab dieser Strecke ist ein Mausklick ein Ziehen */
const MOUSE_SLOP = 5
/** So nah am Rand rückt die Zeitleiste beim Ziehen nach */
const EDGE = 36
/** Höhe der Zeitachse, die oben stehen bleibt */
const HEAD = 48

export interface TimelineDrag {
  scroller: HTMLElement
  /** Breite der feststehenden Spalte links; dort beginnt die Zeitachse */
  laneWidth: () => number
  /** Zeitpunkt unter dieser waagerechten Bildschirmposition */
  timeAt: (clientX: number) => number
  onChange: (anchor: number, head: number, pointer: { x: number; y: number }) => void
  /** `null`: abgebrochen */
  onEnd: (range: { anchor: number; head: number } | null) => void
  /** An einem Balken: auch senkrechtes Ziehen zählt (in eine andere Zeile), und die Liste rückt auch nach oben und unten nach */
  anyDirection?: boolean
  /** Finger lange liegen gelassen und ohne Ziehen abgehoben (statt `onEnd` mit einem Bereich) */
  onHold?: (x: number, y: number) => void
}

/** Beginnt (vielleicht) eine Auswahl; liefert eine Funktion, die sie abbricht. */
export function beginTimelineDrag(down: PointerEvent, drag: TimelineDrag): () => void {
  const touch = down.pointerType === 'touch'
  if (!touch && down.button !== 0) return () => {}
  let active = false, finished = false
  const anchor = drag.timeAt(down.clientX)
  let x = down.clientX, y = down.clientY, direction = 0, vertical = 0
  let travelled = false
  let head = anchor
  let timer = 0, scrolling = 0

  const update = () => {
    head = drag.timeAt(x)
    drag.onChange(anchor, head, { x, y })
  }
  const start = () => {
    active = true
    document.body.classList.add('cal-dragging')
    window.getSelection()?.removeAllRanges()
    // Am Rand weiterrücken, aber nur in die Richtung, in die gezogen wird: sonst liefe die Achse los, wenn man nah am Rand beginnt
    scrolling = window.setInterval(() => {
      const box = drag.scroller.getBoundingClientRect()
      const over = direction > 0 ? x - (box.right - EDGE) : direction < 0 ? box.left + drag.laneWidth() + EDGE - x : 0
      const overY = vertical > 0 ? y - (box.bottom - EDGE) : vertical < 0 ? box.top + HEAD + EDGE - y : 0
      if (over > 0) drag.scroller.scrollLeft += direction * Math.min(24, 4 + over / 3)
      if (overY > 0) drag.scroller.scrollTop += vertical * Math.min(16, 3 + overY / 3)
      if (over > 0 || overY > 0) update()
    }, 30)
    update()
  }
  const finish = (result: boolean) => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    clearInterval(scrolling)
    document.body.classList.remove('cal-dragging')
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('keydown', key, true)
    window.removeEventListener('touchmove', block)
    // `touchend` kommt erst nach `pointerup`
    setTimeout(() => window.removeEventListener('touchend', quiet), 100)
    if (!active) return
    // Nach dem Ziehen mit der Maus folgt ein Klick; er darf den Balken unter dem Zeiger nicht öffnen
    const swallow = (ev: Event) => { ev.stopPropagation(); ev.preventDefault() }
    window.addEventListener('click', swallow, { capture: true, once: true })
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 50)
    if (result && touch && !travelled && drag.onHold) { drag.onEnd(null); drag.onHold(x, y) }
    else drag.onEnd(result ? { anchor, head } : null)
  }
  const move = (e: PointerEvent) => {
    if (e.pointerId !== down.pointerId) return
    const dx = e.clientX - down.clientX, dy = e.clientY - down.clientY
    if (!active) {
      if (touch) { if (Math.hypot(dx, dy) > TOUCH_SLOP) finish(false) } // Finger wandert vor Ablauf der Pause: Scrollen
      else if ((drag.anyDirection ? Math.hypot(dx, dy) : Math.abs(dx)) > MOUSE_SLOP) {
        x = e.clientX; y = e.clientY; direction = Math.sign(dx); vertical = drag.anyDirection ? Math.sign(dy) : 0
        travelled = true
        start()
      }
      return
    }
    // Beim Finger zählt erst eine deutliche Strecke als Ziehen, sonst wäre jedes Zittern eines
    if (!travelled && Math.hypot(dx, dy) <= TOUCH_SLOP) return
    travelled = true
    if (e.clientX !== x) direction = Math.sign(e.clientX - x)
    if (drag.anyDirection && Math.abs(e.clientY - y) > 1) vertical = Math.sign(e.clientY - y)
    x = e.clientX
    y = e.clientY
    update()
  }
  const up = (e: PointerEvent) => { if (e.pointerId === down.pointerId) finish(true) }
  const cancel = (e: PointerEvent) => { if (e.pointerId === down.pointerId) finish(false) }
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false) } }
  const block = (e: TouchEvent) => { if (active) e.preventDefault() }
  // Sonst schickt der Browser nach dem Loslassen noch Mausereignisse nach, und die träfen schon den neuen Dialog
  const quiet = (e: TouchEvent) => { if (active && e.cancelable) e.preventDefault() }

  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('keydown', key, true)
  if (touch) {
    window.addEventListener('touchmove', block, { passive: false })
    window.addEventListener('touchend', quiet, { passive: false })
    timer = window.setTimeout(start, HOLD_MS)
  } else down.preventDefault() // kein Markieren von Text
  return () => finish(false)
}
