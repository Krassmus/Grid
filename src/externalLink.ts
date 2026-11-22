import { isTauri } from './gridFile'

/** Öffnet eine Web-Adresse im Browser des Benutzers (http, https), eine E-Mail (mailto) oder eine Telefonnummer (tel). */
export async function openExternal(url: string): Promise<void> {
  if (!/^(https?:\/\/|mailto:|tel:)/i.test(url)) return
  if (isTauri) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
  } else if (/^(mailto|tel):/i.test(url)) {
    window.location.href = url
  } else {
    window.open(url, '_blank', 'noopener')
  }
}
