import type { LinkSlot } from './model'

/**
 * Ziehen von Relationskacheln mit eigener Mausverfolgung statt HTML5-Drag-and-Drop: Während eines nativen Drags melden
 * Browser Tastendrücke nicht mehr, Umschalt/Alt zum Kopieren ließe sich dann nur vor dem Ziehen wählen. Hier gilt die
 * Taste, die beim Loslassen (und für die Anzeige jederzeit während des Ziehens) gedrückt ist.
 */
export interface DragPayload { slot: LinkSlot; targetRow: string; targetTable?: string }

/** Ablageziel, z. B. eine Relationszelle. Koordinaten sind Fensterkoordinaten. */
export interface DropTarget {
  accepts(p: DragPayload): boolean
  hover(x: number, y: number, copy: boolean, p: DragPayload): void
  leave(): void
  drop(x: number, y: number, copy: boolean, p: DragPayload): void
}

const targets = new WeakMap<Element, DropTarget>()
/** Meldet ein Element als Ablageziel an; liefert die Abmeldung. */
export function registerDropTarget(el: Element, t: DropTarget): () => void {
  targets.set(el, t)
  return () => { if (targets.get(el) === t) targets.delete(el) }
}

const MOVE_THRESHOLD = 5
const EDGE = 48
/** Touch: so lange muss der Finger auf der Kachel liegen bleiben, bis sie sich ziehen lässt (kürzer = Tippen/Scrollen). */
const HOLD_MS = 350
/** Touch: bewegt sich der Finger vorher weiter als das, will er scrollen und nicht ziehen. */
const TOUCH_SLOP = 10

function targetAt(x: number, y: number, p: DragPayload): { el: Element; t: DropTarget } | null {
  for (let n = document.elementFromPoint(x, y); n; n = n.parentElement) {
    const t = targets.get(n)
    if (t) return t.accepts(p) ? { el: n, t } : null
  }
  return null
}

const scrollParent = (el: Element | null): HTMLElement | null => {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY
    if (o === 'auto' || o === 'scroll') return p
  }
  return null
}

/**
 * Beginnt, auf einen Mausdruck hin eine Kachel zu ziehen (erst nach ein paar Pixeln Bewegung; ein Klick bleibt ein Klick).
 * Mit dem Finger: Kachel gedrückt halten, bis sie „abhebt“, dann ziehen; wer gleich wegwischt, scrollt nur. Ein zweiter Finger
 * auf dem Bildschirm wirkt wie die Umschalttaste (Kopieren).
 */
