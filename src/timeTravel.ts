/**
 * Stand des Dokuments zu einem früheren Zeitpunkt: Grid kopiert den heutigen Stand und macht die Änderungen des Protokolls (audit.ts)
 * ab diesem Zeitpunkt rückwärts rückgängig. Das Ergebnis ist ein eigenes Dokument, das nur angesehen wird; das echte bleibt unberührt.
 * Nicht zurückgerechnet werden Dateien, Karten, abgeleitete Tabellen sowie die Reihenfolge von Spalten und Tabellen (sie zeigen den heutigen Stand).
 */
import * as Y from 'yjs'
import { auditOf, type AuditEntry, type Op } from './audit'
import { linksOf, tableOrderOf, tablesOf } from './model'

const ASOF = Symbol('asof')

const toRow = (j: Record<string, unknown>) => { const m = new Y.Map<any>(); for (const [k, v] of Object.entries(j)) m.set(k, v); return m }
const toCol = (j: Record<string, unknown>) => {
  const m = new Y.Map<any>()
  for (const [k, v] of Object.entries(j)) {
    if (k === 'options' && v && typeof v === 'object') { const o = new Y.Map<any>(); for (const [id, x] of Object.entries(v as object)) o.set(id, x); m.set(k, o) } else m.set(k, v)
  }
  return m
}
const toTable = (j: Record<string, unknown>) => {
  const m = new Y.Map<any>()
  for (const [k, v] of Object.entries(j)) {
    if (k === 'colOrder' || k === 'rowOrder') m.set(k, Y.Array.from(v as string[]))
    else if (k === 'cols') { const c = new Y.Map<any>(); for (const [id, x] of Object.entries(v as object)) c.set(id, toCol(x as Record<string, unknown>)); m.set(k, c) }
    else if (k === 'rows') { const r = new Y.Map<any>(); for (const [id, x] of Object.entries(v as object)) r.set(id, toRow(x as Record<string, unknown>)); m.set(k, r) }
    else m.set(k, v)
  }
  return m
}
const insertAt = (arr: Y.Array<string>, id: string, ix?: number) => {
  if (arr.toArray().includes(id)) return
  arr.insert(typeof ix === 'number' ? Math.min(Math.max(ix, 0), arr.length) : arr.length, [id])
}
const removeAll = (arr: Y.Array<string>, id: string) => { const a = arr.toArray(); for (let i = a.length - 1; i >= 0; i--) if (a[i] === id) arr.delete(i, 1) }

/** Macht einen Gegenschritt am Dokument. */
export function applyOp(doc: Y.Doc, op: Op) {
  const tables = tablesOf(doc)
  const t = op.ti ? tables.get(op.ti) : undefined
  switch (op.m) {
    case 'cell': {
      const row = t?.get('rows')?.get(op.ri!)
      if (!row) return
      if (op.v === undefined) row.delete(op.ci!); else row.set(op.ci!, op.v)
      return
    }
    case 'row-del': if (t) { t.get('rows').delete(op.ri!); removeAll(t.get('rowOrder'), op.ri!) } return
    case 'row-put': if (t && !t.get('rows').has(op.ri!)) { t.get('rows').set(op.ri!, toRow((op.j ?? {}) as Record<string, unknown>)); insertAt(t.get('rowOrder'), op.ri!, op.ix) } return
    case 'col-del': if (t) { t.get('cols').delete(op.ci!); removeAll(t.get('colOrder'), op.ci!) } return
    case 'col-put': if (t && !t.get('cols').has(op.ci!)) { t.get('cols').set(op.ci!, toCol((op.j ?? {}) as Record<string, unknown>)); insertAt(t.get('colOrder'), op.ci!, op.ix) } return
    case 'colp': {
      const col = t?.get('cols')?.get(op.ci!)
      if (!col) return
      if (op.k!.startsWith('options.')) {
        let opts: Y.Map<any> | undefined = col.get('options')
        if (!opts) { if (op.v === undefined) return; opts = new Y.Map<any>(); col.set('options', opts) }
        const id = op.k!.slice('options.'.length)
        if (op.v === undefined) opts.delete(id); else opts.set(id, op.v)
      } else if (op.v === undefined) col.delete(op.k!); else col.set(op.k!, op.v)
      return
    }
    case 'tab-del': if (t) { tables.delete(op.ti!); removeAll(tableOrderOf(doc), op.ti!) } return
    case 'tab-put': if (!t) { tables.set(op.ti!, toTable((op.j ?? {}) as Record<string, unknown>)); insertAt(tableOrderOf(doc), op.ti!) } return
    case 'tabp': if (t) { if (op.v === undefined) t.delete(op.k!); else t.set(op.k!, op.v) } return
    case 'link': { const l = linksOf(doc); if (op.v === undefined) l.delete(op.k!); else l.set(op.k!, op.v as number) }
  }
}

export interface AsOf {
  doc: Y.Doc
  /** Zeitpunkt des ältesten Eintrags im Protokoll (davor ist der Stand nicht mehr rekonstruierbar); null = Protokoll leer */
  earliest: number | null
  /** Ältere Einträge ohne Gegenschritte (aus der Zeit vor dieser Funktion) liegen nach dem Zeitpunkt: Der Stand kann ungenau sein. */
  incomplete: boolean
  /** Wie viele Einträge zurückgerechnet wurden */
  reverted: number
}

/** Baut eine Kopie des Dokuments im Stand von `at` (ms). `onEdit` wird gerufen, wenn jemand versucht, die Kopie zu ändern. */
export function buildAsOf(doc: Y.Doc, at: number, onEdit?: () => void): AsOf {
  const copy = new Y.Doc()
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
  const entries = auditOf(copy).toArray().map((e, i) => ({ e, i }))
  const earliest = entries.length ? Math.min(...entries.map((x) => x.e.t)) : null
  const later = entries.filter((x) => x.e.t > at).sort((p, q) => q.e.t - p.e.t || q.i - p.i) // neueste zuerst
  let incomplete = false
  copy.transact(() => {
    for (const { e } of later) {
      if (!e.u) { incomplete = true; continue }
      for (let i = e.u.length - 1; i >= 0; i--) applyOp(copy, e.u[i])
    }
  }, ASOF)
  if (onEdit) copy.on('afterTransaction', (tr: Y.Transaction) => { if (tr.local && tr.origin !== ASOF) onEdit() })
  return { doc: copy, earliest, incomplete, reverted: later.length }
}

export type { AuditEntry }
