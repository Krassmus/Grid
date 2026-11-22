/**
 * GPS-Verfolgung: Hält eine Geokoordinaten-Zelle dauerhaft auf dem aktuellen Standort des Geräts.
 * Läuft unabhängig von Dialogen, solange das Dokument geöffnet ist. Es gibt höchstens eine Verfolgung.
 */
import { useSyncExternalStore } from 'react'
import type * as Y from 'yjs'
import { encodeGeo, type LatLon } from './geo'
import { setCell, tablesOf } from './model'

export interface TrackTarget {
  doc: Y.Doc
  tableId: string
  rowId: string
  colId: string
  tableName: string
  colName: string
  rowLabel: string
}
export interface TrackState {
  target: TrackTarget
  /** Beginn (ms) */
  since: number
  /** Letzte gespeicherte Position und Zeitpunkt */
  last: { point: LatLon; at: number } | null
  error: string | null
}

/** Mindestabstand (m) und -zeit (ms) zwischen zwei Schreibvorgängen: Jede Änderung wandert in den Abgleich. */
const MIN_METERS = 4, MIN_MS = 5000

const round7 = (p: LatLon): LatLon => ({ lat: Math.round(p.lat * 1e7) / 1e7, lon: Math.round(p.lon * 1e7) / 1e7 })

export function distanceMeters(a: LatLon, b: LatLon): number {
  const R = 6371008.8, rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

let state: TrackState | null = null
let watchId: number | null = null
const listeners = new Set<() => void>()
const emit = (next: TrackState | null) => { state = next; listeners.forEach((l) => l()) }

export const currentTracking = () => state

function rowExists(t: TrackTarget) {
  return !!tablesOf(t.doc).get(t.tableId)?.get('rows').get(t.rowId)
}

export function stopTracking() {
  if (watchId != null) navigator.geolocation?.clearWatch(watchId)
  watchId = null
  if (state) emit(null)
}

/** Schreibt eine Position in die Zielzelle, wenn sie weit oder lange genug zurückliegt. Gibt zurück, ob geschrieben wurde. */
export function applyFix(p: LatLon, now = Date.now()): boolean {
  const s = state
  if (!s) return false
  if (!rowExists(s.target)) { fail('Die Zeile gibt es nicht mehr.'); return false }
  if (s.last && (now - s.last.at < MIN_MS || distanceMeters(s.last.point, p) < MIN_METERS)) return false
  const point = round7(p)
  const t = s.target
  setCell(t.doc, t.tableId, t.rowId, t.colId, encodeGeo(point))
  emit({ ...s, last: { point, at: now }, error: null })
  return true
}

function fail(message: string) {
  if (watchId != null) navigator.geolocation?.clearWatch(watchId)
  watchId = null
  if (state) emit({ ...state, error: message })
}

export function startTracking(target: TrackTarget) {
  stopTracking()
  if (!navigator.geolocation) throw new Error('Dieses Gerät kann den Standort nicht ermitteln.')
  emit({ target, since: Date.now(), last: null, error: null })
  watchId = navigator.geolocation.watchPosition(
    (g) => { applyFix({ lat: g.coords.latitude, lon: g.coords.longitude }) },
    (e) => { if (e.code === e.PERMISSION_DENIED) fail('Der Zugriff auf den Standort ist nicht erlaubt (Einstellungen des Geräts).') /* sonst: kurzer Funkausfall, weiter warten */ },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 },
  )
}

export function useTracking(): TrackState | null {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => state)
}
