import * as Y from 'yjs'
import { accountIdNow, getAccountName } from './identity'

/**
 * Datenmodell im Yjs-Dokument:
 *
 *   tables: Y.Map<tableId, Y.Map>
 *     name:     string
 *     colOrder: Y.Array<colId>
 *     cols:     Y.Map<colId, Y.Map{ name, type }>
 *     rowOrder: Y.Array<rowId>
 *     rows:     Y.Map<rowId, Y.Map<colId, value>>   (jede Zelle = eigener LWW-Wert)
 *
 *   tableOrder: Y.Array<tableId>   (Reihenfolge der Tabellen; fehlende IDs werden hinten angehängt)
 *
 *   Auswahlspalten: cols[colId].options = Y.Map<optionId, { name, color, pos }>;
 *     der Zellwert in rows[rowId][colId] ist die optionId (LWW).
 *
 *   links: Y.Map<"tableId|rowId|colId|targetRowId", number | true>   (Relationen als Menge; der Wert ist die Position in der Zelle,
 *                                                                    `true` = alt, zählt als 0)
 *     Jede Verknüpfung ist ein eigener Schlüssel: gleichzeitiges Hinzufügen
 *     verschiedener Ziele in derselben Zelle geht beim Merge nicht verloren.
 *     Die Rückrichtung wird nicht gespeichert, sondern aus dem Index berechnet.
 *
 *   files: Y.Map<"tableId|rowId|colId|hash", { name, size, mime }>   (Datei-Anhänge als Menge)
 *     Das Dokument enthält nur Referenzen (SHA-256). Die Bytes liegen im Blob-Speicher
 *     (siehe blobStore.ts) und werden später separat mit dem Server abgeglichen.
 */

export type ColType = 'text' | 'number' | 'relation' | 'file' | 'select' | 'date' | 'checkbox' | 'rollup' | 'formula' | 'template' | 'geo' | 'autonumber' | 'stamp' | 'person' | 'link' | 'duration'
export type CellValue = string | number | null

export interface SelectOption { id: string; name: string; color: string }
export interface ColumnInfo { id: string; name: string; type: ColType; target?: string; options?: SelectOption[]; width?: number; config?: Record<string, unknown>; footer?: string; hidden?: boolean }

/** Farb-IDs für Auswahloptionen; die konkreten Farben stehen in der UI (SelectCell.tsx). */
export const OPTION_COLORS = ['sand', 'green', 'blue', 'rose', 'violet', 'gray'] as const
/** Berechnete Spalten: ihr Wert wird nie gespeichert. */
export const isComputed = (c: Pick<ColumnInfo, 'type'>) => c.type === 'rollup' || c.type === 'formula' || c.type === 'template'

export interface TableInfo {
  id: string
  name: string
  columns: ColumnInfo[]
  rowIds: string[]
  /** Darstellung eines Datensatzes in anderen Tabellen (siehe repr.ts); je Einstellung ein Schlüssel `repr.<name>`. */
  repr: Record<string, unknown>
  /** Symbol im Reiter (siehe icons.tsx); leer = Standard. */
  icon?: string
}

// ---------- Abgeleitete Tabellen (Views) ----------

export type FilterOp = 'eq' | 'ne' | 'contains' | 'ncontains' | 'starts' | 'gt' | 'ge' | 'lt' | 'le' | 'empty' | 'nempty' | 'checked' | 'unchecked'
export interface ViewFilter { col: string; op: FilterOp; value: string }
export type AggFn = 'min' | 'max' | 'sum' | 'concat' | 'count' | 'hide'
export interface ViewAgg { fn: AggFn; sep?: string }
/** Definition einer abgeleiteten Tabelle: Quelle, Bedingungen (WHERE), Gruppierung und Zusammenfassung je Spalte. */
export interface ViewDef {
  source: string
  match: 'all' | 'any'
  filters: ViewFilter[]
  group: { mode: 'none' | 'column' | 'all'; col?: string }
  aggs: Record<string, ViewAgg>
}
export interface ViewInfo { id: string; name: string; def: ViewDef; icon?: string }

export const emptyViewDef = (source: string): ViewDef => ({ source, match: 'all', filters: [], group: { mode: 'none' }, aggs: {} })

export const uid = () => crypto.randomUUID().slice(0, 8)

export const tablesOf = (doc: Y.Doc) => doc.getMap<Y.Map<any>>('tables')
export const viewsOf = (doc: Y.Doc) => doc.getMap<Y.Map<any>>('views')
export const mapsOf = (doc: Y.Doc) => doc.getMap<Y.Map<any>>('maps')
export const tableOrderOf = (doc: Y.Doc) => doc.getArray<string>('tableOrder')

