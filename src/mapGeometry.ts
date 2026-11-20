/** Längen und Flächen für gezeichnete Strecken und Gebiete (Punkte als [Breite, Länge] in Grad). */
export type Pt = [number, number]
const R = 6371008.8 // mittlerer Erdradius in Metern
const rad = (d: number) => (d * Math.PI) / 180

/** Länge eines Streckenzugs in Metern (Großkreisabstand, Haversine). */
export function pathLength(pts: Pt[]): number {
  let sum = 0
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]]
    const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1])
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2
    sum += 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
  }
  return sum
}

/** Fläche eines Gebiets in Quadratmetern (lokale Projektion um den Schwerpunkt; für Gebiete bis einige 100 km genau genug). */
export function ringArea(pts: Pt[]): number {
  if (pts.length < 3) return 0
  const lat0 = pts.reduce((s, p) => s + p[0], 0) / pts.length
  const lon0 = pts.reduce((s, p) => s + p[1], 0) / pts.length
  const xy = pts.map((p) => [R * rad(p[1] - lon0) * Math.cos(rad(lat0)), R * rad(p[0] - lat0)])
  let a = 0
  for (let i = 0; i < xy.length; i++) { const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % xy.length]; a += x1 * y2 - x2 * y1 }
  return Math.abs(a) / 2
}

export function formatLength(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toLocaleString('de-DE', { maximumFractionDigits: m < 10000 ? 2 : 1 })} km`
}

export function formatArea(m2: number): string {
  if (m2 < 10000) return `${Math.round(m2).toLocaleString('de-DE')} m²`
  if (m2 < 1e6) return `${(m2 / 10000).toLocaleString('de-DE', { maximumFractionDigits: 2 })} ha`
  return `${(m2 / 1e6).toLocaleString('de-DE', { maximumFractionDigits: m2 < 1e8 ? 2 : 1 })} km²`
}
