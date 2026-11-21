import { isTauri } from './gridFile'

/** Öffnet eine Web-Adresse im Browser des Benutzers (nur http und https). */
export async function openExternal(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return
  if (isTauri) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
  } else {
    window.open(url, '_blank', 'noopener')
  }
}
