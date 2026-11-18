import * as Y from 'yjs'

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
 *   links: Y.Map<"tableId|rowId|colId|targetRowId", true>   (Relationen als Menge)
 *     Jede Verknüpfung ist ein eigener Schlüssel: gleichzeitiges Hinzufügen
 *     verschiedener Ziele in derselben Zelle geht beim Merge nicht verloren.
 *     Die Rückrichtung wird nicht gespeichert, sondern aus dem Index berechnet.
 *
 *   files: Y.Map<"tableId|rowId|colId|hash", { name, size, mime }>   (Datei-Anhänge als Menge)
 *     Das Dokument enthält nur Referenzen (SHA-256). Die Bytes liegen im Blob-Speicher
 *     (siehe blobStore.ts) und werden später separat mit dem Server abgeglichen.
 */

export type ColType = 'text' | 'number' | 'relation' | 'file' | 'select' | 'date' | 'checkbox'
export type CellValue = string | number | null

export interface SelectOption { id: string; name: string; color: string }
export interface ColumnInfo { id: string; name: string; type: ColType; target?: string; options?: SelectOption[]; width?: number; config?: Record<string, unknown> }

/** Farb-IDs für Auswahloptionen; die konkreten Farben stehen in der UI (SelectCell.tsx). */
export const OPTION_COLORS = ['sand', 'green', 'blue', 'rose', 'violet', 'gray'] as const
export interface TableInfo {
  id: string
  name: string
  columns: ColumnInfo[]
  rowIds: string[]
}

export const uid = () => crypto.randomUUID().slice(0, 8)

export const tablesOf = (doc: Y.Doc) => doc.getMap<Y.Map<any>>('tables')
const tableOrderOf = (doc: Y.Doc) => doc.getArray<string>('tableOrder')

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
  doc: Y.Doc, tableId: string, name: string, type: ColType, target?: string, options: string[] = [],
): string {
  const id = uid()
  doc.transact(() => {
    const t = tablesOf(doc).get(tableId)!
    const c = new Y.Map<any>()
    c.set('name', name)
    c.set('type', type)
    if (type === 'relation' && target) c.set('target', target)
    if (type === 'select') {
      const opts = new Y.Map<any>()
      options.forEach((n, i) => opts.set(uid(), { name: n, color: OPTION_COLORS[i % OPTION_COLORS.length], pos: nextPos() }))
      c.set('options', opts)
    }
    t.get('cols').set(id, c)
    t.get('colOrder').push([id])
  })
  return id
}

export function addRow(doc: Y.Doc, tableId: string): string {
  const id = uid()
  doc.transact(() => {
    const t = tablesOf(doc).get(tableId)!
    t.get('rows').set(id, new Y.Map<any>())
    t.get('rowOrder').push([id])
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
  const row: Y.Map<any> | undefined = tablesOf(doc).get(tableId)?.get('rows').get(rowId)
  row?.set(colId, value)
}

export function getCell(doc: Y.Doc, tableId: string, rowId: string, colId: string): CellValue {
  return tablesOf(doc).get(tableId)?.get('rows').get(rowId)?.get(colId) ?? null
}

/** Snapshot für die UI. Doppelte Zeilen-IDs (durch Merge) werden entfernt, verwaiste ignoriert. */
/** Typspezifische Spaltenkonfiguration: je Einstellung ein eigener Schlüssel `cfg.<name>` (parallele Änderungen verschiedener Einstellungen gehen nicht verloren). */
const CFG = 'cfg.'

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
        return { id: cid, name: c.get('name'), config, type: c.get('type') as ColType, target: c.get('target') as string | undefined, options, width: c.get('width') as number | undefined }
      })
    const rowIds = [...new Set<string>(t.get('rowOrder').toArray())].filter((rid) => rows.has(rid))
    out.push({ id, name: t.get('name'), columns, rowIds })
  })
  // Reihenfolge laut tableOrder (dedupliziert); unbekannte Tabellen (Altdaten, parallel angelegt) danach nach ID.
  const rank = new Map<string, number>()
  for (const tid of tableOrderOf(doc).toArray()) if (!rank.has(tid)) rank.set(tid, rank.size)
  out.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || a.id.localeCompare(b.id))
  return out
}

// ---------- Relationen ----------

export const linksOf = (doc: Y.Doc) => doc.getMap<boolean>('links')
const linkKey = (t: string, r: string, c: string, x: string) => `${t}|${r}|${c}|${x}`

export function addLink(doc: Y.Doc, tableId: string, rowId: string, colId: string, targetRowId: string) {
  linksOf(doc).set(linkKey(tableId, rowId, colId, targetRowId), true)
}

export function removeLink(doc: Y.Doc, tableId: string, rowId: string, colId: string, targetRowId: string) {
  linksOf(doc).delete(linkKey(tableId, rowId, colId, targetRowId))
}

export interface LinkSlot { tableId: string; rowId: string; colId: string }
export type CellSlot = LinkSlot

/** Verschiebt eine Verknüpfung in eine andere Zelle (oder kopiert sie). Atomar: ein Undo-/Sync-Schritt. */
export function moveLink(doc: Y.Doc, from: LinkSlot, to: LinkSlot, targetRowId: string, copy = false) {
  if (from.tableId === to.tableId && from.rowId === to.rowId && from.colId === to.colId) return
  doc.transact(() => {
    if (!copy) removeLink(doc, from.tableId, from.rowId, from.colId, targetRowId)
    addLink(doc, to.tableId, to.rowId, to.colId, targetRowId)
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
  linksOf(doc).forEach((_, key) => {
    const [, r, c, x] = key.split('|')
    push(forward, `${r}|${c}`, x)
    push(backward, `${x}|${c}`, r)
  })
  for (const m of [forward, backward]) for (const a of m.values()) a.sort()
  return { forward, backward }
}

export const rowExists = (doc: Y.Doc, tableId: string, rowId: string) =>
  !!tablesOf(doc).get(tableId)?.get('rows').has(rowId)

export interface RowSummary { title: string; subs: string[] }

/** Inhalt einer Kachel: erste Nicht-Relationsspalte als Titel, die nächsten zwei gefüllten als Untertitel. */
export function summarize(doc: Y.Doc, table: TableInfo, rowId: string): RowSummary {
  const row: Y.Map<any> | undefined = tablesOf(doc).get(table.id)?.get('rows').get(rowId)
  const vals = table.columns
    .filter((c) => c.type !== 'relation' && c.type !== 'file' && c.type !== 'checkbox')
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
  opts?.set(id, { name, color: color ?? OPTION_COLORS[used % OPTION_COLORS.length], pos: nextPos() })
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
  const next = reorder(readTables(doc).map((t) => t.id), tableId, toIndex)
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
