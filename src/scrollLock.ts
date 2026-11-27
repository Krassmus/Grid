import { invoke } from '@tauri-apps/api/core'
import { isIOS } from './platform'

/**
 * iPad und iPhone: beim Wischen die Achse sperren (src-tauri/src/ios_view.rs). Die native Seite sperrt, was es gerade an
 * Scrollbereichen gibt; neue entstehen erst bei Bedarf, darum bei jeder Berührung (auch beim Loslassen, damit ein eben erst
 * entstandener Bereich schon vor der nächsten Geste gesperrt ist).
 */
export function initScrollLock() {
  if (!isIOS) return
  const lock = () => { void invoke('lock_scroll_axes').catch((e) => console.error('scroll lock', e)) }
  for (const type of ['touchstart', 'touchend'] as const) document.addEventListener(type, lock, { capture: true, passive: true })
}
