/**
 * Vertrauliche Spalten abgleichen (docs/RIGHTS.md, „Verschlüsselung je Spalte“). Läuft auf Geräten von Admins:
 * Eine Spalte wird verschlüsselt, sobald mindestens ein Mitglied sie nicht lesen darf; Schlüssel bekommen die Admins und alle, die sie
 * lesen dürfen. Dieser Abgleich legt Schlüssel an, verpackt sie für neue Leser, wechselt sie, wenn jemand nicht mehr lesen darf (oder
 * das Dokument verlassen hat), und verschlüsselt die Zellen mit dem neuesten Schlüssel. Eine einmal geschützte Spalte bleibt geschützt.
 */
import * as Y from 'yjs'
import type { AdminState } from './adminLog'
import { COLCRYPT, ringOf, type Ring } from './colCrypt'
import type { Identity } from './identity'
import { readTables, readViews, tablesOf, type TableInfo, type ViewDef } from './model'
import { rightsFor } from './rights'
import { isValueColumn, writeBlocker } from './viewWrite'

/** Spalten, deren Werte eine Sicht liest: ihre sichtbaren Spalten, Bedingungen, Gruppierung und Summen. */
export function viewColumns(def: ViewDef, table: TableInfo): Set<string> {
  const out = new Set(table.columns.filter((c) => !c.hidden).map((c) => c.id))
  for (const f of def.filters) out.add(f.col)
  if (def.group.col) out.add(def.group.col)
  for (const id of Object.keys(def.aggs)) out.add(id)
  return out
}

export interface ColumnPlan {
  table: TableInfo
  col: string
  /** Wer die Spalte lesen darf (Konten): Admins, Gruppen mit Recht an Spalte oder Tabelle, Gruppen mit Recht an einer Sicht, die sie liest */
  readers: Set<string>
  /** Soll (neu) geschützt werden: jemand darf nicht lesen und die Spalte ist keine Bedingungsspalte einer schreibbaren Sicht */
  wanted: boolean
}

/** Für jede Wertspalte, wer sie lesen darf und ob sie geschützt werden soll. */
export function planColumns(doc: Y.Doc, state: AdminState): ColumnPlan[] {
  const tables = readTables(doc), views = readViews(doc)
  const rights = new Map([...state.members.keys()].map((a) => [a, rightsFor(state, a)]))
  // Bedingungsspalten schreibbarer Sichten, an denen eine Gruppe Schreibrecht hat: jedes Mitglied prüft beim Empfang damit, sie bleiben Klartext
  const exempt = new Set<string>()
  for (const v of views) {
    const table = tables.find((x) => x.id === v.def.source)
    if (!table || writeBlocker(v.def, table, tables)) continue
    if (![...state.grants.values()].some((g) => g.get(v.id) === 'write')) continue
    for (const f of v.def.filters) exempt.add(f.col)
  }
  const out: ColumnPlan[] = []
  for (const table of tables) {
    const sourceViews = views.filter((v) => v.def.source === table.id).map((v) => ({ id: v.id, cols: viewColumns(v.def, table) }))
    for (const c of table.columns) {
      if (!isValueColumn(c)) continue
      const readers = new Set<string>()
      for (const [acct, r] of rights) {
        if (r.admin || r.colAccess(table.id, c.id) !== 'none' || sourceViews.some((v) => v.cols.has(c.id) && r.access(v.id) !== 'none')) readers.add(acct)
      }
      out.push({ table, col: c.id, readers, wanted: state.groups.size > 0 && readers.size < state.members.size && !exempt.has(c.id) })
    }
  }
  return out
}

/** Schreibt alle Zellen der Spalte, die nicht mit `kid` verschlüsselt sind (Klartext oder älterer Schlüssel), mit `kid` neu. */
function encryptColumn(doc: Y.Doc, ring: Ring, tableId: string, col: string, kid: string) {
  const rows: Y.Map<Y.Map<any>> | undefined = tablesOf(doc).get(tableId)?.get('rows')
  if (!rows) return
  const todo: [Y.Map<any>, unknown][] = []
  rows.forEach((row) => {
    const raw = row.get(col)
    if (raw === undefined || raw === null || raw === '') return
    const old = ring.kidOf(raw)
    if (old === kid) return
    if (old === null) { todo.push([row, raw]); return }
    if (!ring.has(old)) return // Schlüssel fehlt: ein anderer Admin muss umschlüsseln
    const value = ring.decrypt(col, raw as string)
    if (value !== null) todo.push([row, value])
  })
  if (!todo.length) return
  doc.transact(() => { for (const [row, value] of todo) row.set(col, ring.encrypt(col, value, kid)) }, COLCRYPT)
}

/** Gleicht alle Spalten an `state` an (nur auf Admin-Geräten sinnvoll). */
export async function reconcileColumns(doc: Y.Doc, docId: string, me: Identity, state: AdminState): Promise<void> {
  if (state.members.get(me.id)?.role !== 'admin') return
  const ring = ringOf(doc)
  await ring.openBoxes(docId, me, state)
  for (const p of planColumns(doc, state)) {
    const metas = ring.metas(p.col)
    if (!metas.length) {
      if (!p.wanted) continue
      encryptColumn(doc, ring, p.table.id, p.col, await ring.createKey(docId, me, state, p.col, p.readers))
      continue
    }
    const cur = metas[0].kid
    if (!ring.has(cur)) continue // der neueste Schlüssel fehlt hier: ein Admin, der ihn hat, übernimmt
    const boxed = ring.boxedFor(p.col, cur)
    // Jemand kennt den Schlüssel, darf die Spalte aber nicht (mehr) lesen oder ist kein Mitglied mehr: neuer Schlüssel für die übrigen Leser
    if ([...boxed].some((a) => !p.readers.has(a))) {
      encryptColumn(doc, ring, p.table.id, p.col, await ring.createKey(docId, me, state, p.col, p.readers))
      continue
    }
    const missing = [...p.readers].filter((a) => !boxed.has(a))
    if (missing.length) await ring.shareKey(docId, me, state, p.col, cur, missing)
    encryptColumn(doc, ring, p.table.id, p.col, cur)
  }
}
