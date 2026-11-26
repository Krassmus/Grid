/** Verbindungsabbrüche, von denen niemand erfährt: der Client muss sie selbst bemerken (nachgestellt mit einem gespielten WebSocket). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { SyncConnection, type SyncState } from './syncClient'
import { PING_EVERY, PONG_WAIT, PROBE_WAIT } from './heartbeat'
import { useKeyStore } from './identity'
import { encryptEntry } from './e2e'
import type { DocKeys } from './docKeys'

class FakeSocket {
  static OPEN = 1
  static all: FakeSocket[] = []
  readyState = 0
  bufferedAmount = 0
  binaryType = ''
  sent: unknown[] = []
  closed = false
  onopen?: () => void
  onmessage?: (e: { data: unknown }) => void
  onclose?: () => void
  onerror?: () => void
  constructor(readonly url: string) { FakeSocket.all.push(this) }
  send(d: unknown) { this.sent.push(d) }
  close() { this.closed = true } // auf einer toten Strecke kommt kein `onclose`
  get pings() { return this.sent.filter((d) => d === '{"t":"ping"}').length }
  text(m: object) { this.onmessage?.({ data: JSON.stringify(m) }) }
  update(u: Uint8Array) { this.onmessage?.({ data: new Uint8Array([1, ...u]).buffer }) }
  /** Verbindungsaufbau wie beim echten Server (unverschlüsselt) */
  accept(ping = true) {
    this.readyState = 1
    this.onopen?.()
    this.text({ t: 'ok', ping })
    this.update(new Uint8Array([0, 0]))
  }
}

let page: EventTarget & { visibilityState: string }
let win: EventTarget
let conn: SyncConnection | null = null
let states: SyncState['status'][] = []
let n = 0

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.all = []
  states = []
  page = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  win = new EventTarget()
  vi.stubGlobal('document', page)
  vi.stubGlobal('window', win)
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/challenge')) return new Response(JSON.stringify({ nonce: 'n' }))
    if (url.endsWith('/login')) return new Response(JSON.stringify({ status: 'ok', token: 'tok', exp: Math.floor(Date.now() / 1000) + 3600 }))
    return new Response('[]')
  }))
  let saved: string | null = null
  useKeyStore({ load: async () => saved, save: async (v) => { saved = v } })
})
afterEach(() => { conn?.close(); conn = null; vi.useRealTimers(); vi.unstubAllGlobals() })

const pass = (ms: number) => vi.advanceTimersByTimeAsync(ms)
const realTimeout = globalThis.setTimeout
/** Ver- und Entschlüsseln laufen außerhalb der gespielten Uhr: ein paar echte Takte abwarten */
const settle = async () => { for (let i = 0; i < 20; i++) { await new Promise((r) => realTimeout(r, 2)); await pass(1) } }
const socket = async (count: number) => {
  for (let i = 0; i < 300 && FakeSocket.all.length < count; i++) { await new Promise((r) => realTimeout(r, 1)); await pass(10) }
  expect(FakeSocket.all).toHaveLength(count)
  return FakeSocket.all[count - 1]
}
const start = (doc = new Y.Doc()) => {
  conn = new SyncConnection(doc, { server: `http://reconnect${++n}.test`, docId: 'd', name: 'x' }, (s) => states.push(s.status))
  return doc
}

describe('Abgerissene Verbindung', () => {
  it('bleibt verbunden, solange der Server antwortet', async () => {
    start()
    const ws = await socket(1)
    ws.accept()
    for (let i = 0; i < 4; i++) { await pass(PING_EVERY); ws.text({ t: 'pong' }) }
    expect(ws.pings).toBe(4)
    expect(FakeSocket.all).toHaveLength(1)
    expect(states.at(-1)).toBe('online')
  })

  it('bemerkt eine stumme Strecke, zeigt offline und verbindet neu', async () => {
    start()
    const first = await socket(1)
    first.accept()
    await pass(PING_EVERY + PONG_WAIT)
    expect(states.at(-1)).toBe('offline')
    expect(first.closed).toBe(true)
    const second = await socket(2)
    second.accept()
    expect(states.at(-1)).toBe('online')
    // was die alte Verbindung noch liefert, zählt nicht mehr
    const before = states.length
    first.text({ t: 'readonly', code: 'x', reason: 'y' })
    first.onclose?.()
    expect(states).toHaveLength(before)
  })

  it('prüft nach der Rückkehr in die App sofort', async () => {
    start()
    ;(await socket(1)).accept()
    page.dispatchEvent(new Event('visibilitychange'))
    expect(FakeSocket.all[0].pings).toBe(1)
    await pass(PROBE_WAIT)
    expect(states.at(-1)).toBe('offline')
    await socket(2)
  })

  it('fragt einen älteren Server nicht an, baut aber bei neuem Netz neu auf', async () => {
    start()
    ;(await socket(1)).accept(false)
    await pass(5 * PING_EVERY)
    expect(FakeSocket.all[0].pings).toBe(0)
    page.dispatchEvent(new Event('visibilitychange')) // nur kurz weg: nichts tun
    expect(states.at(-1)).toBe('online')
    win.dispatchEvent(new Event('online'))
    expect(states.at(-1)).toBe('offline')
    await socket(2)
  })

  it('gibt einen Verbindungsaufbau auf, der nicht vorankommt', async () => {
    start()
    const first = await socket(1)
    await pass(30_000)
    expect(first.closed).toBe(true)
    await socket(2)
  })

  it('schickt nach dem Neuverbinden den eigenen Stand wieder zum Abgleich', async () => {
    const doc = start()
    ;(await socket(1)).accept()
    doc.getMap('m').set('verloren', 1) // geht auf der toten Strecke ins Leere
    await pass(PING_EVERY + PONG_WAIT)
    const second = await socket(2)
    second.accept()
    // der Server fragt mit seinem (leeren) Stand, der Client liefert alles Fehlende
    second.onmessage?.({ data: new Uint8Array([0, ...Y.encodeStateVector(new Y.Doc())]).buffer })
    const reply = second.sent.at(-1) as Uint8Array
    const server = new Y.Doc()
    Y.applyUpdate(server, reply.subarray(1))
    expect(server.getMap('m').get('verloren')).toBe(1)
  })

  it('verbindet nach dem Schließen nicht mehr', async () => {
    start()
    ;(await socket(1)).accept()
    conn!.close()
    win.dispatchEvent(new Event('online'))
    await pass(10 * PING_EVERY)
    expect(FakeSocket.all).toHaveLength(1)
  })
})

