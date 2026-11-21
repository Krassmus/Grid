/**
 * Geokoordinaten: Gespeichert wird stets einheitlich als WGS84-Dezimalgrad `"Breite,Länge"` (7 Nachkommastellen, ca. 1 cm).
 * Das Format ist reine Anzeige- und Eingabesache: Dezimalgrad, Länge/Breite, Grad-Minuten-Sekunden, Grad-Dezimalminuten, UTM.
 */

export interface LatLon { lat: number; lon: number }

export type GeoFormat = 'dd' | 'lonlat' | 'dms' | 'dm' | 'utm' | 'map'
export const GEO_FORMATS: { id: GeoFormat; label: string; example: string }[] = [
  { id: 'map', label: 'Kleine Karte', example: '' },
  { id: 'dd', label: 'Dezimalgrad (Breite, Länge)', example: '52.37052, 9.73219' },
  { id: 'lonlat', label: 'Dezimalgrad (Länge, Breite)', example: '9.73219, 52.37052' },
  { id: 'dms', label: 'Grad, Minuten, Sekunden (GPS)', example: '52°22\'13.9"N 9°43\'55.9"E' },
  { id: 'dm', label: 'Grad, Dezimalminuten (GPS)', example: '52°22.232\'N 9°43.932\'E' },
  { id: 'utm', label: 'UTM', example: '32U 549260 5800540' },
]

// ---------- Speicherformat ----------

