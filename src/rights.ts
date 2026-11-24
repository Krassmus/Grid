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
  /** Tabellen, Spalten, Relationen, Sichten, Karten anlegen und ändern; Gruppen verwalten. */
  structure: boolean
}

export const FULL_RIGHTS: Rights = { active: false, admin: true, access: () => 'write', structure: true }

/** Rechte von `account`. Ohne Protokoll (lokales Dokument) oder ohne bekanntes Konto gilt alles. */
export function rightsFor(state: AdminState | null, account: string): Rights {
  if (!state || !account || state.groups.size === 0) return FULL_RIGHTS
  const me = state.members.get(account)
  if (me?.role === 'admin') return { active: true, admin: true, access: () => 'write', structure: true }
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
  return { active: true, admin: false, access, structure: false }
}

export const RightsContext = createContext<Rights>(FULL_RIGHTS)
export const useRights = () => useContext(RightsContext)
