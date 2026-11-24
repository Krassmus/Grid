import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { ed25519 } from '@noble/curves/ed25519.js'
import { buildEntry, buildGroupEntry, emptyState, applyEntry, type AdminEntry, type AdminState } from './adminLog'
import { toHex, type Identity } from './identity'
import { addColumn, addRow, addTable, readTables, setCell } from './model'
import { seal } from './signedUpdate'
import { judge, RightsTimeline } from './updateGuard'

const DOC = 'd0c00000-0000-0000-0000-000000000001'
const person = (n: number): Identity => {
  const secretKey = new Uint8Array(32).fill(n)
  return { id: `aaaaaaaa-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`, secretKey, publicKey: toHex(ed25519.getPublicKey(secretKey)) }
}
const sub = (p: Identity) => ({ id: p.id, pub: p.publicKey })
const G = 'gggggggg-0000-0000-0000-000000000001'
const [A, B, C] = [person(1), person(2), person(3)]

/** Admin-Protokoll mit Stromnummern: Gründung und Mitglieder ab 0, Gruppe ab 10, Recht an `tab` ab 10, Entzug ab 20. */
function setup() {
  const live = new Y.Doc()
  const t1 = addTable(live, 'Eins', { firstRow: false }), t2 = addTable(live, 'Zwei', { firstRow: false })
  const col1 = readTables(live).find((x) => x.id === t1)!.columns[0].id
  const log: AdminEntry[] = []
  let s: AdminState = emptyState()
  const add = (e: AdminEntry, at: number) => { s = applyEntry(s, DOC, e); log.push({ ...e, at }) }
  add(buildEntry(A, s, DOC, 'genesis', sub(A), 'admin', 'Anna'), 0)
  add(buildEntry(A, s, DOC, 'set', sub(B), 'member', 'Ben'), 0)
  add(buildEntry(A, s, DOC, 'set', sub(C), 'member', 'Cora'), 0)
  add(buildGroupEntry(A, s, DOC, { type: 'group', group: G, name: 'Redaktion' }), 10)
  add(buildGroupEntry(A, s, DOC, { type: 'join-group', group: G, account: B.id, pub: B.publicKey }), 10)
  add(buildGroupEntry(A, s, DOC, { type: 'grant', group: G, object: t1, level: 'write' }), 10)
  add(buildGroupEntry(A, s, DOC, { type: 'grant', group: G, object: t1, level: 'none' }), 20)
  const timeline = new RightsTimeline(DOC, log)
  /** Update, das `who` an einer Kopie des Dokuments macht */
  const change = (f: (d: Y.Doc) => void) => {
    const d = new Y.Doc(); Y.applyUpdate(d, Y.encodeStateAsUpdate(live))
    const sv = Y.encodeStateVector(d); f(d)
    return Y.encodeStateAsUpdate(d, sv)
  }
  return { live, t1, t2, col1, timeline, change }
}

