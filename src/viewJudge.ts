/**
 * Prüft Änderungen von Konten, die an einer Tabelle kein Schreibrecht haben, aber an einer abgeleiteten Tabelle (docs/RIGHTS.md).
 * Eine Zeile darf geändert werden, wenn sie vorher und nachher den Bedingungen einer schreibbaren Sicht genügt, angelegt werden, wenn sie nachher genügt,
 * gelöscht werden, wenn sie vorher genügte. Ausgeblendete Spalten bleiben unberührt, Verknüpfungen und Dateien sind ausgenommen.
 * Den Zustand „nachher“ liefert ein Arbeitsabbild des Dokuments, auf das das Update zur Probe angewendet wird.
 */
import * as Y from 'yjs'
import { readTables, readViews, tablesOf, type TableInfo } from './model'
import type { Rights } from './rights'
import type { Scope } from './updateScope'
import { isValueColumn, rowMatches, writeBlocker } from './viewWrite'
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

/** `null`, wenn die Änderungen an den Tabellen `ids` über Sichten des Autors erlaubt sind, sonst der Grund. */
export function judgeViaViews(live: Y.Doc, update: Uint8Array, scope: Scope, ids: string[], rights: Rights): string | null {
  const tables = readTables(live)
  const views = readViews(live)
  const noWrite = t('Kein Schreibrecht an der Tabelle')
  const usable = new Map<string, typeof views>()
  for (const id of ids) {
    const table = tables.find((x) => x.id === id)
    if (!table || scope.extras.has(id)) return noWrite
    const mine = views.filter((v) => v.def.source === id && rights.access(v.id) === 'write' && !writeBlocker(v.def, table, tables))
    if (mine.length === 0) return noWrite
    usable.set(id, mine)
  }
  const after = probeDoc(live)
  let why: string | null = null
  try {
    Y.applyUpdate(after, update)
    for (const id of ids) {
      why = judgeTable(live, after, tables.find((x) => x.id === id)!, tables, usable.get(id)!, scope) ?? null
      if (why) break
    }
  } catch { why = t('Änderung nicht lesbar') }
  if (why) scratch.delete(live) // das Arbeitsabbild enthält jetzt Abgelehntes
  return why
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
  if (scope.order.has(table.id)) {
    const a = orderOf(live, table.id), b = orderOf(after, table.id)
    const sa = new Set(a), sb = new Set(b)
    for (const id of [...a.filter((x) => !sb.has(x)), ...b.filter((x) => !sa.has(x))]) if (!touched.has(id)) return t('Reihenfolge der Zeilen geändert')
    if (a.filter((x) => sb.has(x)).join('|') !== b.filter((x) => sa.has(x)).join('|')) return t('Reihenfolge der Zeilen geändert')
  }
  return null
}
