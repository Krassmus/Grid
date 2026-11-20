import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { FakeHub } from './sync'
import { sha256Hex } from './blobStore'
import { moveColumn, moveTable, deleteColumn, deleteTable, renameColumn, renameTable, addOption, deleteOption, updateOption, moveFile, moveLink, addFile, buildFileIndex, removeFile, addLink, addColumn, addRow, buildLinkIndex, removeLink, summarize, addTable, deleteRow, getCell, readTables, setCell, setColumnWidth, setColumnConfig } from './model'

function setup() {
  const a = new Y.Doc(), b = new Y.Doc()
  const hub = new FakeHub()
  hub.join('a', a); hub.join('b', b)
  const t = addTable(a, 'Personen', { firstRow: false })
  const name = readTables(a)[0].columns[0].id // automatisch angelegte Spalte „Name“
  const age = addColumn(a, t, 'Alter', 'number')
  return { a, b, hub, t, name, age }
}

describe('Neue Tabelle', () => {
  it('startet mit der Textspalte „Name“ und synchronisiert sie', () => {
    const { a, b } = setup()
    const t = addTable(a, 'Projekte')
    for (const d of [a, b]) {
      const tbl = readTables(d).find((x) => x.id === t)!
      expect(tbl.columns.map((c) => [c.name, c.type])).toEqual([['Name', 'text']])
      expect(tbl.rowIds.length).toBe(1) // erste leere Zeile
    }
  })

  it('firstRow: false legt keine Zeile an', () => {
    const { a } = setup()
    const t = addTable(a, 'Leer', { firstRow: false })
    expect(readTables(a).find((x) => x.id === t)!.rowIds.length).toBe(0)
  })
})

describe('Offline-Merge', () => {
  it('synchronisiert online sofort', () => {
    const { a, b, t, name } = setup()
    const r = addRow(a, t)
    setCell(a, t, r, name, 'Ada')
    expect(getCell(b, t, r, name)).toBe('Ada')
  })

  it('merged unterschiedliche Zellen derselben Zeile ohne Verlust', () => {
    const { a, b, hub, t, name, age } = setup()
    const r = addRow(a, t)
    hub.setOnline('a', false); hub.setOnline('b', false)
    setCell(a, t, r, name, 'Ada')
    setCell(b, t, r, age, 36)
    hub.setOnline('a', true); hub.setOnline('b', true)
    for (const d of [a, b]) {
      expect(getCell(d, t, r, name)).toBe('Ada')
      expect(getCell(d, t, r, age)).toBe(36)
    }
  })

  it('merged parallel angelegte Zeilen', () => {
    const { a, b, hub, t } = setup()
    hub.setOnline('b', false)
    addRow(a, t); addRow(b, t)
    hub.setOnline('b', true)
    expect(readTables(a)[0].rowIds.length).toBe(2)
    expect(readTables(a)[0].rowIds).toEqual(readTables(b)[0].rowIds)
  })

  it('gleiche Zelle offline: beide Seiten konvergieren auf denselben Wert', () => {
    const { a, b, hub, t, name } = setup()
    const r = addRow(a, t)
    hub.setOnline('a', false); hub.setOnline('b', false)
    setCell(a, t, r, name, 'X'); setCell(b, t, r, name, 'Y')
    hub.setOnline('a', true); hub.setOnline('b', true)
    expect(getCell(a, t, r, name)).toBe(getCell(b, t, r, name))
  })

  it('Löschen einer Zeile bei paralleler Bearbeitung bricht nichts', () => {
    const { a, b, hub, t, name } = setup()
    const r = addRow(a, t)
    hub.setOnline('b', false)
    deleteRow(a, t, r)
    setCell(b, t, r, name, 'Zombie')
    hub.setOnline('b', true)
    expect(readTables(a)[0].rowIds).toEqual(readTables(b)[0].rowIds)
  })
})

