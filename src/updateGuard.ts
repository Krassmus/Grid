/**
 * Prüft eingehende Änderungen gegen die Rechte (Rechte Phase 2, docs/RIGHTS.md).
 * Ein Eintrag im Datenstrom wird nach dem Stand des Admin-Protokolls bewertet, der an seiner Stelle im Strom galt: jeder Protokolleintrag
 * trägt die Stromnummer `at` des letzten Eintrags vor ihm im Strom; er wirkt für alle Einträge danach. So bewerten alle Clients dieselbe Änderung gleich, auch spät hinzugekommene.
 */
import type * as Y from 'yjs'
import { applyEntry, emptyState, type AdminEntry, type AdminState } from './adminLog'
import { rightsFor } from './rights'
import { unseal, verifySeal } from './signedUpdate'
import { scopeOf } from './updateScope'
import { t } from './i18n'

/** Zustände des Admin-Protokolls nach jedem Eintrag, zugeordnet zu den Stromnummern, ab denen sie wirken. */
export class RightsTimeline {
  private states: { at: number; state: AdminState }[] = []
  readonly valid: boolean

  constructor(doc: string, entries: readonly AdminEntry[]) {
    let state = emptyState(), ok = true
    try {
      for (const e of entries) { state = applyEntry(state, doc, e); this.states.push({ at: e.at ?? 0, state }) }
    } catch { ok = false }
    this.valid = ok && entries.length > 0
  }

  /** Stand, der für den Strom-Eintrag Nummer `seq` galt (null: noch kein Protokoll). Eintrag `at` selbst kam vor dem Protokolleintrag und zählt noch zum alten Stand.. */
  at(seq: number): AdminState | null {
    let found: AdminState | null = null
    for (const s of this.states) { if (s.at < seq) found = s.state; else break } // `at` ist der letzte Strom-Eintrag vor dem Protokolleintrag: er wirkt erst für spätere
    return found
  }

  /** Neuester Stand */
  get latest(): AdminState | null { return this.states.length ? this.states[this.states.length - 1].state : null }
}

export type Verdict = { ok: true; update: Uint8Array } | { ok: false; reason: string }

/**
 * Bewertet den entschlüsselten Klartext des Eintrags `seq`. Ohne Gruppen (am Stand von `seq`) gilt wie bisher alles; mit Gruppen muss der Eintrag
 * unterschrieben sein, vom Mitglied stammen und nur ändern, was seine Gruppen erlauben. Gesamtzustände (`snap`) müssen von einem Admin kommen.
 */
export function judge(timeline: RightsTimeline | null, doc: string, live: Y.Doc, seq: number, plain: Uint8Array): Verdict {
  const state = timeline?.valid ? timeline.at(seq) : null
  const sealed = unseal(plain)
  if (!state || state.groups.size === 0) {
    // Vor den Gruppen: ein unterschriebener Eintrag (von einem Client, der schon Gruppen kannte) wird ausgepackt, sonst bleibt es das bloße Update
    return { ok: true, update: sealed && state && state.members.get(sealed.author) && verifySeal(doc, sealed, state.members.get(sealed.author)!.pub) ? sealed.update : plain }
  }
  if (!sealed) return { ok: false, reason: t('Änderung ohne Unterschrift') }
  const author = state.members.get(sealed.author)
  if (!author) return { ok: false, reason: t('Unbekannter Autor') }
  if (!verifySeal(doc, sealed, author.pub)) return { ok: false, reason: t('Unterschrift falsch') }
  if (sealed.kind === 'snap') return author.role === 'admin' ? { ok: true, update: sealed.update } : { ok: false, reason: t('Gesamtzustand nicht von einem Admin') }
  const rights = rightsFor(state, sealed.author)
  if (rights.admin) return { ok: true, update: sealed.update }
  let scope
  try { scope = scopeOf(live, sealed.update) } catch { return { ok: false, reason: t('Änderung nicht lesbar') } }
  if (scope.structure || scope.unknown) return { ok: false, reason: scope.unknown ? t('Änderung betrifft unbekannte Stellen') : t('Nur Admins ändern die Struktur') }
  for (const id of scope.tables) if (rights.access(id) !== 'write') return { ok: false, reason: t('Kein Schreibrecht an der Tabelle') }
  for (const id of scope.maps) if (rights.access(id) !== 'write') return { ok: false, reason: t('Kein Schreibrecht an der Karte') }
  return { ok: true, update: sealed.update }
}
