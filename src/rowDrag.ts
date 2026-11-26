/**
 * Zeilen von Hand umsortieren (Standardsortierung „Manuell“): am Anfasser ziehen, mit Maus, Stift oder Finger.
 * Gezogen wird über Zeilen-IDs, nicht über Elemente: Große Tabellen zeichnen beim Scrollen nur einen Ausschnitt.
 */
const THRESHOLD = 4
const EDGE = 56

export function beginRowDrag(down: PointerEvent, handle: HTMLElement, rowId: string, props: {
  /** Behälter der Zeilen (Elemente mit `data-row`) */
  root: () => HTMLElement | null
  /** Alle Zeilen in ihrer Reihenfolge */
  ids: () => string[]
  /** Loslassen: vor diese Zeile (`null`: ans Ende) */
  onDrop: (beforeId: string | null) => void
}) {
  if (down.button !== 0) return
  down.preventDefault() // keine Textauswahl
  const scroller = handle.closest<HTMLElement>('.gridscroll')
  let y = down.clientY, dragging = false, frame = 0
  let target: { before: string | null } | null = null
  let line: HTMLElement | null = null

  const rows = () => Array.from(props.root()?.querySelectorAll<HTMLElement>('[data-row]') ?? []).filter((el) => !el.inert)
  const mark = () => {
    for (const el of rows()) el.classList.toggle('row-dragged', el.dataset.row === rowId)
  }
  const refresh = () => {
    mark()
    const list = rows()
    if (!list.length || !line) return
    const next = list.find((el) => { const r = el.getBoundingClientRect(); return y < r.top + r.height / 2 })
    const ids = props.ids()
    const last = list[list.length - 1]
    // unter der letzten gezeichneten Zeile: vor die darauf folgende (oder ans Ende)
    target = { before: next ? next.dataset.row! : ids[ids.indexOf(last.dataset.row!) + 1] ?? null }
    const box = (next ?? last).getBoundingClientRect()
    const top = next ? box.top : box.bottom
    const view = scroller?.getBoundingClientRect()
    line.style.top = `${view ? Math.min(view.bottom, Math.max(view.top, top)) : top}px`
    line.style.left = `${Math.max(box.left, view?.left ?? 0)}px`
    line.style.width = `${Math.min(box.width, view?.width ?? box.width)}px`
  }
  const autoScroll = () => {
    frame = 0
    if (!dragging || !scroller) return
    const r = scroller.getBoundingClientRect()
    const head = scroller.querySelector('.grid-head')?.getBoundingClientRect().height ?? 0
    const dy = y < r.top + head + EDGE ? -12 : y > r.bottom - EDGE ? 12 : 0
    if (!dy) return
    const was = scroller.scrollTop
    scroller.scrollTop += dy
    refresh()
    if (scroller.scrollTop !== was) frame = requestAnimationFrame(autoScroll)
  }
  const end = (drop: boolean) => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('keydown', key)
    cancelAnimationFrame(frame)
    line?.remove()
    line = null
    document.body.classList.remove('row-dragging')
    for (const el of rows()) el.classList.remove('row-dragged')
    if (drop && dragging && target) props.onDrop(target.before)
    dragging = false
  }
  const move = (e: PointerEvent) => {
    if (e.pointerId !== down.pointerId) return
    y = e.clientY
    if (!dragging) {
      if (Math.abs(y - down.clientY) < THRESHOLD) return
      dragging = true
      ;(document.activeElement as HTMLElement | null)?.blur?.()
      line = document.createElement('div')
      line.className = 'row-drop-line'
      document.body.appendChild(line)
      document.body.classList.add('row-dragging')
    }
    refresh()
    if (!frame) frame = requestAnimationFrame(autoScroll)
  }
  const up = (e: PointerEvent) => { if (e.pointerId === down.pointerId) { y = e.clientY; if (dragging) refresh(); end(true) } }
  const cancel = (e: PointerEvent) => { if (e.pointerId === down.pointerId) end(false) }
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') end(false) }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('keydown', key)
}