describe('Relationen', () => {
  function rel() {
    const s = setup()
    const t2 = addTable(s.a, 'Firmen', { firstRow: false })
    const fname = readTables(s.a).find((x) => x.id === t2)!.columns[0].id
    const link = addColumn(s.a, s.t, 'Arbeitgeber', 'relation', t2)
    const f1 = addRow(s.a, t2), f2 = addRow(s.a, t2)
    setCell(s.a, t2, f1, fname, 'ACME')
    const p = addRow(s.a, s.t)
    return { ...s, t2, fname, link, f1, f2, p }
  }

  it('gleichzeitiges Hinzufügen verschiedener Ziele geht nicht verloren', () => {
    const { a, b, hub, t, link, f1, f2, p } = rel()
    hub.setOnline('a', false); hub.setOnline('b', false)
    addLink(a, t, p, link, f1)
    addLink(b, t, p, link, f2)
    hub.setOnline('a', true); hub.setOnline('b', true)
    for (const d of [a, b]) expect(buildLinkIndex(d).forward.get(`${p}|${link}`)).toEqual([f1, f2].sort())
  })

  it('entfernt Links und liefert Rückverweise', () => {
    const { a, b, t, link, f1, p } = rel()
    addLink(a, t, p, link, f1)
    expect(buildLinkIndex(b).backward.get(`${f1}|${link}`)).toEqual([p])
    removeLink(a, t, p, link, f1)
    expect(buildLinkIndex(b).forward.get(`${p}|${link}`)).toBeUndefined()
  })

  it('verschiebt eine Verknüpfung in eine andere Zeile (und kopiert mit copy)', () => {
    const { a, b, t, link, f1, p } = rel()
    const p2 = addRow(a, t), p3 = addRow(a, t)
    addLink(a, t, p, link, f1)
    moveLink(a, { tableId: t, rowId: p, colId: link }, { tableId: t, rowId: p2, colId: link }, f1)
    for (const d of [a, b]) {
      expect(buildLinkIndex(d).forward.get(`${p}|${link}`)).toBeUndefined()
      expect(buildLinkIndex(d).forward.get(`${p2}|${link}`)).toEqual([f1])
    }
    moveLink(a, { tableId: t, rowId: p2, colId: link }, { tableId: t, rowId: p3, colId: link }, f1, true)
    expect(buildLinkIndex(a).forward.get(`${p2}|${link}`)).toEqual([f1])
    expect(buildLinkIndex(a).forward.get(`${p3}|${link}`)).toEqual([f1])
    // gleiche Zelle: nichts passiert
    moveLink(a, { tableId: t, rowId: p3, colId: link }, { tableId: t, rowId: p3, colId: link }, f1)
    expect(buildLinkIndex(a).forward.get(`${p3}|${link}`)).toEqual([f1])
  })

  it('Kachel nutzt erste Textspalte als Titel', () => {
    const { a, t2, f1 } = rel()
    const table = readTables(a).find((x) => x.id === t2)!
    expect(summarize(a, table, f1).title).toBe('ACME')
  })
})

