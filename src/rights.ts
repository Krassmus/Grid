/**
 * Rechte eines Kontos in einem Dokument (docs/RIGHTS.md), berechnet aus dem Admin-Protokoll.
 * Solange es keine Gruppe gibt, gilt wie bisher: alle Mitglieder dürfen alles. Mit der ersten Gruppe beginnt die Rechteverwaltung:
 * Admins dürfen alles, alle anderen nur, was ihre Gruppen erlauben (höchste Stufe je Tabelle, Sicht oder Karte), und keine Struktur ändern.
 */
import { createContext, useContext } from 'react'
import type { AdminState } from './adminLog'

export type Access = 'none' | 'read' | 'write'
const RANK: Record<Access, number> = { none: 0, read: 1, write: 2 }

export interface Rights {
  /** Die Rechteverwaltung ist eingeschaltet (es gibt mindestens eine Gruppe). */
  active: boolean
  /** Der Betrachter ist Admin. */
  admin: boolean
  /** Stufe an einer Tabelle, abgeleiteten Tabelle oder Karte (ID). */
  access: (object: string) => Access
  /** Stufe an einer Spalte: die höhere von Tabellenstufe und Spaltenrecht (docs/RIGHTS.md, „Rechte je Spalte“). */
  colAccess: (table: string, column: string) => Access
  /** Hat die Tabelle für den Betrachter einen sichtbaren Teil (Tabellenrecht oder Recht an mindestens einer ihrer Spalten)? */
  visible: (table: string, columns: readonly string[]) => boolean
  /** Darf der Betrachter Zeilen anlegen: volles Schreibrecht an der Tabelle oder Schreibrecht an mindestens einer Spalte? */
  canAdd: (table: string, columns: readonly string[]) => boolean
  /** Tabellen, Spalten, Relationen, Sichten, Karten anlegen und ändern; Gruppen verwalten. */
  structure: boolean
}

const EVERYTHING = { access: () => 'write' as Access, colAccess: () => 'write' as Access, visible: () => true, canAdd: () => true }
export const FULL_RIGHTS: Rights = { active: false, admin: true, ...EVERYTHING, structure: true }

/** Rechte von `account`. Ohne Protokoll (lokales Dokument) oder ohne bekanntes Konto gilt alles. */
export function rightsFor(state: AdminState | null, account: string): Rights {
  if (!state || !account || state.groups.size === 0) return FULL_RIGHTS
  const me = state.members.get(account)
  if (me?.role === 'admin') return { active: true, admin: true, ...EVERYTHING, structure: true }
  const mine = [...(state.memberGroups.get(account) ?? [])]
  const access = (object: string): Access => {
    if (!me) return 'none'
    let best: Access = 'none'
    for (const g of mine) {
      const a = state.grants.get(g)?.get(object)
      if (a && RANK[a] > RANK[best]) best = a
    }
    return best
  }
  const colAccess = (table: string, column: string): Access => (RANK[access(table)] >= RANK[access(column)] ? access(table) : access(column))
  const visible = (table: string, columns: readonly string[]) => access(table) !== 'none' || columns.some((c) => access(c) !== 'none')
  const canAdd = (table: string, columns: readonly string[]) => access(table) === 'write' || columns.some((c) => access(c) === 'write')
  return { active: true, admin: false, access, colAccess, visible, canAdd, structure: false }
}

/** Wie `rights`, aber Spalten, deren Schlüssel auf diesem Gerät fehlt (`locked`), lassen sich nicht schreiben (vertrauliche Spalten). */
export function withLocks(rights: Rights, locked: (column: string) => boolean): Rights {
  const colAccess = (table: string, column: string): Access => {
    const a = rights.colAccess(table, column)
    return a === 'write' && locked(column) ? 'read' : a
  }
  return { ...rights, colAccess, canAdd: (table, columns) => rights.access(table) === 'write' || columns.some((c) => colAccess(table, c) === 'write') }
}

export const RightsContext = createContext<Rights>(FULL_RIGHTS)
export const useRights = () => useContext(RightsContext)
