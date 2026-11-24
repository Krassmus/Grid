/**
 * Rechte Ende-zu-Ende: ein echter Server (server/target/debug/grid-server) und mehrere echte Clients (FileSession, SyncConnection),
 * jeder mit eigenem Konto und eigenem Modulbestand. Prüft, dass Gruppenrechte beim Empfang durchgesetzt werden.
 * Wird übersprungen, wenn das Server-Programm nicht gebaut ist (cd server && cargo build).
 */
/* eslint-disable */
// @ts-nocheck
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const node = async () => ({ fs: await import('node:fs'), path: await import('node:path'), cp: await import('node:child_process'), os: await import('node:os') })
const root = new URL('..', import.meta.url).pathname
const bin = root + 'server/target/debug/grid-server'
const { fs } = await node()
const have = fs.existsSync(bin)

const until = async (what: string, cond: () => boolean, ms = 15000) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('Zeitüberschreitung: ' + what)
    await new Promise((r) => setTimeout(r, 40))
  }
}
const quiet = (ms: number) => new Promise((r) => setTimeout(r, ms))

let child: any, server = ''

beforeAll(async () => {
  if (!have) return
  const { fs, path, cp, os } = await node()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grid-rights-'))
  const port = 20000 + Math.floor(Math.random() * 20000)
  server = `http://127.0.0.1:${port}`
  child = cp.spawn(bin, ['--listen', `127.0.0.1:${port}`, '--data', dir, '--open-registration'], { stdio: 'ignore' })
  await until('Server', () => false, 0).catch(() => {})
  for (let i = 0; i < 100; i++) { try { await fetch(server + '/challenge'); return } catch { await quiet(50) } }
  throw new Error('Server startet nicht')
}, 30000)
afterAll(() => { child?.kill() })

/** Ein Client mit eigenem Konto und eigenem Modulbestand (eigene Sitzungen, eigene Schlüssel). */
async function client(label: string) {
  vi.resetModules()
  const identity = await import('./identity')
  let stored: string | null = null
  identity.useKeyStore({ load: async () => stored, save: async (v: string) => { stored = v } })
  identity.setAccountName(label)
  const Y = await import('yjs')
  const model = await import('./model')
  const { FileSession } = await import('./fileSession')
  const { newMeta } = await import('./gridFile')
  const members = await import('./members')
  const invite = await import('./invite')
  const me = await identity.getIdentity()
  let doc = new Y.Doc()
  let session: any
  const c = {
    label, me, model, Y, members,
    get doc() { return doc },
    get session() { return session },
    async open(docId?: string) {
      const meta = newMeta()
      if (docId) meta.docId = docId
      meta.sync = { server, enc: true }
      session = new FileSession(1, doc, null, meta, new Set(), () => {})
      session.attach()
      await until(label + ' online', () => session.syncState?.status === 'online', 20000)
    },
    async knock(docId: string) { await members.requestJoin(server, docId) },
    cell(table: string, row: string, col: string) { return model.tablesOf(doc).get(table)?.get('rows')?.get(row)?.get(col) },
    tables: () => model.tablesOf(doc).toJSON(),
  }
  return c
}