describe('Prüfung eingehender Änderungen', () => {
  it('vor den Gruppen gilt alles, auch ohne Unterschrift (auch der letzte Eintrag vor dem Gruppeneintrag)', () => {
    const w = setup()
    const u = w.change((d) => { addColumn(d, w.t2, 'X', 'text') })
    expect(judge(w.timeline, DOC, w.live, 5, u)).toMatchObject({ ok: true })
    expect(judge(w.timeline, DOC, w.live, 10, u)).toMatchObject({ ok: true })
    expect(judge(w.timeline, DOC, w.live, 11, u)).toMatchObject({ ok: false })
  })

  it('mit Gruppen: Schreibrecht an der Tabelle genügt für Zeilen, nicht für Struktur oder andere Tabellen', () => {
    const w = setup()
    const rows = w.change((d) => { const r = addRow(d, w.t1); setCell(d, w.t1, r, w.col1, 'x') })
    expect(judge(w.timeline, DOC, w.live, 15, seal(B, DOC, rows))).toMatchObject({ ok: true })
    expect(judge(w.timeline, DOC, w.live, 15, seal(B, DOC, w.change((d) => { addRow(d, w.t2) })))).toMatchObject({ ok: false })
    expect(judge(w.timeline, DOC, w.live, 15, seal(B, DOC, w.change((d) => { addColumn(d, w.t1, 'Neu', 'text') })))).toMatchObject({ ok: false })
    expect(judge(w.timeline, DOC, w.live, 15, seal(B, DOC, w.change((d) => { addTable(d, 'Drei') })))).toMatchObject({ ok: false })
  })

  it('ohne Unterschrift, mit falscher Unterschrift, von Fremden oder von Mitgliedern ohne Gruppe wird abgelehnt', () => {
    const w = setup()
    const u = w.change((d) => { addRow(d, w.t1) })
    expect(judge(w.timeline, DOC, w.live, 15, u)).toMatchObject({ ok: false })
    const forged = seal(C, DOC, u); forged.set(new TextEncoder().encode(B.id), 6) // Cora gibt sich als Ben aus
    expect(judge(w.timeline, DOC, w.live, 15, forged)).toMatchObject({ ok: false })
    expect(judge(w.timeline, DOC, w.live, 15, seal(C, DOC, u))).toMatchObject({ ok: false }) // Cora ist in keiner Gruppe
    expect(judge(w.timeline, DOC, w.live, 15, seal(person(9), DOC, u))).toMatchObject({ ok: false }) // kein Mitglied
    const tampered = seal(B, DOC, u); tampered[tampered.length - 1] ^= 1 // Inhalt verändert
    expect(judge(w.timeline, DOC, w.live, 15, tampered)).toMatchObject({ ok: false })
  })

  it('Admins dürfen alles, auch Struktur; Gesamtzustände nur von Admins', () => {
    const w = setup()
    const u = w.change((d) => { addColumn(d, w.t1, 'Neu', 'text') })
    expect(judge(w.timeline, DOC, w.live, 15, seal(A, DOC, u))).toMatchObject({ ok: true })
    expect(judge(w.timeline, DOC, w.live, 15, seal(A, DOC, u, 'snap'))).toMatchObject({ ok: true })
    expect(judge(w.timeline, DOC, w.live, 15, seal(B, DOC, u, 'snap'))).toMatchObject({ ok: false })
  })

  it('der Entzug wirkt ab seiner Stelle im Strom: Früheres bleibt gültig, Späteres wird abgelehnt', () => {
    const w = setup()
    const u = seal(B, DOC, w.change((d) => { addRow(d, w.t1) }))
    expect(judge(w.timeline, DOC, w.live, 19, u)).toMatchObject({ ok: true })
    expect(judge(w.timeline, DOC, w.live, 20, u)).toMatchObject({ ok: true }) // kam noch vor dem Entzug im Strom
    expect(judge(w.timeline, DOC, w.live, 21, u)).toMatchObject({ ok: false })
    expect(judge(w.timeline, DOC, w.live, 25, u)).toMatchObject({ ok: false })
    // ohne Protokoll (lokales Dokument) gilt alles
    expect(judge(null, DOC, w.live, 25, u)).toMatchObject({ ok: true })
  })

  it('unbekannte Stellen (Eltern fehlen) werden abgelehnt', () => {
    const w = setup()
    const d = new Y.Doc(); Y.applyUpdate(d, Y.encodeStateAsUpdate(w.live))
    const r = addRow(d, w.t1)
    const sv = Y.encodeStateVector(d)
    setCell(d, w.t1, r, w.col1, 'x')
    const second = Y.encodeStateAsUpdate(d, sv) // die Zeile selbst fehlt dem Prüfer
    expect(judge(w.timeline, DOC, w.live, 15, seal(B, DOC, second))).toMatchObject({ ok: false })
  })
})
