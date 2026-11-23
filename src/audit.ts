/**
 * Änderungsprotokoll: wer hat wann was geändert. Yjs selbst speichert weder Zeit noch Konto, deshalb schreibt Grid bei jeder eigenen
 * Änderung einen Eintrag in das Dokument (Feld „audit“). Er wandert wie alle Daten zu den anderen Geräten; Änderungen anderer
 * schreiben diese Geräte selbst. Für Änderungen aus der Zeit davor gibt es nichts.
 *
 * Jeder Eintrag trägt außerdem die Gegenschritte (`u`), mit denen sich die Änderung rückgängig machen lässt. Damit kann timeTravel.ts
 * den Stand zu einem früheren Zeitpunkt aus dem heutigen Stand zurückrechnen.
 */
import * as Y from 'yjs'
import { accountIdNow } from './identity'
import { linksOf, personName, personIds, tablesOf } from './model'
import { plainText } from './richText'

/** Text ohne Formatierung; nur Werte mit Markierungen brauchen die (browserabhängige) Umwandlung. */
const plain = (v: string) => (typeof document !== 'undefined' && v.includes('<') ? plainText(v) : v)

export type AuditKind = 'cell' | 'row+' | 'row-' | 'col+' | 'col-' | 'col~' | 'tab+' | 'tab-' | 'tab~' | 'lnk+' | 'lnk-' | 'lnk~' | 'lnk>' | 'tab*' | 'col*' | 'ops' | 'bulk'
export interface AuditEntry {
  /** Zeit (ms) */ t: number
  /** Konto */ a: string
  /** Art */ k: AuditKind
  /** Tabelle */ tb?: string
  /** Zeile (Text der Darstellung) */ r?: string
  /** Kennung der Zeile (bleibt gleich, auch wenn die Zeile umbenannt wird) */ ri?: string
  /** Spalte */ c?: string
  /** vorher (bei Verknüpfungen: die verknüpfte Zeile) */ o?: string
  /** nachher (bei „verschoben“: Ziel) */ n?: string
  /** Anzahl (bei „bulk“) */ x?: number
  /** Gegenschritte (in der Reihenfolge der Änderung; zum Zurückrechnen rückwärts anwenden) */ u?: Op[]
}

/** Ein Gegenschritt. `v` fehlt = der Wert war nicht vorhanden (beim Zurückrechnen löschen). */
export interface Op {
  m: 'cell' | 'row-del' | 'row-put' | 'col-del' | 'col-put' | 'colp' | 'tab-del' | 'tab-put' | 'tabp' | 'link'
  /** Tabelle */ ti?: string
  /** Zeile */ ri?: string
  /** Spalte */ ci?: string
  /** Schlüssel (Eigenschaft bzw. Verknüpfung) */ k?: string
  /** Wert */ v?: unknown
  /** vollständiger Inhalt (gelöschte Zeile, Spalte, Tabelle) */ j?: unknown
  /** Stelle in der Reihenfolge */ ix?: number
}

export const auditOf = (doc: Y.Doc) => doc.getArray<AuditEntry>('audit')

/** Für die Anzeige: schnell aufeinanderfolgende Änderungen derselben Zelle zählen als eine (erster alter, letzter neuer Wert); ohne Hintergrundänderungen. */
export function coalesce(entries: AuditEntry[]): AuditEntry[] {
  const out: AuditEntry[] = []
  for (const e of entries) {
    if (e.k === 'ops') continue
    const last = out[out.length - 1]
    if (e.k === 'cell' && last && last.k === 'cell' && last.a === e.a && last.tb === e.tb && last.ri === e.ri && last.c === e.c && e.t - last.t < MERGE_MS) {
      out[out.length - 1] = { ...e, o: last.o }
      if (out[out.length - 1].o === e.n) out.pop()
    } else out.push(e)
  }
  return out
}

const AUDIT = Symbol('audit')
export const DEFAULT_DAYS = 90
export const DEFAULT_MAX = 20000
const MERGE_MS = 30_000 // Änderungen derselben Zelle in dieser Zeit zählen als eine
const MAX_PER_CHANGE = 100 // mehr Zellen auf einmal (Einfügen, Import) werden zu einem Eintrag zusammengefasst
const MAX_TEXT = 120

const clip = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT - 1) + '…' : s)

