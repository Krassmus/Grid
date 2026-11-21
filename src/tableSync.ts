/**
 * Bildet das Dokument in echte Datentabellen der .grid-Datei ab (siehe src-tauri/src/grid_file.rs):
 * je Tabelle eine SQL-Tabelle `d_<id>` (Spalten `c_<id>`), je Relationsspalte eine Verknüpfungstabelle.
 *
 * Gespeichert wird inkrementell: der `Materializer` beobachtet das Dokument und merkt sich nur, was sich
 * geändert hat (Zellen einer Zeile, Zeilen, Verknüpfungen, Dateien, Spaltenstruktur). `collect()` macht daraus
 * die Operationen für den nächsten Schreibvorgang. Der CRDT-Zustand selbst (Yjs-Updates) wird getrennt abgelegt.
 */
import * as Y from 'yjs'
import { filesOf, isComputed, linksOf, readTables, tableOrderOf, tablesOf, type TableInfo } from './model'

export interface ColSpec {
  id: string
  name: string
  type: string
  target: string | null
  width: number | null
  /** Hat die Spalte eine Spalte in der Datentabelle? (nicht bei Relationen, Dateien und berechneten Spalten) */
  data: boolean
  options: { id: string; name: string; color: string }[]
}
type Value = string | number | boolean | null
export type RowSpec = [id: string, pos: number, values: Value[]]
export interface TableSpec {
  id: string
  name: string
  pos: number
  columns: ColSpec[]
  rows?: RowSpec[]
  links?: [row: string, col: string, target: string, pos: number][]
}
/** Operationen für die Rust-Seite; die Namen entsprechen `Ops` in grid_file.rs. */
export interface Ops {
  dropTables?: string[]
  rebuild?: TableSpec[]
  catalog?: TableSpec[]
  upsertRows?: { table: string; cols: string[]; rows: RowSpec[] }[]
  deleteRows?: { table: string; ids: string[] }[]
  positions?: { table: string; ids: string[] }[]
  linksPut?: [table: string, row: string, col: string, target: string, pos: number][]
  linksDel?: [table: string, row: string, col: string, target: string][]
  filesPut?: [table: string, row: string, col: string, hash: string, name: string, size: number, mime: string][]
  filesDel?: [table: string, row: string, col: string, hash: string][]
  tablePos?: [id: string, pos: number][]
  pruneAssets?: string[]
}

export const hasDataColumn = (c: { type: string }) => c.type !== 'relation' && c.type !== 'file' && !isComputed({ type: c.type } as any)
const dataIds = (t: TableInfo) => t.columns.filter(hasDataColumn).map((c) => c.id)

function norm(v: unknown): Value {
  if (v === undefined || v === null) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  return JSON.stringify(v)
}

function rowSpec(rows: Y.Map<Y.Map<any>>, id: string, pos: number, cols: string[]): RowSpec {
  const r = rows.get(id)
  return [id, pos, cols.map((c) => norm(r?.get(c)))]
}

function spec(t: TableInfo, pos: number): TableSpec {
  return {
    id: t.id, name: t.name, pos,
    columns: t.columns.map((c) => ({
      id: c.id, name: c.name, type: c.type, target: c.target ?? null, width: c.width ?? null, data: hasDataColumn(c),
      options: (c.options ?? []).map((o) => ({ id: o.id, name: o.name, color: o.color })),
    })),
  }
}

const filePut = (key: string, m: { name: string; size: number; mime: string }): NonNullable<Ops['filesPut']>[number] => {
  const [t, r, c, h] = key.split('|')
  return [t, r, c, h, m.name, m.size, m.mime]
}

/** Ganze Tabelle samt Zeilen und Verknüpfungen (neu angelegt oder Spalten geändert). */
function fullSpec(doc: Y.Doc, t: TableInfo, pos: number, links: TableSpec['links']): TableSpec {
  const rows: Y.Map<Y.Map<any>> = tablesOf(doc).get(t.id)!.get('rows')
  const cols = dataIds(t)
  return { ...spec(t, pos), rows: t.rowIds.map((id, i) => rowSpec(rows, id, i, cols)), links }
}

function linksByTable(doc: Y.Doc, only?: Set<string>) {
  const out = new Map<string, NonNullable<TableSpec['links']>>()
  linksOf(doc).forEach((v, key) => {
    const [t, r, c, x] = key.split('|')
    if (only && !only.has(t)) return
    const list = out.get(t) ?? []
    list.push([r, c, x, typeof v === 'number' ? v : 0])
    out.set(t, list)
  })
  return out
}

/** Alles, um eine Datei neu anzulegen: alle Tabellen komplett, alle Dateiverweise. */
export function fullOps(doc: Y.Doc): Ops {
  const tables = readTables(doc)
  const links = linksByTable(doc)
  const filesPut: NonNullable<Ops['filesPut']> = []
  filesOf(doc).forEach((m, key) => filesPut.push(filePut(key, m)))
  return { rebuild: tables.map((t, i) => fullSpec(doc, t, i, links.get(t.id) ?? [])), filesPut }
}

export class Materializer {
  private rebuild = new Set<string>()
  private dropped = new Set<string>()
  private catalog = new Set<string>()
  private rows = new Map<string, Set<string>>()
  private fullPos = new Set<string>()
  private links = new Set<string>()
  private files = new Set<string>()
  private order = false
  private off: (() => void)[] = []

  constructor(private doc: Y.Doc) {
    const tables = tablesOf(doc)
    tables.observeDeep(this.onTables)
    const links = linksOf(doc), files = filesOf(doc), order = tableOrderOf(doc)
    const onLinks = (e: Y.YMapEvent<any>) => e.keys.forEach((_, k) => this.links.add(k))
    const onFiles = (e: Y.YMapEvent<any>) => e.keys.forEach((_, k) => this.files.add(k))
    const onOrder = () => { this.order = true }
    links.observe(onLinks)
    files.observe(onFiles)
    order.observe(onOrder)
    this.off.push(() => tables.unobserveDeep(this.onTables), () => links.unobserve(onLinks), () => files.unobserve(onFiles), () => order.unobserve(onOrder))
  }