/**
 * Legt eine Tabelle an. Sie enthält sofort die Textspalte „Name“ (dient auch als Titel der Kacheln)
 * und standardmäßig eine erste leere Zeile (`firstRow: false` unterdrückt sie).
 */
export function addTable(doc: Y.Doc, name: string, opts: { firstRow?: boolean } = {}): string {
  const id = uid()
  doc.transact(() => {
    const t = new Y.Map<any>()
    t.set('name', name)
    t.set('colOrder', new Y.Array<string>())
    t.set('cols', new Y.Map<Y.Map<any>>())
    t.set('rowOrder', new Y.Array<string>())
    t.set('rows', new Y.Map<Y.Map<any>>())
    tablesOf(doc).set(id, t)
    tableOrderOf(doc).push([id])
    addColumn(doc, id, 'Name', 'text') // jede neue Tabelle startet mit der Spalte „Name“
    if (opts.firstRow ?? true) addRow(doc, id)
  })
  return id
}

let posCounter = 0
const nextPos = () => Date.now() * 1000 + (posCounter++ % 1000)

export function addColumn(
  doc: Y.Doc, tableId: string, name: string, type: ColType, target?: string, options: string[] = [], config: Record<string, unknown> = {},
): string {
  const id = uid()
  doc.transact(() => {
    const t = tablesOf(doc).get(tableId)!
    const c = new Y.Map<any>()
    c.set('name', name)
    c.set('type', type)
    if (type === 'relation' && target) c.set('target', target)
    for (const [k, v] of Object.entries(config)) c.set(CFG + k, v)
    if (type === 'select') {
      const opts = new Y.Map<any>()
      options.forEach((n, i) => opts.set(uid(), { name: n, color: OPTION_COLORS[i % OPTION_COLORS.length], pos: nextPos() }))
      c.set('options', opts)
    }
    t.get('cols').set(id, c)
    t.get('colOrder').push([id])
    if (type === 'autonumber') { // vorhandene Zeilen der Reihe nach nummerieren
      const rows: Y.Map<Y.Map<any>> = t.get('rows')
      const base = nextPos()
      t.get('rowOrder').toArray().forEach((rid: string, i: number) => rows.get(rid)?.set(id, base + i))
    }
  })
  return id
}

/**
 * Zeitmarke für „Aufsteigende Zahl“: Mikrosekunden-genaue Uhrzeit, nie kleiner als die größte schon vergebene.
 * Angezeigt wird der Rang unter allen Zeilen (siehe cells.ts), nicht die Marke selbst: gleichzeitig angelegte Zeilen
 * bekommen so beim Zusammenführen eine eindeutige Reihenfolge, ohne dass sich jemand abstimmen muss.
 */
function nextStamp(rows: Y.Map<Y.Map<any>>, colId: string): number {
  let max = 0
  rows.forEach((r) => { const v = r.get(colId); if (typeof v === 'number' && v > max) max = v })
  return Math.max(nextPos(), max + 1)
}

/** Legt eine Zeile mit den angegebenen Werten an (alles in einer Änderung, also auch in einem Schritt rückgängig zu machen). */
export function createRecord(doc: Y.Doc, tableId: string, values: Record<string, CellValue>): string {
  let id = ''
  doc.transact(() => {
    id = addRow(doc, tableId)
    for (const [col, v] of Object.entries(values)) if (v !== null && v !== '') setCell(doc, tableId, id, col, v)
  })
  return id
}

export function addRow(doc: Y.Doc, tableId: string): string {
  const id = uid()
  doc.transact(() => {
    const t = tablesOf(doc).get(tableId)!
    const row = new Y.Map<any>()
    t.get('rows').set(id, row)
    t.get('rowOrder').push([id])
    for (const [cid, c] of t.get('cols').entries()) if ((c as Y.Map<any>).get('type') === 'autonumber') row.set(cid, nextStamp(t.get('rows'), cid))
    touchStamps(t, row, true)
  })
  return id
}

export function deleteRow(doc: Y.Doc, tableId: string, rowId: string) {
  doc.transact(() => {
    const t = tablesOf(doc).get(tableId)!
    t.get('rows').delete(rowId)
    const order: Y.Array<string> = t.get('rowOrder')
    const i = order.toArray().indexOf(rowId)
    if (i >= 0) order.delete(i, 1)
  })
}

export function setCell(doc: Y.Doc, tableId: string, rowId: string, colId: string, value: CellValue) {
  const t = tablesOf(doc).get(tableId)
  const row: Y.Map<any> | undefined = t?.get('rows').get(rowId)
  if (!t || !row) return
  doc.transact(() => {
    row.set(colId, value)
    if (t.get('cols').get(colId)?.get('type') !== 'stamp') touchStamps(t, row, false)
  })
}

// ---------- Zeitstempel („Erstellt“ / „Zuletzt geändert“, mit Konto) ----------

