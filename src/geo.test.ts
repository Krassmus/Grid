import { describe, expect, it } from 'vitest'
import { decodeGeo, encodeGeo, formatGeo, fromUtm, parseGeo, tilesAround, toUtm, type GeoFormat } from './geo'

const hannover = { lat: 52.37052, lon: 9.73219 }
const ok = (r: ReturnType<typeof parseGeo>) => { if (!r.ok) throw new Error(r.error); return r.point }

describe('Geokoordinaten', () => {
  it('speichert einheitlich und liest zurück', () => {
    expect(encodeGeo(hannover)).toBe('52.3705200,9.7321900')
    expect(decodeGeo('52.3705200,9.7321900')).toEqual(hannover)
    expect(decodeGeo('-33.8,151.2')).toEqual({ lat: -33.8, lon: 151.2 })
    expect(decodeGeo('abc')).toBeNull()
    expect(decodeGeo('95,10')).toBeNull()
    expect(decodeGeo(null)).toBeNull()
  })
  it('gibt in allen Formaten aus', () => {
    expect(formatGeo(hannover, 'dd')).toBe('52.37052, 9.73219')
    expect(formatGeo(hannover, 'lonlat')).toBe('9.73219, 52.37052')
    expect(formatGeo(hannover, 'dms')).toBe('52°22\'13.9"N 9°43\'55.9"E')
    expect(formatGeo(hannover, 'dm')).toBe("52°22.231'N 9°43.931'E")
    expect(formatGeo({ lat: -33.8688, lon: -70.5 }, 'dms')).toMatch(/S .*W$/)
  })
  it('rundet ohne 60er-Überlauf', () => {
    expect(formatGeo({ lat: 10.99999999, lon: 0 }, 'dms')).toBe('11°0\'0.0"N 0°0\'0.0"E')
  })
  it('rechnet UTM korrekt (Eiffelturm, Freiheitsstatue, Südhalbkugel)', () => {
    const eiffel = toUtm({ lat: 48.8584, lon: 2.2945 })!
    expect([eiffel.zone, eiffel.band]).toEqual([31, 'U'])
    expect(Math.abs(eiffel.easting - 448252)).toBeLessThan(3)
    // Auf dem Mittelmeridian (3° O) liegt 45° N bei N 4 982 950,4 m (Literaturwert)
    expect(Math.abs(toUtm({ lat: 45, lon: 3 })!.northing - 4982950.4)).toBeLessThan(0.01)
    expect(toUtm({ lat: 45, lon: 3 })!.easting).toBeCloseTo(500000, 6)
    const liberty = toUtm({ lat: 40.6892, lon: -74.0445 })!
    expect([liberty.zone, liberty.band]).toEqual([18, 'T'])
    const sydney = toUtm({ lat: -33.8568, lon: 151.2153 })!
    expect([sydney.zone, sydney.band]).toEqual([56, 'H'])
    expect(sydney.northing).toBeGreaterThan(6000000) // Südhalbkugel: Falschnorden 10 000 km
    expect(toUtm({ lat: 85, lon: 0 })).toBeNull()
  })
  it('Sonderzonen Norwegen und Svalbard', () => {
    expect(toUtm({ lat: 60, lon: 5 })!.zone).toBe(32)
    expect(toUtm({ lat: 78, lon: 15 })!.zone).toBe(33)
  })
  it('UTM hin und zurück auf Zentimeter genau', () => {
    for (const p of [hannover, { lat: -33.8568, lon: 151.2153 }, { lat: 0.5, lon: -0.5 }, { lat: 78.2, lon: 15.6 }, { lat: 64.1, lon: -21.9 }]) {
      const back = fromUtm(toUtm(p)!)
      expect(Math.abs(back.lat - p.lat)).toBeLessThan(1e-9)
      expect(Math.abs(back.lon - p.lon)).toBeLessThan(1e-9)
    }
  })
  it('liest jedes Ausgabeformat wieder ein', () => {
    for (const f of ['dd', 'lonlat', 'dms', 'dm', 'utm'] as GeoFormat[]) {
      const p = ok(parseGeo(formatGeo(hannover, f), f === 'lonlat' ? 'lonlat' : 'latlon'))
      expect(Math.abs(p.lat - hannover.lat), f).toBeLessThan(2e-5)
      expect(Math.abs(p.lon - hannover.lon), f).toBeLessThan(2e-5)
    }
  })
  it('versteht übliche Schreibweisen', () => {
    expect(ok(parseGeo('52.37 9.73'))).toEqual({ lat: 52.37, lon: 9.73 })
    expect(ok(parseGeo('52,37; 9,73'))).toEqual({ lat: 52.37, lon: 9.73 })
    expect(ok(parseGeo('9.73, 52.37', 'lonlat'))).toEqual({ lat: 52.37, lon: 9.73 })
    expect(ok(parseGeo('9.73°E 52.37°N'))).toEqual({ lat: 52.37, lon: 9.73 }) // Reihenfolge egal mit Himmelsrichtung
    expect(ok(parseGeo('33.5°S 70.5°W'))).toEqual({ lat: -33.5, lon: -70.5 })
    expect(ok(parseGeo('52°30′0″N 13°30′0″O'))).toEqual({ lat: 52.5, lon: 13.5 })
    expect(ok(parseGeo('32U 549260 5800540'))).toMatchObject({})
    expect(ok(parseGeo('32U 549260E 5800540N')).lat).toBeCloseTo(52.37, 1)
    expect(ok(parseGeo('-12.5, -45.25'))).toEqual({ lat: -12.5, lon: -45.25 })
  })
  it('meldet Fehler verständlich', () => {
    for (const bad of ['', 'abc', '52.37', '95 10', '10 200', '52°75\'N 9°E', '61U 1 2']) {
      expect(parseGeo(bad).ok, bad).toBe(false)
    }
  })
  it('berechnet Kartenkacheln um einen Punkt', () => {
    const t = tilesAround(hannover, 14, 200, 100)
    expect(t.length).toBeGreaterThanOrEqual(1)
    expect(t.length).toBeLessThanOrEqual(4)
    expect(t[0].src).toMatch(/^https:\/\/tile\.openstreetmap\.org\/14\/\d+\/\d+\.png$/)
    // Mittelpunkt des Fensters liegt auf einer der Kacheln
    expect(t.some((x) => x.left <= 100 && x.left + 256 >= 100 && x.top <= 50 && x.top + 256 >= 50)).toBe(true)
  })
})
