import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addColumn, addFile, addLink, addRow, addTable, readTables, setCell, setColumnWidth } from './model'
import { buildSaveBundle, decodeBundle, encodeBundle, newMeta, projectionOf } from './gridFile'

function sample() {
  const doc = new Y.Doc()
  const t = addTable(doc, 'Ausgaben', { firstRow: false })
  const name = readTables(doc)[0].columns[0].id
  const wert = addColumn(doc, t, 'Wert', 'number')
  const beleg = addColumn(doc, t, 'Beleg', 'file')
  const status = addColumn(doc, t, 'Status', 'select', undefined, ['Offen'])
  const bezug = addColumn(doc, t, 'Bezug', 'relation', t)
  const r1 = addRow(doc, t), r2 = addRow(doc, t)
  setCell(doc, t, r1, name, 'Kaffee')
  setCell(doc, t, r1, wert, 3.5)
  addLink(doc, t, r1, bezug, r2)
  addFile(doc, t, r1, beleg, { hash: 'h1', name: 'beleg.pdf', size: 3, mime: 'application/pdf' })
  setColumnWidth(doc, t, name, 250)
  return { doc, t, name, wert, beleg, status, bezug, r1, r2 }
}

describe('Paket und Abbildung', () => {
  it('Paket-Kodierung ist umkehrbar', () => {
    const bytes = encodeBundle({ a: 'ä' }, [new Uint8Array([1, 2]), new Uint8Array([3])])
    const { header, bin } = decodeBundle<{ a: string }>(bytes)
    expect(header.a).toBe('ä')
    expect([...bin]).toEqual([1, 2, 3])
  })

  it('Abbildung enthält Spalten, Zellen, Verknüpfungen, Dateien und Breiten', () => {
    const s = sample()
    const p = projectionOf(s.doc)
    expect(p.tables).toHaveLength(1)
    expect(p.tables[0].rows).toEqual([s.r1, s.r2])
    expect(p.tables[0].columns.find((c) => c.id === s.name)!.width).toBe(250)
    expect(p.tables[0].columns.find((c) => c.id === s.status)!.options.map((o) => o.name)).toEqual(['Offen'])
    expect(p.cells).toContainEqual([s.t, s.r1, s.name, 'Kaffee'])
    expect(p.cells).toContainEqual([s.t, s.r1, s.wert, 3.5])
    expect(p.links).toEqual([[s.t, s.r1, s.bezug, s.r2, expect.any(Number)]])
    expect(p.files).toEqual([[s.t, s.r1, s.beleg, 'h1', 'beleg.pdf', 3, 'application/pdf']])
  })

  it('Speicherpaket: nur referenzierte Dateien, bekannte werden übernommen, fehlende übersprungen', async () => {
    const s = sample()
    addFile(s.doc, s.t, s.r2, s.beleg, { hash: 'h2', name: 'x.png', size: 1, mime: 'image/png' })
    const store = new Map<string, Blob>([
      ['h1', new Blob(['abc'])], ['h1:thumb', new Blob(['t'])], ['unbenutzt', new Blob(['zzz'])],
    ])
    const get = async (k: string) => store.get(k)

    const first = await buildSaveBundle(s.doc, newMeta(), new Set(), get)
    const h1 = decodeBundle<any>(first.bytes).header
    expect(h1.assets).toEqual([{ key: 'h1', len: 3 }, { key: 'h1.thumb', len: 1 }]) // h2 fehlt lokal, "unbenutzt" entfällt
    expect([...first.keys]).toEqual(['h1', 'h1.thumb'])
    const { bin } = decodeBundle<any>(first.bytes)
    expect(new TextDecoder().decode(bin.subarray(h1.ydocLen))).toBe('abct')

    const second = await buildSaveBundle(s.doc, newMeta(), first.keys, get)
    expect(decodeBundle<any>(second.bytes).header.assets).toEqual([
      { key: 'h1', len: 0, keep: true }, { key: 'h1.thumb', len: 0, keep: true },
    ])
  })

  it('CRDT-Zustand im Paket lässt sich wieder laden', async () => {
    const s = sample()
    const { bytes } = await buildSaveBundle(s.doc, newMeta(), new Set(), async () => undefined)
    const { header, bin } = decodeBundle<any>(bytes)
    const copy = new Y.Doc()
    Y.applyUpdate(copy, bin.slice(0, header.ydocLen))
    expect(readTables(copy)[0].rowIds).toEqual([s.r1, s.r2])
  })
})
