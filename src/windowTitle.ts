/** Setzt den Fenstertitel: in Tauri die native Titelleiste, im Browser den Tab-Titel. */
export async function setWindowTitle(docName: string) {
  const title = `Grid - ${docName}`
  document.title = title
  if ('__TAURI_INTERNALS__' in window) {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await getCurrentWindow().setTitle(title)
    } catch (e) {
      console.warn('Fenstertitel konnte nicht gesetzt werden', e)
    }
  }
}