describe('Dateien', () => {
  const ref = (n: string, h: string) => ({ hash: h, name: n, size: 3, mime: 'text/plain' })

  it('gleichzeitig angehängte Dateien gehen nicht verloren', () => {
    const { a, b, hub, t, name } = setup()
    const r = addRow(a, t)
    hub.setOnline('a', false); hub.setOnline('b', false)
    addFile(a, t, r, name, ref('b.txt', 'h2'))
    addFile(b, t, r, name, ref('a.txt', 'h1'))
    hub.setOnline('a', true); hub.setOnline('b', true)
    for (const d of [a, b]) expect(buildFileIndex(d).get(`${r}|${name}`)!.map((f) => f.name)).toEqual(['a.txt', 'b.txt'])
  })

  it('identischer Inhalt in derselben Zelle wird dedupliziert, Entfernen funktioniert', () => {
    const { a, t, name } = setup()
    const r = addRow(a, t)
    addFile(a, t, r, name, ref('x.txt', 'h1')); addFile(a, t, r, name, ref('x.txt', 'h1'))
    expect(buildFileIndex(a).get(`${r}|${name}`)!.length).toBe(1)
    removeFile(a, t, r, name, 'h1')
    expect(buildFileIndex(a).get(`${r}|${name}`)).toBeUndefined()
  })

  it('verschiebt und kopiert Dateien zwischen Zeilen', () => {
    const { a, b, t, name } = setup()
    const r1 = addRow(a, t), r2 = addRow(a, t), r3 = addRow(a, t)
    const f = ref('x.txt', 'h1')
    addFile(a, t, r1, name, f)
    moveFile(a, { tableId: t, rowId: r1, colId: name }, { tableId: t, rowId: r2, colId: name }, f)
    for (const d of [a, b]) {
      expect(buildFileIndex(d).get(`${r1}|${name}`)).toBeUndefined()
      expect(buildFileIndex(d).get(`${r2}|${name}`)!.map((x) => x.name)).toEqual(['x.txt'])
    }
    moveFile(a, { tableId: t, rowId: r2, colId: name }, { tableId: t, rowId: r3, colId: name }, f, true)
    expect(buildFileIndex(a).get(`${r2}|${name}`)!.length).toBe(1)
    expect(buildFileIndex(a).get(`${r3}|${name}`)!.length).toBe(1)
  })

  it('SHA-256 stimmt mit bekanntem Wert überein', async () => {
    const buf = new TextEncoder().encode('abc').buffer as ArrayBuffer
    expect(await sha256Hex(buf)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('Auswahlspalte', () => {
  function sel() {
    const s = setup()
    const col = addColumn(s.a, s.t, 'Status', 'select', undefined, ['Entwurf', 'In Arbeit'])
    const r = addRow(s.a, s.t)
    const opts = () => readTables(s.a)[0].columns.find((c) => c.id === col)!.options!
    return { ...s, col, r, opts }
  }

  it('legt Optionen in Reihenfolge mit Farben an', () => {
    const { opts } = sel()
    expect(opts().map((o) => o.name)).toEqual(['Entwurf', 'In Arbeit'])
    expect(opts()[0].color).not.toBe(opts()[1].color)
  })

  it('Wert ist die Options-ID und synchronisiert', () => {
    const { a, b, t, col, r, opts } = sel()
    setCell(a, t, r, col, opts()[1].id)
    expect(getCell(b, t, r, col)).toBe(opts()[1].id)
  })

  it('gleichzeitig angelegte Optionen gehen nicht verloren; Umbenennen und Löschen', () => {
    const { a, b, hub, t, col, opts } = sel()
    hub.setOnline('a', false); hub.setOnline('b', false)
    addOption(a, t, col, 'Fertig'); addOption(b, t, col, 'Wartet')
    hub.setOnline('a', true); hub.setOnline('b', true)
    expect(readTables(b)[0].columns.find((c) => c.id === col)!.options!.map((o) => o.name).sort())
      .toEqual(['Entwurf', 'Fertig', 'In Arbeit', 'Wartet'])
    const id = opts()[0].id
    updateOption(a, t, col, id, { name: 'Idee' })
    expect(readTables(b)[0].columns.find((c) => c.id === col)!.options!.find((o) => o.id === id)!.name).toBe('Idee')
    deleteOption(a, t, col, id)
    expect(opts().some((o) => o.id === id)).toBe(false)
  })

  it('Kachel zeigt den Optionsnamen statt der ID', () => {
    const { a, t, col, r, opts } = sel()
    const only = addTable(a, 'Nur Status', { firstRow: false })
    deleteColumn(a, only, readTables(a).find((x) => x.id === only)!.columns[0].id) // Standardspalte „Name“ entfernen
    const c2 = addColumn(a, only, 'Status', 'select', undefined, ['Offen'])
    const r2 = addRow(a, only)
    const tbl = readTables(a).find((x) => x.id === only)!
    setCell(a, only, r2, c2, tbl.columns[0].options![0].id)
    expect(summarize(a, readTables(a).find((x) => x.id === only)!, r2).title).toBe('Offen')
    void t; void col; void r; void opts
  })
})

describe('Umbenennen und Löschen', () => {
  it('benennt Tabelle und Spalte um (synchronisiert)', () => {
    const { a, b, t, name } = setup()
    renameTable(a, t, 'Leute'); renameColumn(a, t, name, 'Vorname')
    expect(readTables(b)[0].name).toBe('Leute')
    expect(readTables(b)[0].columns[0].name).toBe('Vorname')
  })

  it('Spalte löschen entfernt Werte, Links und Dateien dieser Spalte', () => {
    const { a, b, t, name, age } = setup()
    const f = addTable(a, 'Firmen', { firstRow: false }); const fr = addRow(a, f)
    const link = addColumn(a, t, 'Arbeitgeber', 'relation', f)
    const files = addColumn(a, t, 'Anhänge', 'file')
    const r = addRow(a, t)
    setCell(a, t, r, name, 'Ada'); setCell(a, t, r, age, 36)
    addLink(a, t, r, link, fr); addFile(a, t, r, files, { hash: 'h', name: 'x', size: 1, mime: 'text/plain' })
    deleteColumn(a, t, link); deleteColumn(a, t, files); deleteColumn(a, t, name)
    for (const d of [a, b]) {
      expect(readTables(d).find((x) => x.id === t)!.columns.map((c) => c.id)).toEqual([age])
      expect(buildLinkIndex(d).forward.size).toBe(0)
      expect(buildFileIndex(d).size).toBe(0)
      expect(getCell(d, t, r, age)).toBe(36)
      expect(getCell(d, t, r, name)).toBeNull()
    }
  })

  it('Tabelle löschen entfernt eigene Links und Links anderer Tabellen auf ihre Zeilen', () => {
    const { a, b, t } = setup()
    const f = addTable(a, 'Firmen', { firstRow: false }); const fr = addRow(a, f)
    const link = addColumn(a, t, 'Arbeitgeber', 'relation', f)
    const p = addRow(a, t)
    addLink(a, t, p, link, fr)
    deleteTable(a, f)
    for (const d of [a, b]) {
      expect(readTables(d).map((x) => x.id)).toEqual([t])
      expect(buildLinkIndex(d).forward.size).toBe(0)
      // Relationsspalte bleibt, Ziel fehlt
      expect(readTables(d)[0].columns.find((c) => c.id === link)!.target).toBe(f)
    }
  })

  it('paralleles Löschen und Bearbeiten stürzt nicht ab und konvergiert', () => {
    const { a, b, hub, t, name } = setup()
    const r = addRow(a, t)
    hub.setOnline('b', false)
    deleteColumn(a, t, name)
    setCell(b, t, r, name, 'später')
    hub.setOnline('b', true)
    expect(readTables(a)[0].columns.some((c) => c.id === name)).toBe(false)
    expect(readTables(b)[0].columns.some((c) => c.id === name)).toBe(false)
  })
})

describe('Reihenfolge', () => {
  const tableNames = (d: Y.Doc) => readTables(d).map((x) => x.name)
  const colNames = (d: Y.Doc, t: string) => readTables(d).find((x) => x.id === t)!.columns.map((c) => c.name)

  it('neue Tabellen stehen in Anlegereihenfolge; Verschieben synchronisiert', () => {
    const { a, b, t } = setup()
    const t2 = addTable(a, 'B', { firstRow: false }); const t3 = addTable(a, 'C', { firstRow: false })
    expect(tableNames(b)).toEqual(['Personen', 'B', 'C'])
    moveTable(a, t3, 0)
    expect(tableNames(a)).toEqual(['C', 'Personen', 'B'])
    expect(tableNames(b)).toEqual(['C', 'Personen', 'B'])
    moveTable(a, t, 2)
    expect(tableNames(b)).toEqual(['C', 'B', 'Personen'])
    void t2
  })

  it('verschiebt Spalten (vor/nach) und ändert sonst nichts', () => {
    const { a, b, t, name, age } = setup()
    const extra = addColumn(a, t, 'Ort', 'text')
    moveColumn(a, t, extra, 0)
    expect(colNames(b, t)).toEqual(['Ort', 'Name', 'Alter'])
    moveColumn(a, t, name, 2)
    expect(colNames(b, t)).toEqual(['Ort', 'Alter', 'Name'])
    moveColumn(a, t, name, 2) // schon dort: kein Effekt
    expect(colNames(b, t)).toEqual(['Ort', 'Alter', 'Name'])
    void age
  })

  it('parallele Verschiebungen konvergieren auf dieselbe Reihenfolge ohne Duplikate', () => {
    const { a, b, hub, t, name, age } = setup()
    const extra = addColumn(a, t, 'Ort', 'text')
    hub.setOnline('a', false); hub.setOnline('b', false)
    moveColumn(a, t, extra, 0); moveColumn(b, t, name, 2)
    hub.setOnline('a', true); hub.setOnline('b', true)
    expect(colNames(a, t)).toEqual(colNames(b, t))
    expect(new Set(colNames(a, t)).size).toBe(3)
    void age
  })

  it('gleichzeitig angelegte Tabelle geht beim Umsortieren nicht verloren', () => {
    const { a, b, hub } = setup()
    hub.setOnline('b', false)
    const t2 = addTable(a, 'B', { firstRow: false })
    const t3 = addTable(b, 'C', { firstRow: false })
    moveTable(b, t3, 0)
    hub.setOnline('b', true)
    expect(tableNames(a).sort()).toEqual(['B', 'C', 'Personen'])
    expect(tableNames(a)).toEqual(tableNames(b))
    void t2
  })
})

describe('Spaltenbreite', () => {
  it('wird gespeichert, synchronisiert und lässt sich zurücksetzen', () => {
    const a = new Y.Doc(), b = new Y.Doc()
    const t = addTable(a, 'T', { firstRow: false })
    const col = readTables(a)[0].columns[0].id
    expect(readTables(a)[0].columns[0].width).toBeUndefined()
    setColumnWidth(a, t, col, 301.4)
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    expect(readTables(b)[0].columns[0].width).toBe(301)
    setColumnWidth(a, t, col, undefined)
    expect(readTables(a)[0].columns[0].width).toBeUndefined()
  })
})

describe('Spaltenkonfiguration', () => {
  it('gleichzeitige Änderungen verschiedener Einstellungen gehen nicht verloren', () => {
    const a = new Y.Doc(), b = new Y.Doc()
    const t = addTable(a, 'T', { firstRow: false })
    const col = readTables(a)[0].columns[0].id
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    setColumnConfig(a, t, col, 'mode', 'multi')
    setColumnConfig(b, t, col, 'bold', true)
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b)); Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    expect(readTables(a)[0].columns[0].config).toEqual({ mode: 'multi', bold: true })
    expect(readTables(b)[0].columns[0].config).toEqual({ mode: 'multi', bold: true })
    setColumnConfig(a, t, col, 'mode', undefined)
    expect(readTables(a)[0].columns[0].config).toEqual({ bold: true })
  })
})

describe('Karten', () => {
  it('Karte anlegen, Objekte zeichnen, Tab-Reihenfolge, Tabelle löschen entfernt Ebene', async () => {
    const { addMap, readMaps, readTabs, setMapShape, deleteMapShape, updateMap, deleteMap, addTable, addColumn, deleteTable } = await import('./model')
    const doc = new Y.Doc()
    const t = addTable(doc, 'Orte')
    const col = addColumn(doc, t, 'Position', 'geo')
    const id = addMap(doc, 'Übersicht', [{ table: t, col }])
    expect(readTabs(doc).map((x) => [x.kind, x.name])).toEqual([['table', 'Orte'], ['map', 'Übersicht']])
    setMapShape(doc, id, 'a', { kind: 'point', lat: 52, lon: 9, label: 'Start', color: '#f00' })
    setMapShape(doc, id, 'b', { kind: 'line', pts: [[52, 9], [53, 10]], label: '', color: '#0f0' })
    setMapShape(doc, id, 'c', { kind: 'area', pts: [[1, 1], [2, 2]], label: '', color: '#00f' }) // zu wenige Punkte: ungültig
    expect(readMaps(doc)[0].shapes.map((s) => s.id)).toEqual(['a', 'b'])
    deleteMapShape(doc, id, 'a')
    updateMap(doc, id, { name: 'Neu' })
    expect(readMaps(doc)[0]).toMatchObject({ name: 'Neu', shapes: [{ id: 'b' }] })
    deleteTable(doc, t)
    expect(readMaps(doc)[0].layers).toEqual([])
    deleteMap(doc, id)
    expect(readTabs(doc)).toEqual([])
  })
})
