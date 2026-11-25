import { getCurrentWebview } from '@tauri-apps/api/webview'
import { isTauri } from './gridFile'

/**
 * Größe der Oberfläche. In der App skaliert der Seitenzoom der Webansicht alles wie ⌘+ im Browser: Das Layout rechnet mit
 * dem schmaleren Fenster, Mauspositionen und Maße bleiben stimmig. Die Einstellung gilt je Gerät.
 */
// Die Enden liegen bewusst jenseits dessen, was man dauerhaft nutzt: So lässt sich der passende Wert eingrenzen.
export const ZOOM_STEPS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]
const KEY = 'grid-zoom'

export const zoomLabel = (factor: number) => `${Math.round(factor * 100)} %`

export const isZoomStep = (v: unknown): v is number => typeof v === 'number' && ZOOM_STEPS.includes(v)

export function readZoom(): number {
  try {
    const v = Number(localStorage.getItem(KEY))
    return isZoomStep(v) ? v : 1
  } catch { return 1 }
}

export function applyZoom(factor: number) {
  if (isTauri) void getCurrentWebview().setZoom(factor).catch((e) => console.error('zoom', e))
  // Nur zum Entwickeln im Browser: CSS-Zoom kommt dem nahe, rechnet aber Fensterhöhen (vh) nicht mit um.
  else if (typeof document !== 'undefined') document.documentElement.style.zoom = factor === 1 ? '' : String(factor)
}

/** Wählt die Größe: merkt sie sich und wendet sie an. */
export function setZoom(factor: number) {
  try { localStorage.setItem(KEY, String(factor)) } catch { /* egal */ }
  applyZoom(factor)
}

/** Beim Start: gemerkte Größe anwenden. Bei 100 % bleibt die Webansicht unberührt. */
export function initZoom() {
  const factor = readZoom()
  if (factor !== 1) applyZoom(factor)
}