  dispose() { for (const f of this.off) f(); this.off = [] }

  /** Verwirft alles Vorgemerkte (z. B. weil die Datei komplett neu geschrieben wird). */
  clear() {
    for (const s of [this.rebuild, this.dropped, this.catalog, this.fullPos, this.links, this.files]) s.clear()
    this.rows.clear()
    this.order = false
  }

  private mark(t: string, rowId: string) {
    const s = this.rows.get(t) ?? new Set()
    s.add(rowId)
    this.rows.set(t, s)
  }

  private onTables = (events: Y.YEvent<any>[]) => {
    for (const e of events) {
      const path = e.path as (string | number)[]
      if (path.length === 0) {
        // Tabellen angelegt oder gelöscht
        for (const [id, ch] of e.changes.keys) {
          if (ch.action === 'delete') { this.dropped.add(id); this.rebuild.delete(id) } else { this.rebuild.add(id); this.dropped.delete(id) }
        }
        continue
      }
      const t = String(path[0])
      if (this.rebuild.has(t)) continue // wird ohnehin komplett neu geschrieben
      if (path.length === 1) {
        if (e.changes.keys.has('name')) this.catalog.add(t)
        continue
      }
      const part = path[1]
      if (part === 'colOrder') {
        if ((e as Y.YArrayEvent<any>).delta.some((d) => d.insert || d.delete)) this.rebuild.add(t) // Spalte neu, gelöscht oder verschoben
      } else if (part === 'cols') {
        if (path.length === 2) this.rebuild.add(t)
        else this.catalog.add(t) // Name, Breite, Optionen …
      } else if (part === 'rowOrder') {
        // Anhängen genügt (neue Zeilen kommen über `rows`); sonst Reihenfolge der ganzen Tabelle neu schreiben
        const order = tablesOf(this.doc).get(t)?.get('rowOrder') as Y.Array<string> | undefined
        let inserted = 0, deleted = 0
        for (const d of (e as Y.YArrayEvent<any>).delta) { inserted += d.insert ? (d.insert as unknown[]).length : 0; deleted += d.delete ?? 0 }
        const oldLen = (order?.length ?? 0) - inserted + deleted
        let at = 0
        for (const d of (e as Y.YArrayEvent<any>).delta) {
          if (d.retain) at += d.retain
          else if (d.delete) at += d.delete
          else if (d.insert && at < oldLen) this.fullPos.add(t)
        }
      } else if (part === 'rows') {
        if (path.length === 2) for (const id of e.changes.keys.keys()) this.mark(t, id)
        else this.mark(t, String(path[2]))
      }
    }
  }

  /** Operationen für alles, was sich seit dem letzten Mal geändert hat; `null`, wenn nichts zu schreiben ist. */
  collect(): Ops | null {
    const doc = this.doc
    const all = readTables(doc)
    const index = new Map(all.map((t, i) => [t.id, i]))
    const ops: Ops = {}
    const push = <K extends keyof Ops>(k: K, v: NonNullable<Ops[K]> extends (infer U)[] ? U : never) => { ((ops[k] ??= [] as any) as any[]).push(v) }

    for (const id of this.dropped) if (index.has(id)) this.rebuild.add(id); else push('dropTables', id)
    const rebuilt = new Set<string>()
    const links = linksByTable(doc, this.rebuild)
    for (const id of this.rebuild) {
      const t = all[index.get(id) ?? -1]
      if (!t) { push('dropTables', id); continue }
      rebuilt.add(id)
      push('rebuild', fullSpec(doc, t, index.get(id)!, links.get(id) ?? []))
    }
    for (const id of this.catalog) {
      const t = all[index.get(id) ?? -1]
      if (t && !rebuilt.has(id)) push('catalog', spec(t, index.get(id)!))
    }
    for (const [id, dirty] of this.rows) {
      const t = all[index.get(id) ?? -1]
      if (!t || rebuilt.has(id)) continue
      const rows: Y.Map<Y.Map<any>> = tablesOf(doc).get(id)!.get('rows')
      const pos = new Map(t.rowIds.map((r, i) => [r, i]))
      const cols = dataIds(t)
      const up: RowSpec[] = [], del: string[] = []
      for (const r of dirty) {
        if (pos.has(r) && rows.has(r)) up.push(rowSpec(rows, r, pos.get(r)!, cols)); else del.push(r)
      }
      if (up.length) push('upsertRows', { table: id, cols, rows: up })
      if (del.length) push('deleteRows', { table: id, ids: del })
    }
    for (const id of this.fullPos) {
      const t = all[index.get(id) ?? -1]
      if (t && !rebuilt.has(id)) push('positions', { table: id, ids: t.rowIds })
    }
    for (const key of this.links) {
      const [t, r, c, x] = key.split('|')
      if (rebuilt.has(t)) continue
      const v = linksOf(doc).get(key)
      if (v === undefined) push('linksDel', [t, r, c, x]); else push('linksPut', [t, r, c, x, typeof v === 'number' ? v : 0])
    }
    for (const key of this.files) {
      const [t, r, c, h] = key.split('|')
      const m = filesOf(doc).get(key)
      if (m) push('filesPut', filePut(key, m)); else push('filesDel', [t, r, c, h])
    }
    if (this.order) all.forEach((t, i) => push('tablePos', [t.id, i]))
    this.clear()
    return Object.keys(ops).length ? ops : null
  }
}
