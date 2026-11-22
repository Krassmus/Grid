import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addColumn, addRow, addTable, deleteRow, getCell, publishProfile, profilesOf, readTables, setCell } from './model'
import { createUndoManager } from './undo'

describe('Rückgängig / Wiederholen', () => {
  it('macht Zellen, Zeilen und deren Löschen rückgängig, aber keine Änderungen anderer', () => {
    const doc = new Y.Doc()
    const t = addTable(doc, 'T')
    const col = readTables(doc)[0].columns[0].id
    const row = addRow(doc, t)
    setCell(doc, t, row, col, 'eins')
    const um = createUndoManager(doc) // ab hier zählt der Verlauf
    setCell(doc, t, row, col, 'zwei'); um.stopCapturing()
    deleteRow(doc, t, row); um.stopCapturing()
    expect(readTables(doc)[0].rowIds).not.toContain(row)
    um.undo()
    expect(readTables(doc)[0].rowIds).toContain(row)
    expect(getCell(doc, t, row, col)).toBe('zwei')
    um.undo()
    expect(getCell(doc, t, row, col)).toBe('eins')
    um.redo()
    expect(getCell(doc, t, row, col)).toBe('zwei')

    // Änderung eines anderen (Abgleich) bleibt bei „Rückgängig“ stehen
    const other = new Y.Doc()
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc))
    const r2 = addRow(other, t)
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc)), 'remote')
    expect(readTables(doc)[0].rowIds).toContain(r2)
    um.undo(); um.undo()
    expect(readTables(doc)[0].rowIds).toContain(r2)
  })
  it('Profile gehören nicht zum Verlauf', () => {
    const doc = new Y.Doc()
    addTable(doc, 'T')
    const um = createUndoManager(doc)
    publishProfile(doc, 'a', { name: 'Anna', avatar: '' })
    expect(um.undoStack.length).toBe(0)
    expect(profilesOf(doc).get('a')?.name).toBe('Anna')
  })
})
