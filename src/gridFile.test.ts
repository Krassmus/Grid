import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addColumn, addFile, addRow, addTable, readTables } from './model'
import { buildSaveBundle, decodeBundle, encodeBundle, neededAssetKeys, newMeta } from './gridFile'

function sample() {
  const doc = new Y.Doc()
  const t = addTable(doc, 'Ausgaben', { firstRow: false })
  const beleg = addColumn(doc, t, 'Beleg', 'file')
  const r1 = addRow(doc, t), r2 = addRow(doc, t)
  addFile(doc, t, r1, beleg, { hash: 'h1', name: 'beleg.pdf', size: 3, mime: 'application/pdf' })
  return { doc, t, beleg, r1, r2 }
}

describe('Paket', () => {
  it('Paket-Kodierung ist umkehrbar', () => {
    const bytes = encodeBundle({ a: 'ä' }, [new Uint8Array([1, 2]), new Uint8Array([3])])
    const { header, bin } = decodeBundle<{ a: string }>(bytes)
    expect(header.a).toBe('ä')
    expect([...bin]).toEqual([1, 2, 3])
  })

  it('vollständiges Paket: nur referenzierte Dateien, fehlende werden übersprungen, Updates und Tabellen enthalten', async () => {
    const s = sample()
    addFile(s.doc, s.t, s.r2, s.beleg, { hash: 'h2', name: 'x.png', size: 1, mime: 'image/png' })
    const store = new Map<string, Blob>([['h1', new Blob(['abc'])], ['h1:thumb', new Blob(['t'])], ['unbenutzt', new Blob(['zzz'])]])
    const get = async (k: string) => store.get(k)
    const state = Y.encodeStateAsUpdate(s.doc)

    const { bytes, keys } = await buildSaveBundle(s.doc, newMeta(), new Set(['egal']), { full: true, updates: [state] }, get)
    const { header, bin } = decodeBundle<any>(bytes)
    expect(header.full).toBe(true)
    expect(header.updates).toEqual([state.length])
    expect(header.assets).toEqual([{ key: 'h1', len: 3 }, { key: 'h1.thumb', len: 1 }]) // h2 fehlt lokal, "unbenutzt" entfällt
    expect([...keys]).toEqual(['h1', 'h1.thumb'])
    expect(new TextDecoder().decode(bin.subarray(state.length))).toBe('abct')
    expect(header.ops.rebuild[0].rows).toHaveLength(2)
    expect(header.ops.pruneAssets).toEqual(neededAssetKeys(s.doc))
    expect(header.meta.formatVersion).toBe(2)
  })

  it('Anhängen: nur neue Dateien, bekannte bleiben in der Datei', async () => {
    const s = sample()
    const store = new Map<string, Blob>([['h1', new Blob(['abc'])], ['h1:thumb', new Blob(['t'])]])
    const get = async (k: string) => store.get(k)
    const first = await buildSaveBundle(s.doc, newMeta(), new Set(), { full: true, updates: [] }, get)
    const second = await buildSaveBundle(s.doc, newMeta(), first.keys, { updates: [new Uint8Array([9])], ops: { tablePos: [['x', 0]] } }, get)
    const h = decodeBundle<any>(second.bytes).header
    expect(h.assets).toEqual([])
    expect(h.full).toBe(false)
    expect(h.ops).toEqual({ tablePos: [['x', 0]] }) // ohne Verdichten kein Aufräumen der Assets
    expect([...second.keys]).toEqual(['h1', 'h1.thumb'])
  })

  it('CRDT-Zustand im Paket lässt sich wieder laden', async () => {
    const s = sample()
    const state = Y.encodeStateAsUpdate(s.doc)
    const { bytes } = await buildSaveBundle(s.doc, newMeta(), new Set(), { full: true, updates: [state] }, async () => undefined)
    const { header, bin } = decodeBundle<any>(bytes)
    const copy = new Y.Doc()
    Y.applyUpdate(copy, bin.slice(0, header.updates[0]))
    expect(readTables(copy)[0].rowIds).toEqual([s.r1, s.r2])
  })
})