/** Wert einer Zeitstempel-Zelle: `<Millisekunden>|<Konto>` (so steht auch dabei, wer es war). */
export const stampValue = (at: number, account: string) => `${at}|${account}`
export function parseStamp(v: unknown): { at: number; account: string } | null {
  if (typeof v !== 'string') return null
  const i = v.indexOf('|')
  const at = Number(i < 0 ? v : v.slice(0, i))
  return Number.isFinite(at) && at > 0 ? { at, account: i < 0 ? '' : v.slice(i + 1) } : null
}
/** „Zuletzt geändert“ wird höchstens so oft neu geschrieben (Tippen erzeugt sonst bei jedem Zeichen eine zweite Änderung). */
const STAMP_MIN_MS = 30_000

/** Trägt in alle Zeitstempel-Spalten der Zeile die aktuelle Zeit ein: beim Anlegen alle, bei Änderungen nur „Zuletzt geändert“. */
function touchStamps(t: Y.Map<any>, row: Y.Map<any>, creating: boolean) {
  const now = Date.now(), me = accountIdNow()
  for (const [cid, c] of t.get('cols').entries() as Iterable<[string, Y.Map<any>]>) {
    if (c.get('type') !== 'stamp') continue
    const kind = c.get(CFG + 'kind') ?? 'created'
    if (kind === 'created' && !creating) continue
    const cur = parseStamp(row.get(cid))
    if (!creating && cur && cur.account === me && now - cur.at < STAMP_MIN_MS) continue
    row.set(cid, stampValue(now, me))
  }
}

export function getCell(doc: Y.Doc, tableId: string, rowId: string, colId: string): CellValue {
  return tablesOf(doc).get(tableId)?.get('rows').get(rowId)?.get(colId) ?? null
}

/** Snapshot für die UI. Doppelte Zeilen-IDs (durch Merge) werden entfernt, verwaiste ignoriert. */
/** Typspezifische Spaltenkonfiguration: je Einstellung ein eigener Schlüssel `cfg.<name>` (parallele Änderungen verschiedener Einstellungen gehen nicht verloren). */
const CFG = 'cfg.'
const REPR = 'repr.'

export function readTables(doc: Y.Doc): TableInfo[] {
  const out: TableInfo[] = []
  tablesOf(doc).forEach((t, id) => {
    const cols: Y.Map<Y.Map<any>> = t.get('cols')
    const rows: Y.Map<Y.Map<any>> = t.get('rows')
    const columns = [...new Set<string>(t.get('colOrder').toArray())]
      .filter((cid) => cols.has(cid))
      .map((cid) => {
        const c = cols.get(cid)!
        const opts: Y.Map<any> | undefined = c.get('options')
        const options = opts
          ? [...opts.entries()]
              .map(([oid, o]) => ({ id: oid, name: o.name as string, color: o.color as string, pos: (o.pos as number) ?? 0 }))
              .sort((x, y) => x.pos - y.pos || x.id.localeCompare(y.id))
              .map(({ pos: _pos, ...rest }) => rest)
          : undefined
        const config: Record<string, unknown> = {}
        c.forEach((v, k) => { if (k.startsWith(CFG)) config[k.slice(CFG.length)] = v })
        return { id: cid, name: c.get('name'), config, type: c.get('type') as ColType, target: c.get('target') as string | undefined, options, width: c.get('width') as number | undefined, footer: c.get('footer') as string | undefined, hidden: c.get('hidden') === true ? true : undefined }
      })
    const rowIds = [...new Set<string>(t.get('rowOrder').toArray())].filter((rid) => rows.has(rid))
    const repr: Record<string, unknown> = {}
    t.forEach((v, k) => { if (k.startsWith(REPR)) repr[k.slice(REPR.length)] = v })
    out.push({ id, name: t.get('name'), columns, rowIds, repr, icon: (t.get('icon') as string | undefined) || undefined })
  })
  // Reihenfolge laut tableOrder (dedupliziert); unbekannte Tabellen (Altdaten, parallel angelegt) danach nach ID.
  const rank = new Map<string, number>()
  for (const tid of tableOrderOf(doc).toArray()) if (!rank.has(tid)) rank.set(tid, rank.size)
  out.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || a.id.localeCompare(b.id))
  return out
}

export function readViews(doc: Y.Doc): ViewInfo[] {
  const out: ViewInfo[] = []
  viewsOf(doc).forEach((v, id) => {
    const raw = (v.get('def') ?? {}) as Partial<ViewDef>
    const def: ViewDef = {
      source: raw.source ?? '',
      match: raw.match === 'any' ? 'any' : 'all',
      filters: Array.isArray(raw.filters) ? raw.filters : [],
      group: raw.group && ['none', 'column', 'all'].includes(raw.group.mode) ? raw.group : { mode: 'none' },
      aggs: raw.aggs && typeof raw.aggs === 'object' ? raw.aggs : {},
    }
    out.push({ id, name: (v.get('name') as string) ?? '', def, icon: (v.get('icon') as string | undefined) || undefined })
  })
  return out
}

