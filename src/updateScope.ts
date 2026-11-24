/**
 * Was ändert ein Yjs-Update im Dokument? (Rechte Phase 2, docs/RIGHTS.md)
 * Ohne das Update anzuwenden: jede neue oder gelöschte Stelle wird über ihre Eltern bis zur Wurzel verfolgt und einem Bereich zugeordnet:
 * Zeilendaten einer Tabelle, Objekte einer Karte, frei für alle Mitglieder (Änderungsprotokoll, Profile) oder Struktur (nur Admins).
 * Was das Dokument schon kennt, zählt nicht; Stellen, deren Eltern fehlen, gelten als unbekannt.
 */
import * as Y from 'yjs'

export interface Scope {
  /** Tabellen, an deren Zeilen, Verknüpfungen oder Dateien etwas geändert wird */
  tables: Set<string>
  /** Karten, an deren Objekten (Punkte, Strecken, Gebiete) etwas geändert wird */
  maps: Set<string>
  /** Änderungen an Tabellen, Spalten, Relationen, Sichten, Karten selbst, Reihenfolge, Einstellungen: nur Admins */
  structure: boolean
  /** Stellen, die sich nicht zuordnen ließen (Eltern fehlen): wie Struktur behandeln */
  unknown: boolean
}

type Seg = string | '#'
type Loc = { container: Seg[]; key: Seg } | null

const TABLE_ID = /^[0-9a-zA-Z-]{1,64}$/

/** Der Pfad des Typs (von der Wurzel an); Einträge in Listen heißen '#'. */
function typePath(type: Y.AbstractType<any>): Seg[] | null {
  const item = type._item
  if (!item) {
    for (const [name, t] of type.doc?.share ?? []) if (t === type) return [name]
    return null
  }
  const up = item.parent instanceof Y.AbstractType ? typePath(item.parent) : null
  return up && [...up, item.parentSub ?? '#']
}

export function scopeOf(doc: Y.Doc, update: Uint8Array): Scope {
  const scope: Scope = { tables: new Set(), maps: new Set(), structure: false, unknown: false }
  const { structs, ds } = Y.decodeUpdate(update)
  const store = doc.store

  // Die Stellen des Updates selbst, nach Kennung auffindbar (Eltern können im selben Update stehen)
  type NewItem = { id: { client: number; clock: number }; length: number; parent: unknown; parentSub: string | null; origin: any; rightOrigin: any }
  const fresh: NewItem[] = []
  for (const s of structs as any[]) {
    if (!(s instanceof Y.Item) && !('parent' in s && 'content' in s)) continue
    if (s.id.clock + s.length <= Y.getState(store, s.id.client)) continue // schon bekannt
    fresh.push(s)
  }
  const inUpdate = (id: { client: number; clock: number }) =>
    fresh.find((s) => s.id.client === id.client && id.clock >= s.id.clock && id.clock < s.id.clock + s.length)

  const memo = new Map<NewItem, Loc>()
  const busy = new Set<NewItem>()

  /** Wo sitzt das Element mit dieser Kennung (Behälter und Schlüssel)? */
  function locate(id: { client: number; clock: number }): Loc {
    const n = inUpdate(id)
    if (n) return locateNew(n)
    if (id.clock >= Y.getState(store, id.client)) return null
    let item: any
    try { item = Y.getItem(store, id) } catch { return null }
    if (!(item instanceof Y.Item) || !(item.parent instanceof Y.AbstractType)) return null
    const container = typePath(item.parent)
    return container && { container, key: item.parentSub ?? '#' }
  }

  function locateNew(s: NewItem): Loc {
    if (memo.has(s)) return memo.get(s)!
    if (busy.has(s)) return null
    busy.add(s)
    let loc: Loc = null
    if (typeof s.parent === 'string') loc = { container: [s.parent], key: s.parentSub ?? '#' }
    else if (s.parent) { // Behälter ist ein Element: sein Ort plus sein Schlüssel
      const p = locate(s.parent as { client: number; clock: number })
      loc = p && { container: [...p.container, p.key], key: s.parentSub ?? '#' }
    } else { // Behälter und Schlüssel ergeben sich aus dem Nachbarn
      const near = s.origin ?? s.rightOrigin
      const o = near ? locate(near) : null
      loc = o && { container: o.container, key: s.parentSub ?? o.key }
    }
    busy.delete(s)
    memo.set(s, loc)
    return loc
  }

  const note = (loc: Loc) => {
    if (!loc) { scope.unknown = true; return }
    const p = [...loc.container, loc.key]
    switch (p[0]) {
      case 'audit': case 'profiles': return // jedes Mitglied schreibt Änderungsprotokoll und eigenes Profil
      case 'tables': {
        const tid = p[1]
        if (p.length <= 2) { scope.structure = true; return }
        if ((p[2] === 'rows' || p[2] === 'rowOrder') && p.length > 3) { scope.tables.add(tid); return }
        scope.structure = true
        return
      }
      case 'links': case 'files': {
        const tid = String(p[1]).split('|')[0]
        if (p.length === 2 && TABLE_ID.test(tid)) scope.tables.add(tid); else scope.structure = true
        return
      }
      case 'maps': {
        if (p.length > 3 && p[2] === 'shapes') scope.maps.add(p[1]); else scope.structure = true
        return
      }
      default: scope.structure = true // views, tableOrder, settings und alles Unbekannte
    }
  }

  for (const s of fresh) note(locateNew(s))

  // Gelöschtes: die vorhandenen Elemente in den Bereichen des Löschsatzes
  for (const [client, ranges] of ds.clients) {
    const known = Y.getState(store, client)
    for (const r of ranges) {
      let clock = r.clock
      const end = r.clock + r.len
      while (clock < end) {
        const n = inUpdate({ client, clock })
        if (n) { clock = n.id.clock + n.length; continue } // im selben Update erzeugt und wieder gelöscht: zählt über die neue Stelle
        if (clock >= known) { scope.unknown = true; break }
        let item: any
        try { item = Y.getItem(store, { client, clock }) } catch { scope.unknown = true; break }
        const next = item.id.clock + item.length
        if (item instanceof Y.Item && !item.deleted) {
          const container = item.parent instanceof Y.AbstractType ? typePath(item.parent) : null
          note(container && { container, key: item.parentSub ?? '#' })
        }
        clock = Math.max(next, clock + 1)
      }
    }
  }
  return scope
}
