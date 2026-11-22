import { isTauri } from './gridFile'

/**
 * Touch-Gerät mit der App (iPad, iPhone, Android): keine Menüleiste, keine frei wählbaren Speicherorte.
 * Dann gibt es eine Dokumentenliste statt der Menübefehle. Im Browser zum Ausprobieren: `?mobile` an die Adresse hängen.
 */
export const isMobileUI: boolean = (() => {
  if (typeof navigator === 'undefined' || typeof location === 'undefined') return false
  if (!isTauri) return new URLSearchParams(location.search).has('mobile')
  // iPadOS meldet sich als Mac, hat aber im Gegensatz zum Mac einen Touchscreen
  return /iPad|iPhone|iPod|Android/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
})()