// ---------- Karten ----------

/** Eigenes Objekt auf einer Karte: Punkt, Strecke oder Gebiet. Koordinaten als [lat, lon]. */
export type MapShape =
  | { kind: 'point'; lat: number; lon: number; label: string; color: string }
  | { kind: 'line' | 'area'; pts: [number, number][]; label: string; color: string }
/** Eine Geo-Spalte, deren Zeilen auf der Karte erscheinen. */
export interface MapLayer { table: string; col: string }
export interface MapInfo { id: string; name: string; layers: MapLayer[]; shapes: { id: string; shape: MapShape }[]; icon?: string }

const validShape = (s: any): s is MapShape =>
  !!s && typeof s === 'object' && typeof s.label === 'string' && typeof s.color === 'string' &&
  (s.kind === 'point' ? Number.isFinite(s.lat) && Number.isFinite(s.lon)
    : (s.kind === 'line' || s.kind === 'area') && Array.isArray(s.pts) && s.pts.length >= (s.kind === 'line' ? 2 : 3) &&
      s.pts.every((p: any) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])))

export function readMaps(doc: Y.Doc): MapInfo[] {
  const out: MapInfo[] = []
  mapsOf(doc).forEach((m, id) => {
    const layers = (m.get('layers') ?? []) as MapLayer[]
    const shapes: MapInfo['shapes'] = []
    ;(m.get('shapes') as Y.Map<MapShape> | undefined)?.forEach((shape, sid) => { if (validShape(shape)) shapes.push({ id: sid, shape }) })
    shapes.sort((a, b) => a.id.localeCompare(b.id))
    out.push({ id, name: (m.get('name') as string) ?? '', layers: Array.isArray(layers) ? layers.filter((l) => l && l.table && l.col) : [], shapes, icon: (m.get('icon') as string | undefined) || undefined })
  })
  return out
}

export function addMap(doc: Y.Doc, name: string, layers: MapLayer[], icon = ''): string {
  const id = uid()
  doc.transact(() => {
    const m = new Y.Map<any>()
    m.set('name', name)
    m.set('layers', layers)
    if (icon) m.set('icon', icon)
    m.set('shapes', new Y.Map())
    mapsOf(doc).set(id, m)
    tableOrderOf(doc).push([id])
  })
  return id
}

export function updateMap(doc: Y.Doc, id: string, patch: { name?: string; layers?: MapLayer[]; icon?: string }) {
  const m = mapsOf(doc).get(id)
  if (!m) return
  doc.transact(() => {
    if (patch.name !== undefined) m.set('name', patch.name)
    if (patch.layers !== undefined) m.set('layers', patch.layers)
    if (patch.icon !== undefined) setOrDelete(m, 'icon', patch.icon)
  })
}

export function deleteMap(doc: Y.Doc, id: string) {
  doc.transact(() => {
    mapsOf(doc).delete(id)
    const order = tableOrderOf(doc)
    const arr = order.toArray()
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] === id) order.delete(i, 1)
  })
}

/** Legt ein Objekt an oder ersetzt es (je Objekt ein eigener Schlüssel: gleichzeitiges Zeichnen geht nicht verloren). */
export function setMapShape(doc: Y.Doc, mapId: string, shapeId: string, shape: MapShape) {
  const shapes = mapsOf(doc).get(mapId)?.get('shapes') as Y.Map<MapShape> | undefined
  shapes?.set(shapeId, shape)
}
export function deleteMapShape(doc: Y.Doc, mapId: string, shapeId: string) {
  ;(mapsOf(doc).get(mapId)?.get('shapes') as Y.Map<MapShape> | undefined)?.delete(shapeId)
}

/** Eintrag der Kopfzeile; `count` = Zeilenzahl (bei Tabellen hier, bei abgeleiteten Tabellen setzt es die Oberfläche). */
export interface TabInfo { kind: 'table' | 'view' | 'map'; id: string; name: string; icon: string; count?: number }

/** Tabellen und abgeleitete Tabellen in der Reihenfolge der Kopfzeile. */
export function readTabs(doc: Y.Doc): TabInfo[] {
  const tabs: TabInfo[] = [
    ...readTables(doc).map((t) => ({ kind: 'table' as const, id: t.id, name: t.name, icon: t.icon ?? '', count: t.rowIds.length })),
    ...readViews(doc).map((v) => ({ kind: 'view' as const, id: v.id, name: v.name, icon: v.icon ?? '' })),
    ...readMaps(doc).map((m) => ({ kind: 'map' as const, id: m.id, name: m.name, icon: m.icon ?? '' })),
  ]
  const rank = new Map<string, number>()
  for (const id of tableOrderOf(doc).toArray()) if (!rank.has(id)) rank.set(id, rank.size)
  return tabs.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || a.id.localeCompare(b.id))
}

