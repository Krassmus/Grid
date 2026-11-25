/**
 * Stand des Dokuments zu einem früheren Zeitpunkt: Grid kopiert den heutigen Stand und macht die Änderungen des Protokolls (audit.ts)
 * ab diesem Zeitpunkt rückwärts rückgängig. Das Ergebnis ist ein eigenes Dokument, das nur angesehen wird; das echte bleibt unberührt.
 * Nicht zurückgerechnet werden Dateien, Karten, abgeleitete Tabellen sowie die Reihenfolge von Spalten und Tabellen (sie zeigen den heutigen Stand).
 */
import * as Y from 'yjs'
import { auditOf, forwardOp, type AuditEntry, type Op } from './audit'
import { linksOf, tableOrderOf, tablesOf } from './model'
import { ringOf } from './colCrypt'

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
    case 'col-del': if (t) { t.get('cols').delete(op.ci!); removeAll(t.get('colOrder'), op.ci!); t.get('rows').forEach((row: Y.Map<any>) => row.delete(op.ci!)) } return
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
  if (onEdit) copy.on('afterTransaction', (tr: Y.Transaction) => { if (tr.local && tr.origin !== ASOF && tr.changed.size > 0) onEdit() })
  return { doc: copy, earliest, incomplete, reverted: later.length }
}

/** Eintrag, der in der Anzeige nicht vorkommt (nur Hintergrundänderungen, z. B. Zeitstempel). */
export const isVisible = (e: AuditEntry) => e.k !== 'ops'

/**
 * Ein Dokument, das sich zeitlich vor- und zurückbewegen lässt (Zeitleiste, Film). Einträge sind nach Zeit geordnet;
 * `pos` Einträge sind im Stand enthalten. Zurück geht mit den Gegenschritten, vor mit den Schritten `f`; fehlen diese (ältere Einträge),
 * baut sich der Stand ab dem heutigen neu auf (dann ändert sich `doc`).
 */
export class TimeMachine {
  doc!: Y.Doc
  readonly entries: AuditEntry[]
  /** Anzahl der Einträge, die im Stand enthalten sind */
  pos: number
  /** Zählt hoch, wenn `doc` ein neues Dokument ist */
  version = 0
  readonly earliest: number | null
  readonly latest: number | null
  readonly incomplete: boolean

  constructor(private live: Y.Doc, private onEdit?: () => void) {
    const all = auditOf(live).toArray().map((e, i) => ({ e, i })).sort((p, q) => p.e.t - q.e.t || p.i - q.i).map((x) => x.e)
    // Einträge ohne Gegenschritte (aus der Zeit vor dieser Funktion) können nicht zurückgerechnet werden: Was davor liegt, gilt als Vorgeschichte
    let lastBad = -1
    all.forEach((e, i) => { if (!e.u) lastBad = i })
    this.entries = all.slice(lastBad + 1)
    this.earliest = this.entries.length ? this.entries[0].t : null
    this.latest = this.entries.length ? this.entries[this.entries.length - 1].t : null
    this.incomplete = false
    this.pos = this.entries.length
    this.deriveForward()
    this.fresh()
  }

  /** Einträge aus der Zeit vor den Schritten vorwärts bekommen sie nachträglich: rückwärts durch eine Kopie, jeweils vor dem Rückgängigmachen. */
  private deriveForward() {
    if (this.entries.every((e) => e.f)) return
    const scratch = new Y.Doc()
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(this.live))
    scratch.transact(() => {
      for (let i = this.entries.length - 1; i >= 0; i--) {
        const e = this.entries[i]
        if (!e.f) this.entries[i] = { ...e, f: e.u!.map((op) => forwardOp(scratch, op, undefined, new Map())) }
        for (let j = e.u!.length - 1; j >= 0; j--) applyOp(scratch, e.u![j])
      }
    }, ASOF)
    scratch.destroy()
  }

  private fresh() {
    this.doc = new Y.Doc()
    Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(this.live))
    ringOf(this.doc).inherit(ringOf(this.live)) // Admins sehen auch vertrauliche Spalten früherer Stände, wenn sie den Schlüssel haben
    this.pos = this.entries.length
    this.version++
    if (this.onEdit) this.doc.on('afterTransaction', (tr: Y.Transaction) => { if (tr.local && tr.origin !== ASOF && tr.changed.size > 0) this.onEdit!() })
  }

  /** Wie viele Einträge bis einschließlich `ms` gelten. */
  positionAt(ms: number): number {
    let lo = 0, hi = this.entries.length
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.entries[mid].t <= ms) lo = mid + 1; else hi = mid }
    return lo
  }

  /** Stellt den Stand mit den ersten `p` Einträgen her. */
  moveTo(p: number) {
    p = Math.max(0, Math.min(this.entries.length, p))
    if (p === this.pos) return
    if (p > this.pos && this.entries.slice(this.pos, p).some((e) => !e.f)) { // vorwärts ohne Schritte: von vorn aufbauen
      this.fresh()
      if (p === this.pos) return
    }
    this.doc.transact(() => {
      if (p < this.pos) {
        for (let i = this.pos - 1; i >= p; i--) { const u = this.entries[i].u; if (u) for (let j = u.length - 1; j >= 0; j--) applyOp(this.doc, u[j]) }
      } else {
        for (let i = this.pos; i < p; i++) for (const op of this.entries[i].f ?? []) applyOp(this.doc, op)
      }
    }, ASOF)
    this.pos = p
  }

  /** Nächste Stelle, an der ein sichtbarer Eintrag dazukommt (dir = 1) bzw. wegfällt (-1); null am Ende. */
  step(dir: 1 | -1): number | null {
    if (dir === 1) { for (let i = this.pos; i < this.entries.length; i++) if (isVisible(this.entries[i])) return i + 1; return null }
    for (let i = this.pos - 1; i >= 0; i--) if (isVisible(this.entries[i])) return i
    return null
  }

  /** Der zuletzt angewendete sichtbare Eintrag (für die Beschriftung). */
  current(): AuditEntry | null {
    for (let i = this.pos - 1; i >= 0; i--) if (isVisible(this.entries[i])) return this.entries[i]
    return null
  }

  /** Anzahl sichtbarer Einträge je Abschnitt zwischen frühestem und letztem Eintrag (für die Zeitleiste). */
  histogram(buckets: number): number[] {
    const out = new Array<number>(buckets).fill(0)
    if (this.earliest === null || this.latest === null) return out
    const span = Math.max(1, this.latest - this.earliest)
    for (const e of this.entries) if (isVisible(e)) out[Math.min(buckets - 1, Math.floor(((e.t - this.earliest) / span) * buckets))]++
    return out
  }
}

export type { AuditEntry }