/** Aufbewahrung des Protokolls (im Dokument gespeichert, gilt für alle): 0 = unbegrenzt. */
export interface AuditSettings { days: number; max: number }
const settingsOf = (doc: Y.Doc) => doc.getMap<number>('settings')
export function auditSettings(doc: Y.Doc): AuditSettings {
  const m = settingsOf(doc)
  const num = (k: string, d: number) => { const v = m.get(k); return typeof v === 'number' && v >= 0 ? v : d }
  return { days: num('auditDays', DEFAULT_DAYS), max: num('auditMax', DEFAULT_MAX) }
}
export function setAuditSettings(doc: Y.Doc, s: AuditSettings) {
  doc.transact(() => { settingsOf(doc).set('auditDays', Math.max(0, Math.floor(s.days))); settingsOf(doc).set('auditMax', Math.max(0, Math.floor(s.max))) })
}

// ---------- Inhalte gerade gelöschter Typen lesen ----------
const aliveBefore = (item: any, tr: Y.Transaction) => !item.deleted || Y.isDeleted(tr.deleteSet, item.id)
const unwrap = (item: any, tr: Y.Transaction): unknown => {
  const c = item.content
  const v = c.type !== undefined ? c.type : c.getContent()[0]
  return v instanceof Y.AbstractType ? peek(v, tr) : v
}
/** Inhalt eines (in dieser Änderung) gelöschten oder noch lebenden Typs als einfache Daten. */
function peek(type: Y.AbstractType<any>, tr: Y.Transaction): unknown {
  if (type instanceof Y.Map) {
    const out: Record<string, unknown> = {}
    ;(type as any)._map.forEach((item: any, k: string) => { if (aliveBefore(item, tr)) { const v = unwrap(item, tr); if (v !== undefined) out[k] = v } })
    return out
  }
  if (type instanceof Y.Array) {
    const out: unknown[] = []
    for (let n = (type as any)._start; n; n = n.right) {
      if (!aliveBefore(n, tr)) continue
      if (n.content.type !== undefined) out.push(peek(n.content.type, tr)); else out.push(...n.content.getContent())
    }
    return out
  }
  return undefined
}
/** Alte Stelle jedes in dieser Änderung aus einer Liste gelöschten Eintrags. */
function oldIndexes(event: Y.YEvent<any>, tr: Y.Transaction): Map<unknown, number> {
  const out = new Map<unknown, number>()
  try {
    let idx = 0
    for (let n = (event.target as any)._start; n; n = n.right) {
      if (event.changes.added.has(n) || !aliveBefore(n, tr)) continue
      if (n.deleted) n.content.getContent().forEach((x: unknown, i: number) => out.set(x, idx + i))
      idx += n.length
    }
  } catch { /* ohne Stelle: die Zeile kommt beim Zurückrechnen ans Ende */ }
  return out
}

const installed = new WeakSet<Y.Doc>()