export function addView(doc: Y.Doc, name: string, def: ViewDef, icon = ''): string {
  const id = uid()
  doc.transact(() => {
    const v = new Y.Map<any>()
    v.set('name', name)
    v.set('def', def)
    if (icon) v.set('icon', icon)
    viewsOf(doc).set(id, v)
    tableOrderOf(doc).push([id])
  })
  return id
}

/** Ersetzt Name und/oder Definition (die Definition als Ganzes: bei gleichzeitigen Änderungen gewinnt eine). */
export function updateView(doc: Y.Doc, id: string, patch: { name?: string; def?: ViewDef; icon?: string }) {
  const v = viewsOf(doc).get(id)
  if (!v) return
  doc.transact(() => {
    if (patch.name !== undefined) v.set('name', patch.name)
    if (patch.def !== undefined) v.set('def', patch.def)
    if (patch.icon !== undefined) setOrDelete(v, 'icon', patch.icon)
  })
}

export function deleteView(doc: Y.Doc, id: string) {
  doc.transact(() => {
    viewsOf(doc).delete(id)
    const order = tableOrderOf(doc)
    const arr = order.toArray()
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] === id) order.delete(i, 1)
  })
}

// ---------- Relationen ----------

export const linksOf = (doc: Y.Doc) => doc.getMap<number | true>('links')
const linkKey = (t: string, r: string, c: string, x: string) => `${t}|${r}|${c}|${x}`
const linkPos = (v: unknown) => (typeof v === 'number' ? v : 0)

let lastPos = 0
/** Position für eine neue Verknüpfung: Zeitstempel, also am Ende der Zelle (streng steigend, auch bei vielen Aufrufen je Millisekunde). */
function nextLinkPos() {
  lastPos = Math.max(Date.now(), lastPos + 1)
  return lastPos
}

export function addLink(doc: Y.Doc, tableId: string, rowId: string, colId: string, targetRowId: string) {
  const links = linksOf(doc), key = linkKey(tableId, rowId, colId, targetRowId)
  if (!links.has(key)) links.set(key, nextLinkPos()) // schon vorhandene behalten ihre Stelle
}

export function removeLink(doc: Y.Doc, tableId: string, rowId: string, colId: string, targetRowId: string) {
  linksOf(doc).delete(linkKey(tableId, rowId, colId, targetRowId))
}

export interface LinkSlot { tableId: string; rowId: string; colId: string }
export type CellSlot = LinkSlot

/** Verschiebt eine Verknüpfung in eine andere Zelle (oder kopiert sie). Atomar: ein Undo-/Sync-Schritt. */
export function moveLink(doc: Y.Doc, from: LinkSlot, to: LinkSlot, targetRowId: string, copy = false, beforeRowId?: string | null) {
  const same = from.tableId === to.tableId && from.rowId === to.rowId && from.colId === to.colId
  if (same && beforeRowId === undefined) return
  doc.transact(() => {
    if (!same) {
      if (!copy) removeLink(doc, from.tableId, from.rowId, from.colId, targetRowId)
      addLink(doc, to.tableId, to.rowId, to.colId, targetRowId)
    }
    if (beforeRowId !== undefined) reorderLink(doc, to, targetRowId, beforeRowId)
  })
}

/** Zielzeilen einer Zelle in ihrer Reihenfolge, mit Positionen. */
function slotLinks(doc: Y.Doc, slot: LinkSlot): { id: string; pos: number }[] {
  const prefix = `${slot.tableId}|${slot.rowId}|${slot.colId}|`
  const out: { id: string; pos: number }[] = []
  linksOf(doc).forEach((v, key) => { if (key.startsWith(prefix)) out.push({ id: key.slice(prefix.length), pos: linkPos(v) }) })
  return out.sort((a, b) => a.pos - b.pos || (a.id < b.id ? -1 : 1))
}

/**
 * Ordnet eine Verknüpfung in ihrer Zelle um: vor `beforeRowId` (null = ans Ende).
 * Nur der Wert der verschobenen Verknüpfung ändert sich (Position zwischen den Nachbarn), damit gleichzeitiges Umordnen mischbar bleibt;
 * sind die Nachbarpositionen zu eng oder gleich, werden alle Verknüpfungen der Zelle neu nummeriert.
 */
