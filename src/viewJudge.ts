/**
 * Prüft Änderungen von Konten, die an einer Tabelle kein volles Schreibrecht haben: Schreibrecht an Spalten oder an einer abgeleiteten Tabelle (docs/RIGHTS.md).
 * Eine Zeile darf geändert werden, wenn sie vorher und nachher den Bedingungen einer schreibbaren Sicht genügt, angelegt werden, wenn sie nachher genügt,
 * gelöscht werden, wenn sie vorher genügte. Ausgeblendete Spalten bleiben unberührt, Verknüpfungen und Dateien sind ausgenommen.
 * Den Zustand „nachher“ liefert ein Arbeitsabbild des Dokuments, auf das das Update zur Probe angewendet wird.
 */
import * as Y from 'yjs'
import { readTables, readViews, tablesOf, type TableInfo } from './model'
import type { Rights } from './rights'
import type { Scope } from './updateScope'
import { isValueColumn, rowMatches, writeBlocker } from './viewWrite'
import { ringOf } from './colCrypt'
import { t } from './i18n'

const scratch = new WeakMap<Y.Doc, Y.Doc>()

/** Arbeitsabbild, auf dem Stand des echten Dokuments. Es kann weiter sein (angenommene, noch nicht angewendete Änderungen), nie anders. */
function probeDoc(live: Y.Doc): Y.Doc {
  let s = scratch.get(live)
  if (s) {
    // Hat es etwas, das das echte Dokument nicht hat (Angenommenes, das nie angewendet wurde), neu aufbauen
    const have = Y.decodeStateVector(Y.encodeStateVector(live))
    for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(s))) if (clock > (have.get(client) ?? 0)) { s = undefined; break }
  }
  if (!s) { s = new Y.Doc(); scratch.set(live, s) }
  Y.applyUpdate(s, Y.encodeStateAsUpdate(live, Y.encodeStateVector(s)))
  return s
}

const rowsOf = (doc: Y.Doc, tid: string): Y.Map<Y.Map<any>> | undefined => tablesOf(doc).get(tid)?.get('rows')
const orderOf = (doc: Y.Doc, tid: string): string[] => tablesOf(doc).get(tid)?.get('rowOrder')?.toArray() ?? []

/**
 * Vertrauliche Spalten: Was ein Nicht-Admin dort schreibt, muss mit einem Schlüssel der Spalte verschlüsselt sein (oder leer),
 * sonst stünde Klartext im Dokument, den jedes Mitglied lesen könnte. `null`, wenn alles in Ordnung ist.
 */
export function ciphertextReason(live: Y.Doc, update: Uint8Array, scope: Scope): string | null {
  const ring = ringOf(live)
  const cells: [string, string, string][] = []
  for (const [tid, byRow] of scope.cells) for (const [rid, cols] of byRow) for (const col of cols) if (ring.isProtected(col)) cells.push([tid, rid, col])
  if (!cells.length) return null
  let why: string | null = null
  try {
    const after = probeDoc(live)
    Y.applyUpdate(after, update)
    for (const [tid, rid, col] of cells) {
      const v = rowsOf(after, tid)?.get(rid)?.get(col)
      if (v === undefined || v === null) continue
      const kid = ring.kidOf(v)
      if (!kid || !ring.metas(col).some((m) => m.kid === kid)) { why = t('Eine vertrauliche Spalte darf nur verschlüsselte Werte enthalten'); break }
    }
  } catch { why = t('Änderung nicht lesbar') }
  if (why) scratch.delete(live)
  return why
}

/**
 * `null`, wenn die Änderungen an den Tabellen `ids` erlaubt sind, obwohl dem Autor das Schreiben an der ganzen Tabelle fehlt: entweder über Schreibrechte
 * an den berührten Spalten (docs/RIGHTS.md, „Rechte je Spalte“) oder über eine schreibbare abgeleitete Tabelle; sonst der Grund.
 */