export const encodeGeo = (p: LatLon): string => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`

export function decodeGeo(v: unknown): LatLon | null {
  if (typeof v !== 'string') return null
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(v)
  if (!m) return null
  const lat = Number(m[1]), lon = Number(m[2])
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null
}

// ---------- UTM (WGS84, Krüger-Reihe, Genauigkeit im Millimeterbereich) ----------

const A = 6378137
const F = 1 / 298.257223563
const K0 = 0.9996
const N = F / (2 - F)
const AA = (A / (1 + N)) * (1 + N ** 2 / 4 + N ** 4 / 64)
const ALPHA = [N / 2 - (2 * N ** 2) / 3 + (5 * N ** 3) / 16 + (41 * N ** 4) / 180, (13 * N ** 2) / 48 - (3 * N ** 3) / 5 + (557 * N ** 4) / 1440, (61 * N ** 3) / 240 - (103 * N ** 4) / 140, (49561 * N ** 4) / 161280]
const BETA = [N / 2 - (2 * N ** 2) / 3 + (37 * N ** 3) / 96 - N ** 4 / 360, N ** 2 / 48 + N ** 3 / 15 - (437 * N ** 4) / 1440, (17 * N ** 3) / 480 - (37 * N ** 4) / 840, (4397 * N ** 4) / 161280]
const DELTA = [2 * N - (2 * N ** 2) / 3 - 2 * N ** 3 + (116 * N ** 4) / 45, (7 * N ** 2) / 3 - (8 * N ** 3) / 5 - (227 * N ** 4) / 45, (56 * N ** 3) / 15 - (136 * N ** 4) / 35, (4279 * N ** 4) / 630]
const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

const BANDS = 'CDEFGHJKLMNPQRSTUVWX'
export interface Utm { zone: number; band: string; easting: number; northing: number }

export function utmZone(lat: number, lon: number): number {
  let zone = Math.floor((lon + 180) / 6) + 1
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32 // Norwegen
  if (lat >= 72 && lat < 84) { // Svalbard
    if (lon >= 0 && lon < 9) zone = 31
    else if (lon >= 9 && lon < 21) zone = 33
    else if (lon >= 21 && lon < 33) zone = 35
    else if (lon >= 33 && lon < 42) zone = 37
  }
  return Math.min(60, Math.max(1, zone))
}

/** Außerhalb von 80°S bis 84°N gibt es kein UTM (dort UPS), `null`. */
export function toUtm(p: LatLon): Utm | null {
  if (p.lat < -80 || p.lat > 84) return null
  const zone = utmZone(p.lat, p.lon)
  const lon0 = rad((zone - 1) * 6 - 180 + 3)
  const phi = rad(p.lat), dl = rad(p.lon) - lon0
  const s = (2 * Math.sqrt(N)) / (1 + N)
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - s * Math.atanh(s * Math.sin(phi)))
  const xi0 = Math.atan2(t, Math.cos(dl))
  const eta0 = Math.asinh(Math.sin(dl) / Math.hypot(t, Math.cos(dl)))
  let xi = xi0, eta = eta0
  ALPHA.forEach((a, i) => {
    const j = 2 * (i + 1)
    xi += a * Math.sin(j * xi0) * Math.cosh(j * eta0)
    eta += a * Math.cos(j * xi0) * Math.sinh(j * eta0)
  })
  return {
    zone,
    band: BANDS[Math.min(BANDS.length - 1, Math.floor((p.lat + 80) / 8))],
    easting: 500000 + K0 * AA * eta,
    northing: (p.lat < 0 ? 10000000 : 0) + K0 * AA * xi,
  }
}

export function fromUtm(u: Utm): LatLon {
  const south = u.band.toUpperCase() < 'N'
  const xi0 = (u.northing - (south ? 10000000 : 0)) / (K0 * AA)
  const eta0 = (u.easting - 500000) / (K0 * AA)
  let xi = xi0, eta = eta0
  BETA.forEach((b, i) => {
    const j = 2 * (i + 1)
    xi -= b * Math.sin(j * xi0) * Math.cosh(j * eta0)
    eta -= b * Math.cos(j * xi0) * Math.sinh(j * eta0)
  })
  const chi = Math.asin(Math.sin(xi) / Math.cosh(eta))
  let phi = chi
  DELTA.forEach((d, i) => { phi += d * Math.sin(2 * (i + 1) * chi) })
  const lon0 = rad((u.zone - 1) * 6 - 180 + 3)
  return { lat: deg(phi), lon: deg(lon0 + Math.atan2(Math.sinh(eta), Math.cos(xi))) }
}

// ---------- Ausgabe ----------

function dms(abs: number): [number, number, number] { // Grad, Minuten, Sekunden (auf 0,1 s gerundet, ohne 60er-Überlauf)
  const tenths = Math.round(abs * 36000)
  return [Math.floor(tenths / 36000), Math.floor((tenths % 36000) / 600), (tenths % 600) / 10]
}
function dm(abs: number): [number, number] { // Grad, Dezimalminuten (auf 0,001 gerundet)
  const thousandths = Math.round(abs * 60000)
  return [Math.floor(thousandths / 60000), (thousandths % 60000) / 1000]
}

export function formatGeo(p: LatLon, format: GeoFormat): string {
  const ns = p.lat < 0 ? 'S' : 'N', ew = p.lon < 0 ? 'W' : 'E'
  switch (format) {
    case 'lonlat': return `${p.lon.toFixed(5)}, ${p.lat.toFixed(5)}`
    case 'dms': {
      const [a, b, c] = dms(Math.abs(p.lat)), [d, e, f] = dms(Math.abs(p.lon))
      return `${a}°${b}'${c.toFixed(1)}"${ns} ${d}°${e}'${f.toFixed(1)}"${ew}`
    }
    case 'dm': {
      const [a, b] = dm(Math.abs(p.lat)), [d, e] = dm(Math.abs(p.lon))
      return `${a}°${b.toFixed(3)}'${ns} ${d}°${e.toFixed(3)}'${ew}`
    }
    case 'utm': {
      const u = toUtm(p)
      return u ? `${u.zone}${u.band} ${Math.round(u.easting)} ${Math.round(u.northing)}` : `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)} (außerhalb UTM)`
    }
    default: return `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` // dd, map
  }
}

// ---------- Eingabe ----------

export type ParseResult = { ok: true; point: LatLon } | { ok: false; error: string }

const inRange = (lat: number, lon: number): ParseResult =>
  Math.abs(lat) > 90 ? { ok: false, error: 'Die Breite muss zwischen −90 und 90 liegen' }
    : Math.abs(lon) > 180 ? { ok: false, error: 'Die Länge muss zwischen −180 und 180 liegen' }
    : { ok: true, point: { lat, lon } }

/**
 * Liest Koordinaten in jedem der Formate. Mit Himmelsrichtung (N/S/E/W/O) ist die Reihenfolge egal;
 * bei reinen Zahlenpaaren gilt `order` (Breite zuerst, außer im Format „Länge, Breite“).
 */
