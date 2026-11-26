import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './gridFile'

/**
 * Öffnet den Druckdialog (dort auch „Als PDF sichern“). Was auf dem Papier landet, bestimmt `@media print` in styles.css.
 * In der App druckt die native Seite: `window.print()` tut in der Webansicht von macOS und iPadOS nichts.
 */
export async function printPage(): Promise<void> {
  if (isTauri) await invoke('print_page')
  else window.print()
}
