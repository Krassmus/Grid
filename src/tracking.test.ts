import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { applyFix, currentTracking, distanceMeters, startTracking, stopTracking } from './tracking'
import { addRow, addTable, getCell } from './model'
import { decodeGeo } from './geo'

describe('GPS-Verfolgung', () => {
  it('Entfernung', () => {
    expect(distanceMeters({ lat: 52, lon: 13 }, { lat: 52, lon: 13 })).toBe(0)
    expect(Math.round(distanceMeters({ lat: 52, lon: 13 }, { lat: 52.001, lon: 13 }))).toBe(111)
  })
  it('schreibt nur bei Bewegung und Zeitabstand, endet mit der Zeile', () => {
    vi.stubGlobal('navigator', { geolocation: { watchPosition: () => 1, clearWatch: () => {} } })
    const doc = new Y.Doc()
    const t = addTable(doc, 'T')
    const col = [...(doc.getMap('tables').get(t) as Y.Map<any>).get('cols').keys()][0]
    const row = addRow(doc, t)
    startTracking({ doc, tableId: t, rowId: row, colId: col, tableName: 'T', colName: 'Ort', rowLabel: 'Zeile' })
    expect(applyFix({ lat: 50, lon: 8 }, 1000)).toBe(true)
    expect(decodeGeo(getCell(doc, t, row, col))).toEqual({ lat: 50, lon: 8 })
    expect(applyFix({ lat: 51, lon: 8 }, 2000)).toBe(false) // zu früh
    expect(applyFix({ lat: 50, lon: 8.00001 }, 9000)).toBe(false) // zu nah
    expect(applyFix({ lat: 50.001, lon: 8 }, 9000)).toBe(true)
    doc.getMap<Y.Map<any>>('tables').get(t)!.get('rows').delete(row)
    expect(applyFix({ lat: 52, lon: 8 }, 99000)).toBe(false)
    expect(currentTracking()?.error).toMatch(/nicht mehr/)
    stopTracking()
    expect(currentTracking()).toBeNull()
  })
})