describe('Verschlüsselte Dokumente', () => {
  const secret = new Uint8Array(32).fill(3)
  const keys = { load: async () => true, serverEpoch: 1, top: 1, key: () => secret, keyFor: async () => secret } as unknown as DocKeys
  const entry = async (name: string) => {
    const d = new Y.Doc()
    d.getMap('m').set(name, true)
    return encryptEntry('d', 1, secret, Y.encodeStateAsUpdate(d))
  }
  const deliver = (ws: FakeSocket, seq: number, e: Uint8Array) => {
    const b = new Uint8Array(9 + e.length)
    b[0] = 5
    new DataView(b.buffer).setBigUint64(1, BigInt(seq))
    b.set(e, 9)
    ws.onmessage?.({ data: b.buffer })
  }
  const open = (ws: FakeSocket) => { ws.readyState = 1; ws.onopen?.(); ws.text({ t: 'ok', ping: true }) }
  const since = (ws: FakeSocket) => JSON.parse(ws.sent[0] as string).since

  it('fragt nach dem Nachladen nach Lebenszeichen und holt danach nur Neues', async () => {
    const doc = new Y.Doc()
    conn = new SyncConnection(doc, { server: `http://reconnect${++n}.test`, docId: 'd', name: 'x', keys }, (s) => states.push(s.status))
    const first = await socket(1)
    open(first)
    deliver(first, 7, await entry('eins'))
    first.text({ t: 'synced' })
    await settle()
    expect(states.at(-1)).toBe('online')
    expect(doc.getMap('m').get('eins')).toBe(true)
    await pass(PING_EVERY + PONG_WAIT)
    expect(first.pings).toBe(1)
    const second = await socket(2)
    open(second)
    expect(since(second)).toBe(7)
  })

  it('bleibt nach einem Fehler beim Verarbeiten nicht stehen', async () => {
    const doc = new Y.Doc()
    let broken = 1 // so oft scheitert die Prüfung von Eintrag 2
    const rights = {
      settled: async () => {},
      judge: (_: Y.Doc, seq: number, plain: Uint8Array) => { if (seq === 2 && broken-- > 0) throw new Error('kaputt'); return { ok: true as const, update: plain } },
      mode: () => ({ active: false, admin: false }),
      onRejected: () => {},
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    conn = new SyncConnection(doc, { server: `http://reconnect${++n}.test`, docId: 'd', name: 'x', keys, rights }, (s) => states.push(s.status))
    const one = await entry('eins'), two = await entry('zwei'), three = await entry('drei')
    const first = await socket(1)
    open(first)
    deliver(first, 1, one); deliver(first, 2, two); deliver(first, 3, three)
    first.text({ t: 'synced' })
    // Fehler: neu verbinden und ab dem letzten verarbeiteten Eintrag noch einmal holen
    const second = await socket(2)
    open(second)
    expect(since(second)).toBe(1)
    expect(doc.getMap('m').has('drei')).toBe(false)
    deliver(second, 2, two); deliver(second, 3, three)
    second.text({ t: 'synced' })
    await settle()
    expect([...doc.getMap('m').keys()].sort()).toEqual(['drei', 'eins', 'zwei'])
    expect(states.at(-1)).toBe('online')
  })

  it('lässt einen Eintrag aus, der immer wieder scheitert, und führt dann nicht zusammen', async () => {
    const doc = new Y.Doc()
    const rights = {
      settled: async () => {},
      judge: (_: Y.Doc, seq: number, plain: Uint8Array) => { if (seq === 1) throw new Error('kaputt'); return { ok: true as const, update: plain } },
      mode: () => ({ active: false, admin: false }),
      onRejected: () => {},
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    conn = new SyncConnection(doc, { server: `http://reconnect${++n}.test`, docId: 'd', name: 'x', keys, rights }, (s) => states.push(s.status))
    const one = await entry('eins'), two = await entry('zwei')
    const first = await socket(1)
    open(first)
    deliver(first, 1, one); deliver(first, 2, two)
    const second = await socket(2)
    open(second)
    deliver(second, 1, one); deliver(second, 2, two)
    second.text({ t: 'synced' })
    second.text({ t: 'compact', upto: 2 })
    await settle()
    expect([...doc.getMap('m').keys()]).toEqual(['zwei'])
    expect(states.at(-1)).toBe('online')
    expect(second.sent.some((d) => d instanceof Uint8Array && d[0] === 6)).toBe(false)
  })
})
