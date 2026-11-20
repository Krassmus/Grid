import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addColumn, addLink, addTable, createRecord, readTables, linksOf } from './model'
import { commitRecord, firstTextColumn, formColumns, updateRecord } from './RecordForm'

describe('Datensatz anlegen (mit Relationen)', () => {
  it('legt Zeile, Verknüpfungen und die Verknüpfung zur Quelle in einer Änderung an', async () => {
    const doc = new Y.Doc()
    const a = addTable(doc, 'Gebiete', { firstRow: false })
    const b = addTable(doc, 'Gruppen', { firstRow: false })
    const aName = readTables(doc)[0].columns[0].id
    const rel = addColumn(doc, a, 'Gruppen', 'relation', b)
    const sub = addColumn(doc, b, 'Gebiet', 'relation', a)
    const g1 = createRecord(doc, b, {}), g2 = createRecord(doc, b, {})
    const quelle = createRecord(doc, b, {})
    let updates = 0
    doc.on('update', () => updates++)
    const id = await commitRecord(doc, a, { [aName]: 'EAL 9' }, { files: {}, relations: { [rel]: [g1, g2] } }, (neu) => addLink(doc, b, quelle, sub, neu))
    expect(updates).toBe(1)
    const keys = [...linksOf(doc).keys()].sort()
    expect(keys).toEqual([`${a}|${id}|${rel}|${g1}`, `${a}|${id}|${rel}|${g2}`, `${b}|${quelle}|${sub}|${id}`].sort())
  })
})

describe('Datensatz bearbeiten', () => {
  it('schreibt nur Geändertes und gleicht Verknüpfungen ab (eine Änderung)', async () => {
    const doc = new Y.Doc()
    const a = addTable(doc, 'Gebiete', { firstRow: false })
    const b = addTable(doc, 'Gruppen', { firstRow: false })
    const name = readTables(doc)[0].columns[0].id
    const anz = addColumn(doc, a, 'Anzahl', 'number')
    const rel = addColumn(doc, a, 'Gruppen', 'relation', b)
    const g1 = createRecord(doc, b, {}), g2 = createRecord(doc, b, {}), g3 = createRecord(doc, b, {})
    const row = createRecord(doc, a, { [name]: 'EAL 1', [anz]: 5 })
    addLink(doc, a, row, rel, g1); addLink(doc, a, row, rel, g2)
    const cells = () => (doc.getMap<Y.Map<any>>('tables').get(a)!.get('rows').get(row) as Y.Map<any>)
    // Ein anderer Client ändert parallel die Anzahl; das Formular ändert nur den Namen
    cells().set(anz, 9)
    let updates = 0
    doc.on('update', () => updates++)
    await updateRecord(doc, a, row, { [name]: 'EAL 1a', [anz]: 5 }, { [name]: 'EAL 1', [anz]: 5 },
      { files: {}, relations: { [rel]: [g2, g3] } }, { [rel]: [g1, g2] })
    expect(updates).toBe(1)
    expect(cells().get(name)).toBe('EAL 1a')
    expect(cells().get(anz)).toBe(9) // unverändert im Formular, also nicht überschrieben
    expect([...linksOf(doc).keys()].sort()).toEqual([`${a}|${row}|${rel}|${g2}`, `${a}|${row}|${rel}|${g3}`].sort())
  })
  it('leert Felder, die im Formular geleert wurden', async () => {
    const doc = new Y.Doc()
    const t = addTable(doc, 'T', { firstRow: false })
    const name = readTables(doc)[0].columns[0].id
    const row = createRecord(doc, t, { [name]: 'x' })
    await updateRecord(doc, t, row, { [name]: null }, { [name]: 'x' }, { files: {}, relations: {} }, {})
    expect((doc.getMap<Y.Map<any>>('tables').get(t)!.get('rows').get(row) as Y.Map<any>).get(name)).toBeNull()
  })
})

describe('Datensatz anlegen', () => {
  function setup() {
    const doc = new Y.Doc()
    const t = addTable(doc, 'Personen', { firstRow: false })
    const name = readTables(doc)[0].columns[0].id
    const alter = addColumn(doc, t, 'Alter', 'number')
    const status = addColumn(doc, t, 'Status', 'select', undefined, ['neu', 'alt'])
    const ok = addColumn(doc, t, 'OK', 'checkbox')
    const formel = addColumn(doc, t, 'F', 'formula', undefined, [], { expr: '1' })
    const datei = addColumn(doc, t, 'Foto', 'file')
    const versteckt = addColumn(doc, t, 'V', 'text')
    doc.getMap<Y.Map<any>>('tables').get(t)!.get('cols').get(versteckt)!.set('hidden', true)
    const info = () => readTables(doc).find((x) => x.id === t)!
    return { doc, t, name, alter, status, ok, formel, datei, versteckt, info }
  }
  it('legt die Zeile mit Werten an, leere Felder bleiben ungesetzt', () => {
    const s = setup()
    const id = createRecord(s.doc, s.t, { [s.name]: 'Anna', [s.alter]: 31, [s.ok]: 1, [s.status]: null, [s.versteckt]: '' })
    const t = s.info()
    expect(t.rowIds).toEqual([id])
    const row = s.doc.getMap<Y.Map<any>>('tables').get(s.t)!.get('rows').get(id) as Y.Map<any>
    expect(row.toJSON()).toEqual({ [s.name]: 'Anna', [s.alter]: 31, [s.ok]: 1 })
  })
  it('geschieht in einer einzigen Änderung (Zeile und Verknüpfung zusammen)', () => {
    const s = setup()
    const gruppen = addTable(doc(s), 'Gruppen', { firstRow: false })
    const rel = addColumn(s.doc, gruppen, 'Leitung', 'relation', s.t)
    const g = s.doc.getMap<Y.Map<any>>('tables').get(gruppen)!
    let updates = 0
    s.doc.on('update', () => updates++)
    s.doc.transact(() => {
      const gr = createRecord(s.doc, gruppen, {})
      const p = createRecord(s.doc, s.t, { [s.name]: 'Bernd' })
      addLink(s.doc, gruppen, gr, rel, p)
    })
    expect(updates).toBe(1)
    expect(linksOf(s.doc).size).toBe(1)
    void g
  })
  it('Formular zeigt nur ausfüllbare Felder', () => {
    const s = setup()
    expect(formColumns(s.info()).map((c) => c.id)).toEqual([s.name, s.alter, s.status, s.ok, s.datei]) // Dateien gehören ins Formular; Formel und Ausgeblendetes nicht
    expect(firstTextColumn(s.info())!.id).toBe(s.name)
  })
})
const doc = (s: { doc: Y.Doc }) => s.doc