export function judgeViaViews(live: Y.Doc, update: Uint8Array, scope: Scope, ids: string[], rights: Rights): string | null {
  const tables = readTables(live)
  const views = readViews(live)
  const noWrite = t('Kein Schreibrecht an der Tabelle')
  // Das Arbeitsabbild entsteht erst, wenn es gebraucht wird (Reihenfolge, Zeilen einer Sicht)
  let probe: Y.Doc | null = null
  const after = () => { if (!probe) { probe = probeDoc(live); Y.applyUpdate(probe, update) } return probe }
  let why: string | null = null
  try {
    for (const id of ids) {
      const table = tables.find((x) => x.id === id)
      if (!table) { why = noWrite; break }
      const writesColumns = table.columns.some((c) => rights.colAccess(id, c.id) === 'write')
      const byColumns = writesColumns ? columnReason(live, after, scope, table, rights) : noWrite
      if (!byColumns) continue
      const mine = views.filter((v) => v.def.source === id && rights.access(v.id) === 'write' && !writeBlocker(v.def, table, tables, (c) => ringOf(live).isProtected(c)))
      const byView = mine.length === 0 || scope.extras.has(id) ? noWrite : judgeTable(live, after(), table, tables, mine, scope)
      if (!byView) continue
      why = writesColumns ? byColumns : byView
      break
    }
  } catch { why = t('Änderung nicht lesbar') }
  if (why && probe) scratch.delete(live) // das Arbeitsabbild enthält jetzt Abgelehntes
  return why
}

/** Spalten: jede berührte Zelle, Verknüpfung oder Datei muss in einer Spalte mit Schreibrecht liegen; Zeilen anlegen geht, löschen nicht. */
function columnReason(live: Y.Doc, after: () => Y.Doc, scope: Scope, table: TableInfo, rights: Rights): string | null {
  const cols = new Map(table.columns.map((c) => [c.id, c]))
  const need = (id: string): string | null => {
    const c = cols.get(id)
    if (!c) return t('Änderung betrifft eine unbekannte Spalte')
    if (c.type === 'autonumber' || c.type === 'stamp') return null // entstehen beim Anlegen und Ändern von selbst
    return rights.colAccess(table.id, id) === 'write' ? null : t('Kein Schreibrecht an der Spalte „{name}“', { name: c.name })
  }
  const before = rowsOf(live, table.id)
  for (const rid of scope.rowItems.get(table.id) ?? []) if (before?.has(rid)) return t('Zeilen löschen erfordert Schreibrecht an der ganzen Tabelle')
  for (const set of scope.cells.get(table.id)?.values() ?? []) for (const id of set) { const why = need(id); if (why) return why }
  for (const id of scope.extraCols.get(table.id) ?? []) { const why = need(id); if (why) return why }
  return scope.order.has(table.id) ? orderReason(live, after(), table.id, scope.rows.get(table.id) ?? new Set()) : null
}

/** Die Reihenfolge der Zeilen darf sich nur durch angelegte oder gelöschte Zeilen ändern (`touched`), die übrigen behalten ihre Reihenfolge. */
function orderReason(live: Y.Doc, after: Y.Doc, tid: string, touched: Set<string>): string | null {
  const a = orderOf(live, tid), b = orderOf(after, tid)
  const sa = new Set(a), sb = new Set(b)
  for (const id of [...a.filter((x) => !sb.has(x)), ...b.filter((x) => !sa.has(x))]) if (!touched.has(id)) return t('Reihenfolge der Zeilen geändert')
  if (a.filter((x) => sb.has(x)).join('|') !== b.filter((x) => sa.has(x)).join('|')) return t('Reihenfolge der Zeilen geändert')
  return null
}

function judgeTable(live: Y.Doc, after: Y.Doc, table: TableInfo, tables: TableInfo[], views: ReturnType<typeof readViews>, scope: Scope): string | null {
  const before = rowsOf(live, table.id), now = rowsOf(after, table.id)
  const touched = scope.rows.get(table.id) ?? new Set<string>()
  const valueCols = table.columns.filter(isValueColumn)
  const hidden = valueCols.filter((c) => c.hidden)
  for (const rid of touched) {
    const was = before?.get(rid), is = now?.get(rid)
    if (!was && !is) continue
    const wasOk = !!was && views.some((v) => rowMatches(v.def, table, tables, (c) => was.get(c)))
    const isOk = !!is && views.some((v) => rowMatches(v.def, table, tables, (c) => is.get(c)))
    if (was && !wasOk) return t('Die Zeile gehört nicht zu den Zeilen dieser abgeleiteten Tabelle')
    if (is && !isOk) return t('Die Zeile würde den Bedingungen der abgeleiteten Tabelle nicht mehr genügen')
    if (is) for (const c of hidden) if ((was?.get(c.id) ?? null) !== (is.get(c.id) ?? null)) return t('Ausgeblendete Spalte „{name}“ geändert', { name: c.name })
  }
  return scope.order.has(table.id) ? orderReason(live, after, table.id, touched) : null
}