export function parseGeo(input: string, order: 'latlon' | 'lonlat' = 'latlon'): ParseResult {
  let s = input.trim()
  if (!s) return { ok: false, error: 'Bitte Koordinaten eingeben' }

  const utm = /^(\d{1,2})\s*([C-HJ-NP-X])\s+(\d+(?:[.,]\d+)?)\s*(?:m\s*)?E?\s*[,;]?\s+(\d+(?:[.,]\d+)?)\s*(?:m\s*)?N?$/i.exec(s)
  if (utm) {
    const zone = Number(utm[1])
    if (zone < 1 || zone > 60) return { ok: false, error: 'Die UTM-Zone muss zwischen 1 und 60 liegen' }
    const p = fromUtm({ zone, band: utm[2].toUpperCase(), easting: Number(utm[3].replace(',', '.')), northing: Number(utm[4].replace(',', '.')) })
    return Number.isFinite(p.lat) && Number.isFinite(p.lon) ? inRange(p.lat, p.lon) : { ok: false, error: 'Ungültige UTM-Koordinate' }
  }

  s = s.replace(/[′’‘]/g, "'").replace(/[″”“]/g, '"').replace(/º/g, '°').replace(/''/g, '"')
  if (s.includes(';')) s = s.replace(/,/g, '.') // „52,37; 9,73“: Komma als Dezimaltrenner
  const re = /([NSEWO])?\s*(-?\d+(?:\.\d+)?)\s*(?:°\s*)?(?:(\d+(?:\.\d+)?)\s*'\s*)?(?:(\d+(?:\.\d+)?)\s*"\s*)?([NSEWO])?/gi
  const parts: { letter?: string; value: number }[] = []
  for (const m of s.matchAll(re)) {
    if (!m[2]) continue
    const neg = m[2].startsWith('-')
    let v = Math.abs(Number(m[2])) + (m[3] ? Number(m[3]) / 60 : 0) + (m[4] ? Number(m[4]) / 3600 : 0)
    if (m[3] && Number(m[3]) >= 60) return { ok: false, error: 'Minuten müssen kleiner als 60 sein' }
    const letter = (m[1] ?? m[5])?.toUpperCase()
    if (neg) v = -v
    parts.push({ letter, value: letter === 'S' || letter === 'W' ? -Math.abs(v) : v })
  }
  if (parts.length !== 2) return { ok: false, error: 'Erwartet werden zwei Werte (Breite und Länge) oder eine UTM-Angabe wie 32U 549260 5800540' }
  const [a, b] = parts
  const isLat = (l?: string) => l === 'N' || l === 'S', isLon = (l?: string) => l === 'E' || l === 'W' || l === 'O'
  if (isLat(a.letter) && isLon(b.letter)) return inRange(a.value, b.value)
  if (isLon(a.letter) && isLat(b.letter)) return inRange(b.value, a.value)
  if (a.letter || b.letter) return { ok: false, error: 'Himmelsrichtungen: eine Breite (N/S) und eine Länge (E/W/O)' }
  return order === 'lonlat' ? inRange(b.value, a.value) : inRange(a.value, b.value)
}

// ---------- Kartenkacheln (kleine Karte in der Zelle) ----------

/** Kachelserver; bei Bedarf hier austauschen. */
export const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
export const TILE_ATTRIBUTION = '© OpenStreetMap-Mitwirkende'

export interface MapTile { src: string; left: number; top: number }

/** Kacheln, die ein Fenster von `w`×`h` Pixeln um den Punkt füllen; `left`/`top` sind Pixel im Fenster. */
export function tilesAround(p: LatLon, zoom: number, w: number, h: number): MapTile[] {
  const n = 2 ** zoom
  const px = ((p.lon + 180) / 360) * n * 256
  const py = ((1 - Math.asinh(Math.tan(rad(p.lat))) / Math.PI) / 2) * n * 256
  const x0 = px - w / 2, y0 = py - h / 2
  const out: MapTile[] = []
  for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + h) / 256); ty++) {
    if (ty < 0 || ty >= n) continue
    for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + w) / 256); tx++) {
      const wrapped = ((tx % n) + n) % n
      out.push({ src: TILE_URL.replace('{z}', String(zoom)).replace('{x}', String(wrapped)).replace('{y}', String(ty)), left: Math.round(tx * 256 - x0), top: Math.round(ty * 256 - y0) })
    }
  }
  return out
}
