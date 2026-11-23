/**
 * Änderungsprotokoll: wer hat wann was geändert. Yjs selbst speichert weder Zeit noch Konto, deshalb schreibt Grid bei jeder eigenen
 * Änderung einen Eintrag in das Dokument (Feld „audit“). Er wandert wie alle Daten zu den anderen Geräten; Änderungen anderer
 * schreiben diese Geräte selbst. Für Änderungen aus der Zeit davor gibt es nichts.
 */
import * as Y from 'yjs'
import { accountIdNow } from './identity'
import { linksOf, personName, personIds, tablesOf } from './model'
import { plainText } from './richText'

/** Text ohne Formatierung; nur Werte mit Markierungen brauchen die (browserabhängige) Umwandlung. */
const plain = (v: string) => (typeof document !== 'undefined' && v.includes('<') ? plainText(v) : v)

export type AuditKind = 'cell' | 'row+' | 'row-' | 'col+' | 'col-' | 'col~' | 'tab+' | 'tab-' | 'tab~' | 'lnk+' | 'lnk-' | 'lnk~' | 'lnk>' | 'bulk'
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
}

export const auditOf = (doc: Y.Doc) => doc.getArray<AuditEntry>('audit')

const AUDIT = Symbol('audit')
const MAX_ENTRIES = 20000
const MAX_AGE_MS = 90 * 24 * 3600 * 1000
const MERGE_MS = 30_000 // Änderungen derselben Zelle in dieser Zeit zählen als eine
const MAX_PER_CHANGE = 100 // mehr Zellen auf einmal (Einfügen, Import) werden zu einem Eintrag zusammengefasst
const MAX_TEXT = 120

