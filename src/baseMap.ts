import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url' // der Worker muss als eigene Datei im Build liegen
import { tileAttribution, TILE_URL } from './geo'
import { isDark, onThemeChange } from './theme'

/** Vektorkarte auf Basis von OpenStreetMap (OpenFreeMap, ohne Schlüssel); bei Bedarf hier austauschen. */
export const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty'
/** Dieselben Daten im dunklen Erscheinungsbild. */
export const MAP_STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark'
const attribution = () => `${tileAttribution()}, <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>`

/**
 * Legt die Grundkarte unter eine Leaflet-Karte: Vektordarstellung (auf jedem Bildschirm scharf, Schrift in normaler Größe).
 * Ohne WebGL fällt sie auf die Bildkacheln von OpenStreetMap zurück.
 */
export async function addBaseMap(L: any, map: any): Promise<void> {
  try {
    const [{ maplibreGL }, maplibre] = await Promise.all([import('@maplibre/maplibre-gl-leaflet'), import('maplibre-gl')])
    maplibre.setWorkerUrl(workerUrl)
    // Stil nach Erscheinungsbild; bei einem Wechsel wird die Grundkarte ausgetauscht (bis die Karte entfernt wird)
    let layer: any
    const add = () => { layer?.remove(); layer = maplibreGL({ style: isDark() ? MAP_STYLE_DARK : MAP_STYLE, attribution: attribution() } as any).addTo(map) }
    add()
    const off = onThemeChange(add)
    map.on('unload', off)
  } catch {
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: tileAttribution() }).addTo(map)
  }
}