export function reorderLink(doc: Y.Doc, slot: LinkSlot, targetRowId: string, beforeRowId: string | null) {
  doc.transact(() => {
    const list = slotLinks(doc, slot).filter((l) => l.id !== targetRowId)
    if (!slotLinks(doc, slot).some((l) => l.id === targetRowId)) return
    let i = beforeRowId === null ? list.length : list.findIndex((l) => l.id === beforeRowId)
    if (i < 0) i = list.length
    const prev = list[i - 1], next = list[i]
    const links = linksOf(doc), key = (id: string) => linkKey(slot.tableId, slot.rowId, slot.colId, id)
    let pos: number | null = null
    if (prev && next) { if (next.pos - prev.pos > 1e-3) pos = (prev.pos + next.pos) / 2 }
    else if (prev) pos = prev.pos + 1
    else if (next) pos = next.pos - 1
    else pos = nextLinkPos()
    if (pos !== null && (!prev || pos > prev.pos) && (!next || pos < next.pos)) { links.set(key(targetRowId), pos); return }
    const order = [...list.slice(0, i).map((l) => l.id), targetRowId, ...list.slice(i).map((l) => l.id)]
    order.forEach((id, n) => links.set(key(id), (n + 1) * 1024))
  })
}

export interface LinkIndex {
  /** "rowId|colId" -> Zielzeilen */
  forward: Map<string, string[]>
  /** "targetRowId|colId" -> Quellzeilen (Rückverweise) */
  backward: Map<string, string[]>
}

export function buildLinkIndex(doc: Y.Doc): LinkIndex {
  const forward = new Map<string, string[]>()
  const backward = new Map<string, string[]>()
  const push = (m: Map<string, string[]>, k: string, v: string) => {
    const a = m.get(k)
    if (a) a.push(v); else m.set(k, [v])
  }
  const pos = new Map<string, number>() // "rowId|colId|targetRowId" -> Position
  linksOf(doc).forEach((v, key) => {
    const [, r, c, x] = key.split('|')
    push(forward, `${r}|${c}`, x)
    push(backward, `${x}|${c}`, r)
    pos.set(`${r}|${c}|${x}`, linkPos(v))
  })
  for (const [k, a] of forward) a.sort((x, y) => pos.get(`${k}|${x}`)! - pos.get(`${k}|${y}`)! || (x < y ? -1 : 1))
  for (const a of backward.values()) a.sort()
  return { forward, backward }
}

export const rowExists = (doc: Y.Doc, tableId: string, rowId: string) =>
  !!tablesOf(doc).get(tableId)?.get('rows').has(rowId)

export interface RowSummary { title: string; subs: string[] }

/** Inhalt einer Kachel: erste Nicht-Relationsspalte als Titel, die nächsten zwei gefüllten als Untertitel. */
export function summarize(doc: Y.Doc, table: TableInfo, rowId: string): RowSummary {
  const row: Y.Map<any> | undefined = tablesOf(doc).get(table.id)?.get('rows').get(rowId)
  const vals = table.columns
    .filter((c) => c.type !== 'relation' && c.type !== 'file' && c.type !== 'checkbox' && c.type !== 'geo' && c.type !== 'autonumber' && c.type !== 'stamp' && c.type !== 'person' && c.type !== 'duration' && !isComputed(c))
    .map((c) => {
      const v = row?.get(c.id)
      if (c.type === 'select') return c.options?.find((o) => o.id === v)?.name ?? ''
      return v === undefined || v === null ? '' : String(v)
    })
  const [first = '', ...rest] = vals
  return { title: first || 'Ohne Titel', subs: rest.filter(Boolean).slice(0, 2) }
}

// ---------- Dateien ----------

export interface FileRef { hash: string; name: string; size: number; mime: string }

export const filesOf = (doc: Y.Doc) => doc.getMap<{ name: string; size: number; mime: string }>('files')
const fileKey = (t: string, r: string, c: string, hash: string) => `${t}|${r}|${c}|${hash}`

export function addFile(doc: Y.Doc, tableId: string, rowId: string, colId: string, ref: FileRef) {
  filesOf(doc).set(fileKey(tableId, rowId, colId, ref.hash), { name: ref.name, size: ref.size, mime: ref.mime })
}

export function removeFile(doc: Y.Doc, tableId: string, rowId: string, colId: string, hash: string) {
  filesOf(doc).delete(fileKey(tableId, rowId, colId, hash))
}

/** "rowId|colId" -> Dateien, nach Name sortiert (deterministisch auf allen Clients). */
export function buildFileIndex(doc: Y.Doc): Map<string, FileRef[]> {
  const out = new Map<string, FileRef[]>()
  filesOf(doc).forEach((meta, key) => {
    const [, r, c, hash] = key.split('|')
    const ref = { hash, ...meta }
    const k = `${r}|${c}`
    const a = out.get(k)
    if (a) a.push(ref); else out.set(k, [ref])
  })
  for (const a of out.values()) a.sort((x, y) => x.name.localeCompare(y.name) || x.hash.localeCompare(y.hash))
  return out
}