const clip = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT - 1) + '…' : s)

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
    return item?.deleted ? item.content?.getContent?.()[0] : undefined
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

  const collect = (events: Y.YEvent<any>[], tr: Y.Transaction) => {
    if (!tr.local || tr.origin === AUDIT) return
    const now = Date.now(), a = accountIdNow()
    const out: AuditEntry[] = []
    const newRows = new Set<string>(), newCols = new Set<string>(), newTabs = new Set<string>()
    // erst, was angelegt wurde (dessen Inhalt zählt nicht einzeln)
    for (const e of events) {
      const path = e.path as (string | number)[]
      for (const [key, ch] of e.changes.keys) {
        if (ch.action !== 'add') continue
        if (path.length === 0) newTabs.add(key)
        else if (path.length === 2 && path[1] === 'rows') newRows.add(`${path[0]}.${key}`)
        else if (path.length === 2 && path[1] === 'cols') newCols.add(`${path[0]}.${key}`)
      }
    }
    for (const e of events) {
      const path = e.path as string[]
      const target = e.target as Y.Map<any>
      for (const [key, ch] of e.changes.keys) {
        if (path.length === 0) { // Tabellen
          if (ch.action === 'add') out.push({ t: now, a, k: 'tab+', tb: String(target.get(key)?.get('name') ?? '') })
          else if (ch.action === 'delete') out.push({ t: now, a, k: 'tab-', tb: tableNames.get(key) ?? key.slice(0, 6) })
        } else if (path.length === 1) { // Eigenschaften einer Tabelle
          if (key === 'name' && ch.action === 'update' && !newTabs.has(path[0])) out.push({ t: now, a, k: 'tab~', tb: String(ch.oldValue ?? ''), n: String(target.get('name') ?? '') })
        } else if (path[1] === 'rows' && path.length === 2) {
          const tb = tableNames.get(path[0]) ?? String(tables.get(path[0])?.get('name') ?? '')
          if (newTabs.has(path[0])) continue
          if (ch.action === 'add') out.push({ t: now, a, k: 'row+', tb, r: rowLabel(path[0], key), ri: key })
          else if (ch.action === 'delete') out.push({ t: now, a, k: 'row-', tb, r: rowLabel(path[0], key, ch.oldValue as Y.Map<any>), ri: key })
        } else if (path[1] === 'cols' && path.length === 2) {
          if (newTabs.has(path[0])) continue
          const tb = tableNames.get(path[0]) ?? ''
          if (ch.action === 'add') out.push({ t: now, a, k: 'col+', tb, c: String(target.get(key)?.get('name') ?? '') })
          else if (ch.action === 'delete') out.push({ t: now, a, k: 'col-', tb, c: colNames.get(`${path[0]}.${key}`) ?? key.slice(0, 6) })
        } else if (path[1] === 'cols' && path.length === 3) {
          if (key === 'name' && ch.action === 'update' && !newCols.has(`${path[0]}.${path[2]}`) && !newTabs.has(path[0]))
            out.push({ t: now, a, k: 'col~', tb: tableNames.get(path[0]) ?? '', c: String(ch.oldValue ?? ''), n: String(target.get('name') ?? '') })
        } else if (path[1] === 'rows' && path.length === 3) { // Zellen
          const [tb, , rid] = path
          if (newTabs.has(tb) || newRows.has(`${tb}.${rid}`) || newCols.has(`${tb}.${key}`)) continue
          const type = colType(tb, key)
          if (!type || type === 'stamp' || type === 'autonumber') continue
          const o = ch.action === 'add' ? '' : show(tb, key, ch.oldValue)
          const n = ch.action === 'delete' ? '' : show(tb, key, target.get(key))
          if (o === n) continue
          out.push({ t: now, a, k: 'cell', tb: tableNames.get(tb) ?? '', r: rowLabel(tb, rid), ri: rid, c: colNames.get(`${tb}.${key}`) ?? '', o, n })
        }
      }
    }
    if (out.length) pending.set(tr, [...(pending.get(tr) ?? []), ...out])
  }

  // Relationen: Schlüssel „tabelle|zeile|spalte|ziel“, Wert = Position in der Zelle
  const collectLinks = (event: Y.YEvent<any>, tr: Y.Transaction) => {
    if (!tr.local || tr.origin === AUDIT) return
    const now = Date.now(), a = accountIdNow()
    const split = (key: string) => { const [tb, rid, cid, target] = key.split('|'); return { tb, rid, cid, target } }
    const targetLabel = (tb: string, cid: string, target: string) => {
      const tt = tables.get(tb)?.get('cols')?.get(cid)?.get('target')
      return (tt && rowLabel(tt, target)) || target.slice(0, 6)
    }
    const added: string[] = [], removed: string[] = [], reordered = new Map<string, number>()
    for (const [key, ch] of event.changes.keys) {
      if (key.split('|').length !== 4) continue
      if (ch.action === 'add') added.push(key)
      else if (ch.action === 'delete') removed.push(key)
      else if (ch.oldValue !== (event.target as Y.Map<any>).get(key)) {
        const s = split(key), cell = `${s.tb}|${s.rid}|${s.cid}`
        reordered.set(cell, (reordered.get(cell) ?? 0) + 1)
      }
    }
    const out: AuditEntry[] = []
    const base = (k: string) => { const s = split(k); return { s, tb: tableNames.get(s.tb) ?? '', r: rowLabel(s.tb, s.rid), ri: s.rid, c: colNames.get(`${s.tb}.${s.cid}`) ?? '' } }
    // gleiche Zielzeile weg aus einer Zelle und neu in einer anderen = verschoben
    const used = new Set<string>()
    for (const rk of removed) {
      const from = split(rk)
      const to = added.find((ak) => !used.has(ak) && split(ak).target === from.target)
      if (!to) continue
      used.add(to); used.add(rk)
      const b = base(rk), d = split(to)
      out.push({ t: now, a, k: 'lnk>', tb: b.tb, r: b.r, ri: b.ri, c: b.c, o: targetLabel(from.tb, from.cid, from.target),
        n: [tableNames.get(d.tb), rowLabel(d.tb, d.rid), colNames.get(`${d.tb}.${d.cid}`)].filter(Boolean).join(' · ') })
    }
    for (const k of added) if (!used.has(k)) { const b = base(k); out.push({ t: now, a, k: 'lnk+', tb: b.tb, r: b.r, ri: b.ri, c: b.c, n: targetLabel(split(k).tb, split(k).cid, split(k).target) }) }
    for (const k of removed) if (!used.has(k)) { const b = base(k), s = split(k); out.push({ t: now, a, k: 'lnk-', tb: b.tb, r: b.r, ri: b.ri, c: b.c, o: targetLabel(s.tb, s.cid, s.target) }) }
    for (const [cell, n] of reordered) {
      const [tb, rid, cid] = cell.split('|')
      const upd = [...event.changes.keys].find(([k, ch]) => ch.action === 'update' && k.startsWith(`${cell}|`) && ch.oldValue !== (event.target as Y.Map<any>).get(k))
      out.push({ t: now, a, k: 'lnk~', tb: tableNames.get(tb) ?? '', r: rowLabel(tb, rid), ri: rid, c: colNames.get(`${tb}.${cid}`) ?? '',
        n: n === 1 && upd ? targetLabel(tb, cid, upd[0].split('|')[3]) : '' })
    }
    if (out.length) pending.set(tr, [...(pending.get(tr) ?? []), ...out])
  }

  const append = (entries: AuditEntry[]) => {
    const log = auditOf(doc)
    const toAdd: AuditEntry[] = []
    for (const e of entries) {
      const last = toAdd.length ? toAdd[toAdd.length - 1] : log.length ? log.get(log.length - 1) : undefined
      const same = e.k === 'cell' && last && last.k === 'cell' && last.a === e.a && last.tb === e.tb && last.ri === e.ri && last.c === e.c && e.t - last.t < MERGE_MS
      if (same) {
        const merged = { ...e, o: last!.o }
        if (toAdd.length) toAdd.pop(); else log.delete(log.length - 1, 1)
        if (merged.o !== merged.n) toAdd.push(merged)
      } else toAdd.push(e)
    }
    if (toAdd.length) log.push(toAdd)
    // Begrenzen: zu alte und zu viele Einträge vorn abschneiden
    const cutoff = Date.now() - MAX_AGE_MS
    let drop = Math.max(0, log.length - MAX_ENTRIES)
    for (let i = 0; i < 1000 && drop < log.length && log.get(drop).t < cutoff; i++) drop++
    if (drop > 0) log.delete(0, drop)
  }

  const onDeep = (events: Y.YEvent<any>[], tr: Y.Transaction) => collect(events, tr)
  const onAfter = (tr: Y.Transaction) => {
    let entries = pending.get(tr)
    pending.delete(tr)
    if (entries && entries.length > MAX_PER_CHANGE) entries = [{ t: entries[0].t, a: entries[0].a, k: 'bulk', x: entries.length }]
    if (entries) doc.transact(() => append(entries), AUDIT)
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
  'col~': 'Spalte umbenannt', 'lnk+': 'Verknüpfung hinzugefügt', 'lnk-': 'Verknüpfung entfernt', 'lnk~': 'Verknüpfung umsortiert', 'lnk>': 'Verknüpfung verschoben', 'tab+': 'Tabelle angelegt', 'tab-': 'Tabelle gelöscht', 'tab~': 'Tabelle umbenannt', bulk: 'Viele Änderungen',
}
