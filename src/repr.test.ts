import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addColumn, addFile, addLink, addRow, addTable, readTables, setCell, setColumnHidden, setTableRepr } from './model'
import { columnCells } from './cells'
import { NO_TITLE, computeRepr, reprConfig } from './repr'

/** Personen mit Name, Titel, Emoji und Bild; Gruppen verknüpfen Personen. */
function setup() {
  const doc = new Y.Doc()
  const personen = addTable(doc, 'Personen', { firstRow: false })
  const nameCol = readTables(doc).find((t) => t.id === personen)!.columns[0].id
  const titel = addColumn(doc, personen, 'Titel', 'text')
  const emoji = addColumn(doc, personen, 'Emoji', 'text')
  const foto = addColumn(doc, personen, 'Foto', 'file')
  const vor = addColumn(doc, personen, 'Vorname', 'text')
  const anzeige = addColumn(doc, personen, 'Anzeige', 'formula', undefined, [], { expr: '[Vorname] & " " & [Name]' })
  const r = addRow(doc, personen)
  setCell(doc, personen, r, nameCol, 'Meier'); setCell(doc, personen, r, vor, 'Anna'); setCell(doc, personen, r, titel, 'Herr der Wahnsinns'); setCell(doc, personen, r, emoji, '🚒')
  const gruppen = addTable(doc, 'Gruppen', { firstRow: false })
  const rel = addColumn(doc, gruppen, 'Leitung', 'relation', personen)
  const g = addRow(doc, gruppen)
  addLink(doc, gruppen, g, rel, r)
  const tables = () => readTables(doc)
  const p = () => tables().find((t) => t.id === personen)!
  const repr = () => computeRepr(doc, tables(), p()).get(r)!
  return { doc, personen, nameCol, titel, emoji, foto, anzeige, r, g, rel, gruppen, tables, p, repr }
}

describe('Darstellung eines Datensatzes', () => {
  it('Titel „Keiner“: nur der Avatar, der Text bleibt für Suche und Sortierung erhalten', () => {
    const s = setup()
    setTableRepr(s.doc, s.personen, 'title', NO_TITLE); setTableRepr(s.doc, s.personen, 'avatar', 'icon'); setTableRepr(s.doc, s.personen, 'icon', '🚒')
    expect(s.repr()).toMatchObject({ title: 'Meier', hideTitle: true, avatarInCells: true, avatar: { text: '🚒', symbol: true } })
    // Ohne Avatar bliebe die Kachel leer: dann wird der Titel trotzdem gezeigt
    setTableRepr(s.doc, s.personen, 'avatar', 'none')
    expect(s.repr().hideTitle).toBe(false)
  })
  it('Standard: erste Textspalte als Titel, Initialen, kein Untertitel, keine Anzeige in Zellen', () => {
    const s = setup()
    const r = s.repr()
    expect(r.title).toBe('Meier')
    expect(r.subs).toEqual([])
    expect(r.avatar).toEqual({ text: 'M' })
    expect(r.avatarInCells).toBe(false)
    expect(r.subInCells).toBe(false)
    expect(reprConfig(s.p())).toMatchObject({ title: '', sub: '', avatar: 'default' })
  })
  it('Titel und Untertitel aus Spalten (auch aus einer Formel-Spalte)', () => {
    const s = setup()
    setTableRepr(s.doc, s.personen, 'title', s.anzeige)
    setTableRepr(s.doc, s.personen, 'sub', s.titel)
    const r = s.repr()
    expect(r.title).toBe('Anna Meier')
    expect(r.subs).toEqual(['Herr der Wahnsinns'])
    expect(r.subInCells).toBe(true)
    setTableRepr(s.doc, s.personen, 'sub', undefined)
    expect(s.repr().subs).toEqual([])
  })
  it('Avatar: keiner, Initialen, festes Symbol, Symbol aus Spalte, Bild', () => {
    const s = setup()
    const avatar = (mode: string, extra: Record<string, string> = {}) => {
      setTableRepr(s.doc, s.personen, 'avatar', mode)
      for (const [k, v] of Object.entries(extra)) setTableRepr(s.doc, s.personen, k, v)
      return s.repr()
    }
    expect(avatar('none').avatar).toBeUndefined()
    expect(avatar('initial')).toMatchObject({ avatar: { text: 'M' }, avatarInCells: true })
    expect(avatar('icon', { icon: '⭐' }).avatar).toEqual({ text: '⭐', symbol: true })
    expect(avatar('icon', { icon: '' }).avatar).toEqual({ text: 'M' }) // leeres Symbol: Initialen
    expect(avatar('text', { avatarCol: s.emoji }).avatar).toEqual({ text: '🚒', symbol: true })
    expect(avatar('image', { avatarCol: s.foto }).avatar).toEqual({ text: 'M' }) // noch kein Bild
    addFile(s.doc, s.personen, s.r, s.foto, { hash: 'abc', name: 'a.txt', size: 1, mime: 'text/plain' })
    expect(s.repr().avatar).toEqual({ text: 'M' }) // keine Bilddatei
    addFile(s.doc, s.personen, s.r, s.foto, { hash: 'img1', name: 'b.png', size: 1, mime: 'image/png' })
    expect(s.repr().avatar).toEqual({ text: 'M', hash: 'img1' })
  })
  it('die Relationszelle zeigt den eingestellten Titel', () => {
    const s = setup()
    setTableRepr(s.doc, s.personen, 'title', s.anzeige)
    const g = s.tables().find((t) => t.id === s.gruppen)!
    const cells = columnCells(s.doc, s.tables(), g, g.columns.find((c) => c.id === s.rel)!)
    expect(cells.get(s.g)!.text).toBe('Anna Meier')
  })
  it('Zyklen über Relationen brechen nicht ab', () => {
    const s = setup()
    const back = addColumn(s.doc, s.personen, 'Gruppe', 'relation', s.gruppen)
    const loop = addColumn(s.doc, s.personen, 'Schleife', 'formula', undefined, [], { expr: '[Gruppe] & "x"' })
    setTableRepr(s.doc, s.personen, 'title', loop)
    setTableRepr(s.doc, s.gruppen, 'title', s.rel)
    expect(() => s.repr()).not.toThrow()
    void back
  })
  it('Spalten lassen sich ausblenden, bleiben aber berechenbar', () => {
    const s = setup()
    setColumnHidden(s.doc, s.personen, s.titel, true)
    expect(s.p().columns.find((c) => c.id === s.titel)!.hidden).toBe(true)
    setColumnHidden(s.doc, s.personen, s.titel, false)
    expect(s.p().columns.find((c) => c.id === s.titel)!.hidden).toBeUndefined()
  })
})