describe.skipIf(!have)('Rechte mit echtem Server und echten Clients', () => {
  it('setzt Schreibrechte beim Empfang durch, auch gegen Clients, die sich nicht daran halten', async () => {
    const A = await client('Anna'), B = await client('Ben'), C = await client('Cora')
    await A.open()
    const docId = A.session.meta.docId

    // Zwei Tabellen mit je einer Zeile
    const m = A.model
    const t1 = m.addTable(A.doc, 'Eins', { firstRow: false }), t2 = m.addTable(A.doc, 'Zwei', { firstRow: false })
    const col1 = m.readTables(A.doc).find((t: any) => t.id === t1).columns[0].id
    const col2 = m.readTables(A.doc).find((t: any) => t.id === t2).columns[0].id
    const row1 = m.addRow(A.doc, t1), row2 = m.addRow(A.doc, t2)
    m.setCell(A.doc, t1, row1, col1, 'a1'); m.setCell(A.doc, t2, row2, col2, 'a2')

    // Ben und Cora treten bei (Anklopfen, Zulassen, Öffnen)
    for (const x of [B, C]) {
      await x.knock(docId)
      await until('Anfrage', () => A.session.members?.requests?.length >= 0, 100)
      let req: any
      for (let i = 0; i < 100 && !req; i++) { await A.session.refreshMembers(); req = A.session.members?.requests.find((r: any) => r.account === x.me.id); if (!req) await quiet(50) }
      expect(req, 'Beitrittsanfrage von ' + x.label).toBeTruthy()
      await A.session.accept(req)
      await x.open(docId)
    }
    await until('Tabellen bei Ben und Cora', () => Object.keys(B.tables()).length === 2 && Object.keys(C.tables()).length === 2)

    // Vor den Gruppen darf jedes Mitglied alles: Ben schreibt in Tabelle 2
    m.setCell(B.doc, t2, row2, col2, 'ben-vorher')
    await until('Ben vorher bei Anna', () => A.cell(t2, row2, col2) === 'ben-vorher')

    // Anna legt eine Gruppe an: Ben darf in Tabelle 1 schreiben, sonst nichts
    const G = crypto.randomUUID()
    await A.session.changeGroups([
      { type: 'group', group: G, name: 'Redaktion' },
      { type: 'join-group', group: G, account: B.me.id },
      { type: 'grant', group: G, object: t1, level: 'write' },
    ])
    await until('Gruppen bei allen', () => [B, C].every((x) => x.session.members?.state?.groups.size === 1))

    // Erlaubt: Ben schreibt in Tabelle 1
    m.setCell(B.doc, t1, row1, col1, 'ben-erlaubt')
    await until('Ben erlaubt bei Anna und Cora', () => A.cell(t1, row1, col1) === 'ben-erlaubt' && C.cell(t1, row1, col1) === 'ben-erlaubt')

    // Nicht erlaubt: Ben schreibt in Tabelle 2, Cora (ohne Gruppe) in Tabelle 1, Ben ändert die Struktur
    m.setCell(B.doc, t2, row2, col2, 'ben-verboten')
    m.setCell(C.doc, t1, row1, col1, 'cora-verboten')
    m.addColumn(B.doc, t1, 'BenSpalte', 'text')
    await until('Ablehnungen bei Anna', () => A.session.rejected >= 3)
    await quiet(300)
    expect(A.cell(t2, row2, col2)).toBe('ben-vorher')
    expect(A.cell(t1, row1, col1)).toBe('ben-erlaubt')
    expect(m.readTables(A.doc).find((t: any) => t.id === t1).columns.map((c: any) => c.name)).not.toContain('BenSpalte')
    expect(C.cell(t2, row2, col2)).toBe('ben-vorher') // auch Cora übernimmt Bens unerlaubte Änderung nicht
    expect(B.cell(t1, row1, col1)).toBe('ben-erlaubt') // und Ben nicht die von Cora
    expect(A.session.lastRejection).toBeTruthy()

    // Admin darf alles, auch Struktur: Anna fügt eine Spalte hinzu
    m.addColumn(A.doc, t1, 'AnnaSpalte', 'text')
    await until('Annas Spalte bei Ben und Cora', () => [B, C].every((x) => m.readTables(x.doc).find((t: any) => t.id === t1).columns.some((c: any) => c.name === 'AnnaSpalte')))

    // Entzug: danach sind Bens Änderungen an Tabelle 1 verboten
    const before = A.session.rejected
    await A.session.changeGroups([{ type: 'grant', group: G, object: t1, level: 'none' }])
    await until('Entzug bei Ben', () => B.session.members?.state?.grants.get(G)?.size === 0)
    m.setCell(B.doc, t1, row1, col1, 'ben-nach-entzug')
    await until('Ablehnung nach Entzug', () => A.session.rejected > before)
    await quiet(300)
    expect(A.cell(t1, row1, col1)).toBe('ben-erlaubt')

    // Wer später dazukommt, bewertet den ganzen Verlauf genauso: Bens frühere erlaubte Änderung bleibt, alles Unerlaubte fehlt
    const D = await client('Dora')
    await D.knock(docId)
    let req: any
    for (let i = 0; i < 100 && !req; i++) { await A.session.refreshMembers(); req = A.session.members?.requests.find((r: any) => r.account === D.me.id); if (!req) await quiet(50) }
    await A.session.accept(req)
    await D.open(docId)
    await until('Dora hat den Stand', () => Object.keys(D.tables()).length === 2 && D.cell(t1, row1, col1) !== undefined, 20000).catch((e) => { throw new Error(e.message + ' ' + JSON.stringify({ state: D.session.syncState, rejected: D.session.rejected, why: D.session.rejections, at: D.session.members?.entries.map((e: any) => e.type + '@' + e.at), tables: Object.keys(D.tables()) })) })
    await quiet(500)
    expect(D.cell(t1, row1, col1)).toBe('ben-erlaubt')
    expect(D.cell(t2, row2, col2)).toBe('ben-vorher')
    expect(D.tables()).toEqual(A.tables()) // dieselben Daten wie beim Admin
  }, 120000)
})
