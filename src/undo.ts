/**
 * Rückgängig / Wiederholen für die eigenen Änderungen am Dokument (Zellen, Zeilen, Spalten, Tabellen, Verknüpfungen, Dateien, Karten).
 * Änderungen anderer (Abgleich) bleiben unberührt. Der Verlauf gilt für das geöffnete Dokument und endet mit dem Schließen.
 */
import { useEffect, useState } from 'react'
import * as Y from 'yjs'
import { filesOf, linksOf, mapsOf, tableOrderOf, tablesOf, viewsOf } from './model'

/** Schnell aufeinanderfolgende Änderungen (Tippen) zählen als ein Schritt. */
const CAPTURE_MS = 600

export function createUndoManager(doc: Y.Doc): Y.UndoManager {
  // Nicht dabei: Profile der Mitglieder und Verwaltung, die Grid selbst einträgt
  return new Y.UndoManager([tablesOf(doc), viewsOf(doc), mapsOf(doc), tableOrderOf(doc), linksOf(doc), filesOf(doc)], { captureTimeout: CAPTURE_MS })
}

interface Active { undo: () => void; redo: () => void }
let active: Active | null = null
let lastRun = 0

/** Steckt der Fokus in einem Eingabefeld außerhalb der Tabelle (Dialog, Suche, Textformatierung), gilt dort das Rückgängig des Feldes. */
export function inNativeField(el: Element | null): boolean {
  if (!el) return false
  if (el.closest('.backdrop, [contenteditable], .rowsearch')) return true
  return (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !el.classList.contains('cell')
}

/** Befehl aus Menü oder Tastatur: im Feld das Feld-Rückgängig, sonst das des Dokuments. */
export function runUndoCommand(kind: 'undo' | 'redo') {
  const now = Date.now()
  if (now - lastRun < 60) return // Menü und Tastatur melden sich manchmal beide
  lastRun = now
  const el = document.activeElement
  if (inNativeField(el)) { document.execCommand(kind); return }
  active?.[kind]()
}

export function useUndo(doc: Y.Doc) {
  const [state, setState] = useState({ canUndo: false, canRedo: false })
  useEffect(() => {
    const um = createUndoManager(doc)
    const sync = () => setState({ canUndo: um.undoStack.length > 0, canRedo: um.redoStack.length > 0 })
    for (const ev of ['stack-item-added', 'stack-item-popped', 'stack-cleared'] as const) um.on(ev, sync)
    const mine: Active = { undo: () => { um.stopCapturing(); um.undo() }, redo: () => { um.stopCapturing(); um.redo() } }
    active = mine
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod || e.altKey) return
      const k = e.key.toLowerCase()
      const kind = k === 'z' ? (e.shiftKey ? 'redo' : 'undo') : k === 'y' && e.ctrlKey && !e.metaKey ? 'redo' : null
      if (!kind || inNativeField(document.activeElement)) return
      e.preventDefault()
      runUndoCommand(kind)
    }
    window.addEventListener('keydown', onKey)
    sync()
    return () => {
      window.removeEventListener('keydown', onKey)
      if (active === mine) active = null
      um.destroy()
    }
  }, [doc])
  return {
    ...state,
    undo: () => runUndoCommand('undo'),
    redo: () => runUndoCommand('redo'),
  }
}