export function beginTileDrag(down: PointerEvent, tile: HTMLElement, payload: DragPayload) {
  if (down.button !== 0) return
  const touch = down.pointerType === 'touch'
  if ((down.target as HTMLElement).closest('.tile-x')) return
  const rect = tile.getBoundingClientRect()
  const grab = { x: down.clientX - rect.left, y: down.clientY - rect.top }
  let ghost: HTMLElement | null = null
  let host: HTMLElement | null = null // trägt das Aussehen einer Zelle (.c .tiles), damit die Kopie genauso gestaltet ist wie das Original
  let hover: { el: Element; t: DropTarget } | null = null
  let pos = { x: down.clientX, y: down.clientY }
  let copy = false
  let frame = 0
  let holdTimer = 0
  let origin = { x: down.clientX, y: down.clientY } // wo das Ziehen begann
  let travelled = false // Touch: hat sich der Finger seit dem Abheben bewegt?

  const setHover = (next: { el: Element; t: DropTarget } | null) => {
    if (hover && hover.el !== next?.el) hover.t.leave()
    hover = next
  }
  const refresh = () => {
    if (!ghost) return
    if (host) host.style.transform = `translate(${pos.x - grab.x}px, ${pos.y - grab.y}px)`
    ghost.classList.toggle('copy', copy)
    document.body.classList.toggle('tile-copy', copy)
    const found = targetAt(pos.x, pos.y, payload)
    setHover(found)
    found?.t.hover(pos.x, pos.y, copy, payload)
  }
  const autoScroll = () => {
    frame = 0
    if (!ghost) return
    const sc = scrollParent(hover?.el ?? document.elementFromPoint(pos.x, pos.y))
    if (!sc) return
    const r = sc.getBoundingClientRect()
    const dy = pos.y < r.top + EDGE ? -14 : pos.y > r.bottom - EDGE ? 14 : 0
    if (dy) { sc.scrollTop += dy; refresh(); frame = requestAnimationFrame(autoScroll) }
  }
  const start = () => {
    origin = { ...pos }
    ghost = tile.cloneNode(true) as HTMLElement
    ghost.classList.add('tile-ghost')
    ghost.style.width = `${rect.width}px`
    ghost.style.height = `${rect.height}px`
    host = document.createElement('div')
    host.className = 'c tile-ghost-host'
    const row = document.createElement('div')
    row.className = 'tiles'
    row.appendChild(ghost)
    host.appendChild(row)
    document.body.appendChild(host)
    tile.classList.add('dragging')
    document.body.classList.add('tile-dragging')
    window.getSelection()?.removeAllRanges()
  }
  const end = () => {
    clearTimeout(holdTimer)
    window.removeEventListener('touchmove', block)
    window.removeEventListener('pointerdown', second)
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('keydown', key)
    window.removeEventListener('keyup', key)
    cancelAnimationFrame(frame)
    setHover(null)
    host?.remove()
    host = null
    tile.classList.remove('dragging')
    document.body.classList.remove('tile-dragging', 'tile-copy')
    if (ghost) {
      // der Klick, der auf das Loslassen folgt, darf die Kachel nicht öffnen
      const swallow = (e: Event) => { e.stopPropagation(); e.preventDefault() }
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
    }
    ghost = null
  }
  const move = (e: PointerEvent) => {
    if (e.pointerId !== down.pointerId) return
    pos = { x: e.clientX, y: e.clientY }
    if (!touch) copy = e.shiftKey || e.altKey
    if (!ghost) {
      const dist = Math.hypot(pos.x - down.clientX, pos.y - down.clientY)
      if (touch) { if (dist > TOUCH_SLOP) end(); return } // Finger wandert vor dem Abheben: Scrollen, kein Ziehen
      if (dist < MOVE_THRESHOLD) return
      start()
    }
    if (touch && Math.hypot(pos.x - origin.x, pos.y - origin.y) > MOVE_THRESHOLD) travelled = true
    refresh()
    if (!frame) frame = requestAnimationFrame(autoScroll)
  }
  const up = (e: PointerEvent) => {
    if (e.pointerId !== down.pointerId) return
    pos = { x: e.clientX, y: e.clientY }
    if (!touch) copy = e.shiftKey || e.altKey // maßgeblich ist der Zustand beim Loslassen
    // Touch: wer die Kachel nur hochgehoben und wieder losgelassen hat, lässt sie, wo sie ist
    const found = ghost && (!touch || travelled) ? targetAt(pos.x, pos.y, payload) : null
    if (ghost) found?.t.drop(pos.x, pos.y, copy, payload)
    hover = null // schon abgeschlossen: kein leave() mehr
    end()
  }
  const cancel = (e?: PointerEvent) => { if (!e || e.pointerId === down.pointerId) end() }
  /** Touch: Solange gezogen wird, darf die Seite nicht mitscrollen. */
  const block = (e: TouchEvent) => { if (ghost && e.cancelable) e.preventDefault() }
  /** Touch: ein zweiter Finger schaltet auf Kopieren. */
  const second = (e: PointerEvent) => { if (ghost && e.pointerId !== down.pointerId) { copy = true; refresh() } }
  const key = (e: KeyboardEvent) => {
    if (e.type === 'keydown' && e.key === 'Escape') { cancel(); return }
    if (e.key === 'Shift' || e.key === 'Alt') { copy = e.shiftKey || e.altKey; refresh() }
  }
  if (touch) {
    window.addEventListener('touchmove', block, { passive: false })
    window.addEventListener('pointerdown', second)
    holdTimer = window.setTimeout(() => { pos = { x: down.clientX, y: down.clientY }; start(); refresh() }, HOLD_MS)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('keydown', key)
  window.addEventListener('keyup', key)
}
