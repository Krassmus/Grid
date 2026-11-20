import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url' // der Worker muss als eigene Datei im Build liegen
import { TILE_ATTRIBUTION, TILE_URL } from './geo'

/** Vektorkarte auf Basis von OpenStreetMap (OpenFreeMap, ohne Schlüssel); bei Bedarf hier austauschen. */
export const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty'
const ATTRIBUTION = `${TILE_ATTRIBUTION}, <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>`

/**
 * Legt die Grundkarte unter eine Leaflet-Karte: Vektordarstellung (auf jedem Bildschirm scharf, Schrift in normaler Größe).
 * Ohne WebGL fällt sie auf die Bildkacheln von OpenStreetMap zurück.
 */
export async function addBaseMap(L: any, map: any): Promise<void> {
  try {
    const [{ maplibreGL }, maplibre] = await Promise.all([import('@maplibre/maplibre-gl-leaflet'), import('maplibre-gl')])
    maplibre.setWorkerUrl(workerUrl)
    maplibreGL({ style: MAP_STYLE, attribution: ATTRIBUTION } as any).addTo(map)
  } catch {
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(map)
  }
}