/** Verschiebt eine Datei-Referenz in eine andere Zelle (oder kopiert sie). Die Bytes bleiben unberührt. */
export function moveFile(doc: Y.Doc, from: CellSlot, to: CellSlot, ref: FileRef, copy = false) {
  if (from.tableId === to.tableId && from.rowId === to.rowId && from.colId === to.colId) return
  doc.transact(() => {
    if (!copy) removeFile(doc, from.tableId, from.rowId, from.colId, ref.hash)
    addFile(doc, to.tableId, to.rowId, to.colId, ref)
  })
}

// ---------- Auswahloptionen ----------

const optionsMap = (doc: Y.Doc, tableId: string, colId: string): Y.Map<any> | undefined =>
  tablesOf(doc).get(tableId)?.get('cols').get(colId)?.get('options')

export function addOption(doc: Y.Doc, tableId: string, colId: string, name: string, color?: string): string {
  const id = uid()
  const opts = optionsMap(doc, tableId, colId)
  const used = opts ? opts.size : 0
  opts?.set(id, { name, color: color ?? OPTION_COLORS[used % OPTION_COLORS.length], pos: nextLinkPos() })
  return id
}

export function updateOption(doc: Y.Doc, tableId: string, colId: string, optionId: string, patch: Partial<Pick<SelectOption, 'name' | 'color'>>) {
  const opts = optionsMap(doc, tableId, colId)
  const old = opts?.get(optionId)
  if (opts && old) opts.set(optionId, { ...old, ...patch })
}

/** Löscht die Option. Zellen, die noch darauf zeigen, werden dadurch einfach leer angezeigt. */
export function deleteOption(doc: Y.Doc, tableId: string, colId: string, optionId: string) {
  optionsMap(doc, tableId, colId)?.delete(optionId)
}

// ---------- Umbenennen und Löschen ----------

const setOrDelete = (m: Y.Map<any>, key: string, value: string) => { if (value) m.set(key, value); else m.delete(key) }

/** Setzt das Symbol eines Reiters (Tabelle); leer = Standard. */
export function setTableIcon(doc: Y.Doc, tableId: string, icon: string) {
  const t = tablesOf(doc).get(tableId)
  if (t) setOrDelete(t, 'icon', icon)
}

export function renameTable(doc: Y.Doc, tableId: string, name: string) {
  tablesOf(doc).get(tableId)?.set('name', name)
}

export function renameColumn(doc: Y.Doc, tableId: string, colId: string, name: string) {
  tablesOf(doc).get(tableId)?.get('cols').get(colId)?.set('name', name)
}

/** Setzt eine Einstellung der Spalte; `undefined` entfernt sie (= Standardwert des Typs). */
export function setColumnConfig(doc: Y.Doc, tableId: string, colId: string, key: string, value: unknown) {
  const c = tablesOf(doc).get(tableId)?.get('cols').get(colId)
  if (!c) return
  if (value === undefined) c.delete(CFG + key)
  else c.set(CFG + key, value)
}

/** Spaltenbreite in px (`undefined` = Standardbreite des Typs). */
/** Setzt eine Einstellung der Darstellung; `undefined` entfernt sie (= Standard). */
export function setTableRepr(doc: Y.Doc, tableId: string, key: string, value: unknown) {
  const t = tablesOf(doc).get(tableId)
  if (!t) return
  if (value === undefined) t.delete(REPR + key); else t.set(REPR + key, value)
}

/** Blendet eine Spalte in der Tabelle aus (sie bleibt für Formeln und die Darstellung nutzbar). */
export function setColumnHidden(doc: Y.Doc, tableId: string, colId: string, hidden: boolean) {
  const c = tablesOf(doc).get(tableId)?.get('cols').get(colId)
  if (!c) return
  if (hidden) c.set('hidden', true); else c.delete('hidden')
}

/** Auswertung in der Summenzeile (`undefined` = keine). */
export function setColumnFooter(doc: Y.Doc, tableId: string, colId: string, fn: string | undefined) {
  const c = tablesOf(doc).get(tableId)?.get('cols').get(colId)
  if (!c) return
  if (fn === undefined) c.delete('footer'); else c.set('footer', fn)
}

export function setColumnWidth(doc: Y.Doc, tableId: string, colId: string, width: number | undefined) {
  const c = tablesOf(doc).get(tableId)?.get('cols').get(colId)
  if (!c) return
  if (width === undefined) c.delete('width')
  else c.set('width', Math.round(width))
}

