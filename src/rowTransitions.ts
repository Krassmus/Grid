import { useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * Neue Zeilen wachsen von 0 auf ihre volle Höhe, gelöschte werden von unten her bis auf 0 abgeschnitten; die Zeilen darunter rutschen dabei weich nach.
 * Das gilt für eigene Änderungen genauso wie für solche, die ein Abgleich mitbringt: verglichen wird die gespeicherte
 * Zeilenliste der Tabelle, nicht die Anzeige. Scrollen, Suchen, Sortieren und Tabellenwechsel lösen daher nichts aus.
 *
 * Gelöschte Zeilen sind für React sofort weg. Wir merken uns nach jedem Zeichnen die Elemente und setzen das Element
 * einer gelöschten Zeile für die Dauer der Animation an seine alte Stelle zurück.
 */
const MS = 260
/** Bei sehr vielen auf einmal (z. B. erster Abgleich, Massenlöschen) wird nicht animiert. */
const MAX = 30

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

interface Snapshot { order: string[]; els: Map<string, HTMLElement>; parent: HTMLElement | null }

export function useRowTransitions(root: RefObject<HTMLElement | null>, tableId: string | undefined, rowIds: string[], rendered: string) {
  const prev = useRef<{ table: string | undefined; ids: Set<string> } | null>(null)
  const snap = useRef<Snapshot>({ order: [], els: new Map(), parent: null })

  useLayoutEffect(() => {
    const container = root.current
    const live = container ? Array.from(container.querySelectorAll<HTMLElement>('[data-row]')) : []
    const p = prev.current
    const now = new Set(rowIds)
    if (container && p && p.table === tableId && !reduced() && typeof Element.prototype.animate === 'function') {
      const added = rowIds.filter((id) => !p.ids.has(id))
      const removed = [...p.ids].filter((id) => !now.has(id))
      // der erste Abgleich füllt eine leere Tabelle mit einem Mal: nicht animieren
      const bulk = p.ids.size === 0 && added.length > 1
      if (!bulk && added.length <= MAX) for (const id of added) { const el = live.find((e) => e.dataset.row === id); if (el) enter(el) }
      if (removed.length <= MAX) for (const id of removed) {
        const el = snap.current.els.get(id)
        if (el && !el.isConnected) exit(el, id, container, snap.current)
      }
    }
    prev.current = { table: tableId, ids: now }
    snap.current = {
      order: live.map((e) => e.dataset.row!),
      els: new Map(live.map((e) => [e.dataset.row!, e])),
      parent: live[0]?.parentElement ?? (snap.current.parent?.isConnected ? snap.current.parent : null),
    }
  }, [root, tableId, rowIds, rendered]) // eslint-disable-line react-hooks/exhaustive-deps
}

function enter(el: HTMLElement) {
  const h = el.offsetHeight
  el.style.overflow = 'clip'
  const anim = el.animate(
    [{ height: '0px' }, { height: `${h}px` }],
    { duration: MS, easing: 'ease-out' },
  )
  anim.onfinish = anim.oncancel = () => {
    el.style.overflow = ''
    // Hat man die Zeile selbst angelegt (Fokus darin), soll sie ganz im Bild sein
    if (el.contains(document.activeElement)) el.scrollIntoView({ block: 'nearest' })
  }
}

function exit(el: HTMLElement, id: string, container: HTMLElement, snapshot: Snapshot) {
  // an die alte Stelle zurück: vor die nächste noch vorhandene Zeile, sonst ans Ende der Zeilen
  let ref: Element | null = null
  for (let i = snapshot.order.indexOf(id) + 1; i > 0 && i < snapshot.order.length; i++) {
    const next = container.querySelector(`[data-row="${CSS.escape(snapshot.order[i])}"]`)
    if (next) { ref = next; break }
  }
  const parent = ref?.parentElement ?? (snapshot.parent?.isConnected ? snapshot.parent : null)
  if (!parent) return
  if (!ref) ref = parent.querySelector(':scope > .grid-foot')
  parent.insertBefore(el, ref)
  const h = el.offsetHeight
  el.style.pointerEvents = 'none'
  el.style.overflow = 'clip'
  el.inert = true
  const anim = el.animate(
    [{ height: `${h}px`, borderBottomWidth: '1px' }, { height: '0px', borderBottomWidth: '0px' }],
    { duration: MS, easing: 'ease-in', fill: 'forwards' },
  )
  anim.onfinish = anim.oncancel = () => el.remove()
}
