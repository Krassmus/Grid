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