/** Entfernt alle Link-/Datei-Einträge, für die `drop(tableId, rowId, colId, last)` wahr ist. */
function purgeRefs(doc: Y.Doc, drop: (tableId: string, rowId: string, colId: string, last: string) => boolean) {
  for (const m of [linksOf(doc), filesOf(doc)] as Y.Map<unknown>[]) {
    for (const key of [...m.keys()]) {
      const [t, r, c, x] = key.split('|')
      if (drop(t, r, c, x)) m.delete(key)
    }
  }
}

/** Löscht die Spalte samt Zellwerten, Verknüpfungen und Datei-Referenzen. Die Datei-Bytes bleiben im Blob-Speicher. */
export function deleteColumn(doc: Y.Doc, tableId: string, colId: string) {
  doc.transact(() => {
    const t = tablesOf(doc).get(tableId)
    if (!t) return
    t.get('cols').delete(colId)
    const order: Y.Array<string> = t.get('colOrder')
    const arr = order.toArray()
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] === colId) order.delete(i, 1)
    t.get('rows').forEach((row: Y.Map<any>) => row.delete(colId))
    purgeRefs(doc, (tt, _r, cc) => tt === tableId && cc === colId)
  })
}

/**
 * Löscht die Tabelle mit allen Zeilen. Verknüpfungen aus anderen Tabellen auf ihre Zeilen werden entfernt;
 * deren Relationsspalten bleiben bestehen und zeigen "Zieltabelle fehlt".
 */
export function deleteTable(doc: Y.Doc, tableId: string) {
  doc.transact(() => {
    const t = tablesOf(doc).get(tableId)
    if (!t) return
    const rowIds = new Set<string>(t.get('rows').keys())
    purgeRefs(doc, (tt, _r, _c, x) => tt === tableId || rowIds.has(x))
    tablesOf(doc).delete(tableId)
    for (const v of readViews(doc)) if (v.def.source === tableId) deleteView(doc, v.id) // abgeleitete Tabellen ohne Quelle sind sinnlos
    for (const m of readMaps(doc)) if (m.layers.some((l) => l.table === tableId)) updateMap(doc, m.id, { layers: m.layers.filter((l) => l.table !== tableId) })
    const order = tableOrderOf(doc)
    const arr = order.toArray()
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] === tableId) order.delete(i, 1)
  })
}

// ---------- Reihenfolge ----------

/** Schreibt die Reihenfolge komplett neu. Parallele Verschiebungen können IDs doppeln; readTables dedupliziert deterministisch. */
function rewriteOrder(arr: Y.Array<string>, ids: string[]) {
  arr.delete(0, arr.length)
  arr.push(ids)
}

function reorder(ids: string[], id: string, toIndex: number): string[] | null {
  const rest = ids.filter((x) => x !== id)
  rest.splice(Math.max(0, Math.min(toIndex, rest.length)), 0, id)
  return rest.every((x, i) => x === ids[i]) ? null : rest
}

/** `toIndex` zählt in der Liste ohne die verschobene Tabelle. */
export function moveTable(doc: Y.Doc, tableId: string, toIndex: number) {
  const next = reorder(readTabs(doc).map((t) => t.id), tableId, toIndex)
  if (next) doc.transact(() => rewriteOrder(tableOrderOf(doc), next))
}

/** `toIndex` zählt in der Liste ohne die verschobene Spalte. */
export function moveColumn(doc: Y.Doc, tableId: string, colId: string, toIndex: number) {
  const info = readTables(doc).find((t) => t.id === tableId)
  const t = tablesOf(doc).get(tableId)
  if (!info || !t) return
  const next = reorder(info.columns.map((c) => c.id), colId, toIndex)
  if (next) doc.transact(() => rewriteOrder(t.get('colOrder'), next))
}

// ---------- Profile der Mitglieder (Name und Avatar, im Dokument selbst und daher mitverschlüsselt) ----------

export interface MemberProfile { name: string; avatar: string }
export const profilesOf = (doc: Y.Doc) => doc.getMap<MemberProfile>('profiles')

/** Trägt das eigene Profil im Dokument ein (nur wenn es sich geändert hat, damit keine überflüssigen Änderungen entstehen). */
export function publishProfile(doc: Y.Doc, account: string, p: MemberProfile) {
  const cur = profilesOf(doc).get(account)
  if (cur && cur.name === p.name && cur.avatar === p.avatar) return
  profilesOf(doc).set(account, { name: p.name, avatar: p.avatar })
}

/** Anzeigename eines Kontos im Dokument: das eingetragene Profil, für das eigene Konto notfalls der lokale Name. */
export function personName(doc: Y.Doc, account: string): string {
  const n = profilesOf(doc).get(account)?.name
  if (n) return n
  return account && account === accountIdNow() ? getAccountName() : ''
}

/** Kennungen aus einer Personen-Zelle (kommagetrennt gespeichert). */
export const personIds = (v: unknown): string[] => (typeof v === 'string' ? v.split(',').filter(Boolean) : [])