/** Beginnt, die eigenen Änderungen an diesem Dokument zu protokollieren. */
export function installAudit(doc: Y.Doc): () => void {
  if (installed.has(doc)) return () => {}
  installed.add(doc)
  const tables = tablesOf(doc)
  const tableNames = new Map<string, string>()
  const colNames = new Map<string, string>() // „tabelle.spalte“
  const refreshNames = () => {
    tableNames.clear(); colNames.clear()
    tables.forEach((t, id) => {
      tableNames.set(id, String(t.get('name') ?? ''))
      t.get('cols')?.forEach((c: Y.Map<any>, cid: string) => colNames.set(`${id}.${cid}`, String(c.get('name') ?? '')))
    })
  }
  refreshNames()

  const colType = (tb: string, col: string): string | undefined => tables.get(tb)?.get('cols')?.get(col)?.get('type')
  const show = (tb: string, col: string, v: unknown): string => {
    if (v === null || v === undefined || v === false || v === '') return ''
    const cell = tables.get(tb)?.get('cols')?.get(col)
    const type = cell?.get('type')
    if (type === 'select') return cell?.get('options')?.get(String(v))?.name ?? ''
    if (type === 'person') return personIds(v).map((id) => personName(doc, id) || 'Unbekannt').join(', ')
    if (type === 'checkbox') return v ? '✓' : ''
    if (type === 'text' && cell?.get('cfg.mode') === 'rich') return clip(plain(String(v)).trim())
    return clip(typeof v === 'object' ? JSON.stringify(v) : String(v))
  }
  // Text der Darstellung der Zeile (Titel, Untertitel wie in Relationen); auch für gerade gelöschte Zeilen
  const NOT_TEXT = new Set(['relation', 'file', 'checkbox', 'geo', 'autonumber', 'stamp', 'person', 'duration', 'rollup', 'formula', 'template'])
  const valueOf = (row: Y.Map<any>, key: string): unknown => {
    const live = row.get(key)
    if (live !== undefined) return live
    const item = (row as any)._map?.get(key) // gelöschte Zeile: der Wert liegt bis zum Aufräumen noch im Eintrag
    return item?.deleted && item.content.type === undefined ? item.content?.getContent?.()[0] : undefined
  }
  const rowLabel = (tb: string, rid: string, rowOverride?: Y.Map<any>): string => {
    const t = tables.get(tb)
    const row: Y.Map<any> | undefined = rowOverride ?? t?.get('rows')?.get(rid)
    if (!t || !row) return ''
    const cols: Y.Map<any> | undefined = t.get('cols')
    const order: string[] = t.get('colOrder')?.toArray() ?? []
    const text = (cid: string): string => {
      const c = cols?.get(cid)
      const v = valueOf(row, cid)
      if (v === undefined || v === null) return ''
      if (c?.get('type') === 'select') return c.get('options')?.get(String(v))?.name ?? ''
      return plain(String(v)).trim()
    }
    const usable = order.filter((cid) => cols?.has(cid) && !NOT_TEXT.has(cols.get(cid)!.get('type')))
    const titleCol: string | undefined = t.get('repr.title'), subCol: string | undefined = t.get('repr.sub')
    const title = (titleCol && titleCol !== '-' && cols?.has(titleCol) ? text(titleCol) : usable[0] ? text(usable[0]) : '') || 'Ohne Titel'
    const subs = subCol && cols?.has(subCol) ? [text(subCol)] : usable.slice(1).map(text).filter(Boolean).slice(0, 2)
    const subText = subs.filter((x) => x && x !== title).join(', ')
    return clip(subText ? `${title} · ${subText}` : title)
  }

  const pending = new WeakMap<Y.Transaction, AuditEntry[]>()
  const hiddenOps = new WeakMap<Y.Transaction, Op[]>()
  const addHidden = (tr: Y.Transaction, ops: Op[]) => { if (ops.length) hiddenOps.set(tr, [...(hiddenOps.get(tr) ?? []), ...ops]) }
  const addPending = (tr: Y.Transaction, es: AuditEntry[]) => { if (es.length) pending.set(tr, [...(pending.get(tr) ?? []), ...es]) }
  const optText = (o: unknown) => (o && typeof o === 'object' ? String((o as { name?: unknown }).name ?? '') : '')

  const collect = (events: Y.YEvent<any>[], tr: Y.Transaction) => {
    if (!tr.local || tr.origin === AUDIT) return
    const now = Date.now(), a = accountIdNow()
    const out: AuditEntry[] = [], hidden: Op[] = []
    const newRows = new Set<string>(), newCols = new Set<string>(), newTabs = new Set<string>(), delCols = new Set<string>()
    const rowIx = new Map<string, Map<unknown, number>>(), colIx = new Map<string, Map<unknown, number>>()
    const colCellOps = new Map<string, Op[]>() // Zellwerte gelöschter Spalten
    // erst, was angelegt oder gelöscht wurde (dessen Inhalt zählt nicht einzeln)
    for (const e of events) {
      const path = e.path as (string | number)[]
      if (e instanceof Y.YArrayEvent && path.length === 2) {
        if (path[1] === 'rowOrder') rowIx.set(String(path[0]), oldIndexes(e, tr))
        else if (path[1] === 'colOrder') colIx.set(String(path[0]), oldIndexes(e, tr))
        continue
      }
      for (const [key, ch] of e.changes.keys) {
        if (path.length === 0 && ch.action === 'add') newTabs.add(key)
        else if (path.length === 2 && path[1] === 'rows' && ch.action === 'add') newRows.add(`${path[0]}.${key}`)
        else if (path.length === 2 && path[1] === 'cols') { if (ch.action === 'add') newCols.add(`${path[0]}.${key}`); else if (ch.action === 'delete') delCols.add(`${path[0]}.${key}`) }
      }
    }
    for (const e of events) { // Zellwerte gelöschter Spalten vorab einsammeln (die Spalte kann nach den Zeilen an die Reihe kommen)
      const path = e.path as string[]
      if (!(e instanceof Y.YMapEvent) || path.length !== 3 || path[1] !== 'rows') continue
      for (const [key, ch] of e.changes.keys) {
        if (!delCols.has(`${path[0]}.${key}`)) continue
        const l = colCellOps.get(`${path[0]}.${key}`) ?? []
        l.push({ m: 'cell', ti: path[0], ri: path[2], ci: key, v: ch.action === 'add' ? undefined : ch.oldValue })
        colCellOps.set(`${path[0]}.${key}`, l)
      }
    }
    for (const e of events) {
      if (!(e instanceof Y.YMapEvent)) continue
      const path = e.path as string[]
      const target = e.target as Y.Map<any>
      for (const [key, ch] of e.changes.keys) {
        const old = ch.action === 'add' ? undefined : ch.oldValue
        if (path.length === 0) { // Tabellen
          if (ch.action === 'add') out.push({ t: now, a, k: 'tab+', tb: String(target.get(key)?.get('name') ?? ''), u: [{ m: 'tab-del', ti: key }] })
          else if (ch.action === 'delete') out.push({ t: now, a, k: 'tab-', tb: tableNames.get(key) ?? key.slice(0, 6), u: [{ m: 'tab-put', ti: key, j: peek(old as Y.Map<any>, tr) }] })
        } else if (path.length === 1) { // Eigenschaften einer Tabelle
          if (newTabs.has(path[0])) continue
          const u: Op[] = [{ m: 'tabp', ti: path[0], k: key, v: old }]
          if (key === 'name' && ch.action === 'update') out.push({ t: now, a, k: 'tab~', tb: String(old ?? ''), n: String(target.get('name') ?? ''), u })
          else if (typeof old !== 'object' && typeof target.get(key) !== 'object') out.push({ t: now, a, k: 'tab*', tb: tableNames.get(path[0]) ?? '', c: key, o: clip(String(old ?? '')), n: clip(String(target.get(key) ?? '')), u })
          else hidden.push(...u)
        } else if (path[1] === 'rows' && path.length === 2) {
          const tb = tableNames.get(path[0]) ?? String(tables.get(path[0])?.get('name') ?? '')
          if (newTabs.has(path[0])) continue
          if (ch.action === 'add') out.push({ t: now, a, k: 'row+', tb, r: rowLabel(path[0], key), ri: key, u: [{ m: 'row-del', ti: path[0], ri: key }] })
          else if (ch.action === 'delete') out.push({ t: now, a, k: 'row-', tb, r: rowLabel(path[0], key, old as Y.Map<any>), ri: key,
            u: [{ m: 'row-put', ti: path[0], ri: key, j: peek(old as Y.Map<any>, tr), ix: rowIx.get(path[0])?.get(key) }] })
        } else if (path[1] === 'cols' && path.length === 2) {
          if (newTabs.has(path[0])) continue
          const tb = tableNames.get(path[0]) ?? ''
          if (ch.action === 'add') out.push({ t: now, a, k: 'col+', tb, c: String(target.get(key)?.get('name') ?? ''), u: [{ m: 'col-del', ti: path[0], ci: key }] })
          else if (ch.action === 'delete') {
            const cell = colCellOps.get(`${path[0]}.${key}`)
            out.push({ t: now, a, k: 'col-', tb, c: colNames.get(`${path[0]}.${key}`) ?? key.slice(0, 6),
              u: [{ m: 'col-put', ti: path[0], ci: key, j: peek(old as Y.Map<any>, tr), ix: colIx.get(path[0])?.get(key) }, ...(cell ?? [])] })
          }
        } else if (path[1] === 'cols' && path.length === 3) {
          if (newCols.has(`${path[0]}.${path[2]}`) || newTabs.has(path[0]) || delCols.has(`${path[0]}.${path[2]}`)) continue
          const u: Op[] = [{ m: 'colp', ti: path[0], ci: path[2], k: key, v: old }]
          const tb = tableNames.get(path[0]) ?? ''
          if (key === 'name' && ch.action === 'update') out.push({ t: now, a, k: 'col~', tb, c: String(old ?? ''), n: String(target.get('name') ?? ''), u })
          else if (key === 'width' || key === 'hidden' || typeof old === 'object' || typeof target.get(key) === 'object') hidden.push(...u)
          else out.push({ t: now, a, k: 'col*', tb, c: colNames.get(`${path[0]}.${path[2]}`) ?? '', o: clip(`${key}: ${old ?? ''}`), n: clip(`${key}: ${target.get(key) ?? ''}`), u })
        } else if (path[1] === 'cols' && path.length === 4 && path[3] === 'options') { // Auswahloptionen
          if (newCols.has(`${path[0]}.${path[2]}`) || newTabs.has(path[0]) || delCols.has(`${path[0]}.${path[2]}`)) continue
          out.push({ t: now, a, k: 'col*', tb: tableNames.get(path[0]) ?? '', c: colNames.get(`${path[0]}.${path[2]}`) ?? '', o: old === undefined ? '' : clip(`Option: ${optText(old)}`),
            n: ch.action === 'delete' ? '' : clip(`Option: ${optText(target.get(key))}`), u: [{ m: 'colp', ti: path[0], ci: path[2], k: `options.${key}`, v: old }] })
        } else if (path[1] === 'rows' && path.length === 3) { // Zellen
          const [tb, , rid] = path
          if (newTabs.has(tb) || newRows.has(`${tb}.${rid}`) || newCols.has(`${tb}.${key}`)) continue
          const op: Op = { m: 'cell', ti: tb, ri: rid, ci: key, v: old }
          if (delCols.has(`${tb}.${key}`)) continue
          const type = colType(tb, key)
          if (!type || type === 'stamp' || type === 'autonumber') { hidden.push(op); continue }
          const o = ch.action === 'add' ? '' : show(tb, key, ch.oldValue)
          const n = ch.action === 'delete' ? '' : show(tb, key, target.get(key))
          if (o === n && ch.oldValue === target.get(key)) continue
          if (o === n) { hidden.push(op); continue }
          out.push({ t: now, a, k: 'cell', tb: tableNames.get(tb) ?? '', r: rowLabel(tb, rid), ri: rid, c: colNames.get(`${tb}.${key}`) ?? '', o, n, u: [op] })
        }
      }
    }
    addPending(tr, out); addHidden(tr, hidden)
  }

  // Relationen: Schlüssel „tabelle|zeile|spalte|ziel“, Wert = Position in der Zelle
  const collectLinks = (event: Y.YMapEvent<any>, tr: Y.Transaction) => {
    if (!tr.local || tr.origin === AUDIT) return
    const now = Date.now(), a = accountIdNow()
    const split = (key: string) => { const [tb, rid, cid, target] = key.split('|'); return { tb, rid, cid, target } }
    const targetLabel = (tb: string, cid: string, target: string) => {
      const tt = tables.get(tb)?.get('cols')?.get(cid)?.get('target')
      return (tt && rowLabel(tt, target)) || target.slice(0, 6)
    }
    const links = event.target as Y.Map<any>
    const added: string[] = [], removed: string[] = [], reordered = new Map<string, string[]>()
    const hidden: Op[] = []
    const opOf = (key: string, ch: { action: string; oldValue?: unknown }): Op => ({ m: 'link', k: key, v: ch.action === 'add' ? undefined : ch.oldValue })
    const ops = new Map<string, Op>()
    for (const [key, ch] of event.changes.keys) {
      ops.set(key, opOf(key, ch))
      if (key.split('|').length !== 4) { hidden.push(ops.get(key)!); continue }
      if (ch.action === 'add') added.push(key)
      else if (ch.action === 'delete') removed.push(key)
      else if (ch.oldValue !== links.get(key)) {
        const s = split(key), cell = `${s.tb}|${s.rid}|${s.cid}`
        reordered.set(cell, [...(reordered.get(cell) ?? []), key])
      }
    }
    const out: AuditEntry[] = []
    const base = (k: string) => { const s = split(k); return { tb: tableNames.get(s.tb) ?? '', r: rowLabel(s.tb, s.rid), ri: s.rid, c: colNames.get(`${s.tb}.${s.cid}`) ?? '' } }
    // gleiche Zielzeile weg aus einer Zelle und neu in einer anderen = verschoben
    const used = new Set<string>()
    for (const rk of removed) {
      const from = split(rk)
      const to = added.find((ak) => !used.has(ak) && split(ak).target === from.target)
      if (!to) continue
      used.add(to); used.add(rk)
      const d = split(to)
      out.push({ t: now, a, k: 'lnk>', ...base(rk), o: targetLabel(from.tb, from.cid, from.target), u: [ops.get(rk)!, ops.get(to)!],
        n: [tableNames.get(d.tb), rowLabel(d.tb, d.rid), colNames.get(`${d.tb}.${d.cid}`)].filter(Boolean).join(' · ') })
    }
    for (const k of added) if (!used.has(k)) { const s = split(k); out.push({ t: now, a, k: 'lnk+', ...base(k), n: targetLabel(s.tb, s.cid, s.target), u: [ops.get(k)!] }) }
    for (const k of removed) if (!used.has(k)) { const s = split(k); out.push({ t: now, a, k: 'lnk-', ...base(k), o: targetLabel(s.tb, s.cid, s.target), u: [ops.get(k)!] }) }
    for (const [cell, keys] of reordered) {
      const [tb, rid, cid] = cell.split('|')
      out.push({ t: now, a, k: 'lnk~', tb: tableNames.get(tb) ?? '', r: rowLabel(tb, rid), ri: rid, c: colNames.get(`${tb}.${cid}`) ?? '',
        n: keys.length === 1 ? targetLabel(tb, cid, keys[0].split('|')[3]) : '', u: keys.map((k) => ops.get(k)!) })
    }
    addPending(tr, out); addHidden(tr, hidden)
  }

  const append = (entries: AuditEntry[]) => {
    const log = auditOf(doc)
    const toAdd = entries // jede Änderung bleibt einzeln erhalten (für den Stand zu einem Zeitpunkt); die Anzeige fasst schnelle Änderungen zusammen
    if (toAdd.length) log.push(toAdd)
    // Begrenzen (Einstellung des Dokuments; 0 = unbegrenzt): zu alte und zu viele Einträge vorn abschneiden
    const { days, max } = auditSettings(doc)
    let drop = max > 0 ? Math.max(0, log.length - max) : 0
    if (days > 0) {
      const cutoff = Date.now() - days * 24 * 3600 * 1000
      for (let i = 0; i < 1000 && drop < log.length && log.get(drop).t < cutoff; i++) drop++
    }
    if (drop > 0) log.delete(0, drop)
  }

  const onDeep = (events: Y.YEvent<any>[], tr: Y.Transaction) => collect(events, tr)
  const onAfter = (tr: Y.Transaction) => {
    let entries = pending.get(tr) ?? []
    const hidden = hiddenOps.get(tr)
    pending.delete(tr); hiddenOps.delete(tr)
    if (hidden?.length) {
      if (entries.length) entries[0] = { ...entries[0], u: [...(entries[0].u ?? []), ...hidden] }
      else entries = [{ t: Date.now(), a: accountIdNow(), k: 'ops', u: hidden }]
    }
    if (entries.length > MAX_PER_CHANGE) entries = [{ t: entries[0].t, a: entries[0].a, k: 'bulk', x: entries.length, u: entries.flatMap((e) => e.u ?? []) }]
    if (entries.length) doc.transact(() => append(entries), AUDIT)
    if (tr.local) refreshNames()
  }
  const links = linksOf(doc)
  const onLinks = (event: Y.YMapEvent<any>, tr: Y.Transaction) => collectLinks(event, tr)
  tables.observeDeep(onDeep)
  links.observe(onLinks)
  doc.on('afterTransaction', onAfter)
  return () => { tables.unobserveDeep(onDeep); links.unobserve(onLinks); doc.off('afterTransaction', onAfter); installed.delete(doc) }
}

export const KIND_LABEL: Record<AuditKind, string> = {
  cell: 'Zelle geändert', 'row+': 'Zeile angelegt', 'row-': 'Zeile gelöscht', 'col+': 'Spalte angelegt', 'col-': 'Spalte gelöscht',
  'col~': 'Spalte umbenannt', 'col*': 'Spalteneinstellung geändert', 'tab+': 'Tabelle angelegt', 'tab-': 'Tabelle gelöscht', 'tab~': 'Tabelle umbenannt',
  'tab*': 'Tabelleneinstellung geändert', 'lnk+': 'Verknüpfung hinzugefügt', 'lnk-': 'Verknüpfung entfernt', 'lnk~': 'Verknüpfung umsortiert',
  'lnk>': 'Verknüpfung verschoben', ops: 'Hintergrundänderung', bulk: 'Viele Änderungen',
}
