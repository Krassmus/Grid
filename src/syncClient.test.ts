import { describe, expect, it } from 'vitest'
import { frame, normalizeServer, toWsUrl } from './syncClient'

describe('Server-Adressen', () => {
  it('ergänzt https und entfernt den Schrägstrich am Ende', () => {
    expect(normalizeServer(' townwork.eu/grid/ ')).toBe('https://townwork.eu/grid')
    expect(normalizeServer('http://localhost:8787')).toBe('http://localhost:8787')
    expect(normalizeServer('  ')).toBe('')
    expect(normalizeServer('127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
    expect(normalizeServer('localhost:8787/x')).toBe('http://localhost:8787/x')
  })
  it('macht aus http(s) eine WebSocket-Adresse', () => {
    expect(toWsUrl('https://townwork.eu/grid/', 'abc-123')).toBe('wss://townwork.eu/grid/ws/abc-123')
    expect(toWsUrl('http://localhost:8787', 'abc-123')).toBe('ws://localhost:8787/ws/abc-123')
  })
})

describe('Nachrichten', () => {
  it('stellt dem Inhalt ein Typ-Byte voran', () => {
    expect([...frame(1, new Uint8Array([7, 8]))]).toEqual([1, 7, 8])
    expect([...frame(0, new Uint8Array())]).toEqual([0])
  })
})

// ---------- Identität des Servers ----------
import { afterEach, beforeEach, vi } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { AuthError, onServerKey, pinServer, pinnedKey, sessionToken } from './syncClient'
import { toHex, useKeyStore } from './identity'

describe('Server-Schlüssel', () => {
  const secret = new Uint8Array(32).fill(5), other = new Uint8Array(32).fill(6)
  const pubOf = (k: Uint8Array) => toHex(ed25519.getPublicKey(k))
  let nonceCounter = 0
  /** Ein Server, der sich mit dem Schlüssel `key` ausweist (oder gar nicht / falsch signiert). */
  const fakeServer = (mode: { key?: Uint8Array; omit?: boolean; forge?: boolean }) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/challenge')) {
        const nonce = `${Date.now()}.${++nonceCounter}`
        const server = mode.omit ? undefined : {
          pub: pubOf(mode.key!),
          sig: toHex(ed25519.sign(new TextEncoder().encode(`grid-server-v1\n${mode.forge ? 'anderes' : nonce}`), mode.key!)),
        }
        return new Response(JSON.stringify({ nonce, server }))
      }
      return new Response(JSON.stringify({ status: 'ok', token: 'tok', exp: Math.floor(Date.now() / 1000) + 3600 }))
    }))
  }
  let n = 0
  const url = () => `http://srv${++n}.test`
  beforeEach(() => { let saved: string | null = null; useKeyStore({ load: async () => saved, save: async (v) => { saved = v } }) })
  afterEach(() => vi.unstubAllGlobals())

  it('merkt sich den Schlüssel beim ersten Verbinden und meldet ihn', async () => {
    const s = url(), seen: string[] = []
    const off = onServerKey((srv, key) => { if (srv === s) seen.push(key) })
    fakeServer({ key: secret })
    expect(await sessionToken(s, true)).toBe('tok')
    expect(pinnedKey(s)).toBe(pubOf(secret))
    expect(seen).toEqual([pubOf(secret)])
    await sessionToken(s, true) // zweites Mal: nichts Neues zu melden
    expect(seen).toHaveLength(1)
    off()
  })

  it('lehnt einen Server mit anderem Schlüssel ab, bis man ihm vertraut', async () => {
    const s = url()
    fakeServer({ key: secret })
    await sessionToken(s, true)
    fakeServer({ key: other })
    await expect(sessionToken(s, true)).rejects.toMatchObject({ kind: 'untrusted' })
    pinServer(s, null) // „Dem neuen Schlüssel vertrauen“
    expect(await sessionToken(s, true)).toBe('tok')
    expect(pinnedKey(s)).toBe(pubOf(other))
  })

  it('lehnt falsche Signatur und fehlende Identität (bei bekanntem Schlüssel) ab', async () => {
    const s = url()
    fakeServer({ key: secret, forge: true })
    await expect(sessionToken(s, true)).rejects.toBeInstanceOf(AuthError)
    expect(pinnedKey(s)).toBeNull()
    pinServer(s, pubOf(secret))
    fakeServer({ omit: true })
    await expect(sessionToken(s, true)).rejects.toMatchObject({ kind: 'untrusted' })
  })

  it('nimmt einen Schlüssel aus der Einladung als Vorgabe', async () => {
    const s = url()
    pinServer(s, pubOf(other)) // z. B. aus einer Einladung
    fakeServer({ key: secret })
    await expect(sessionToken(s, true)).rejects.toMatchObject({ kind: 'untrusted' })
    fakeServer({ key: other })
    expect(await sessionToken(s, true)).toBe('tok')
  })
})
