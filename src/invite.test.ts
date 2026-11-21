import { describe, expect, it } from 'vitest'
import { makeInvite, parseInvite } from './invite'

describe('Einladung', () => {
  const inv = { server: 'https://townwork.eu/grid', doc: 'd0c00000-0000-0000-0000-000000000001', name: 'Büro Größe & Café', admin: 'ab12-cd34-ef56-7890' }
  it('geht hin und zurück, auch mit Umlauten', () => {
    const text = makeInvite(inv)
    expect(text).toMatch(/^grid-invite:1:[A-Za-z0-9_-]+$/)
    expect(parseInvite(`  ${text}\n`)).toEqual(inv)
  })
  it('trägt den Server-Schlüssel mit (und ignoriert Unsinn)', () => {
    const key = 'ab'.repeat(32)
    expect(parseInvite(makeInvite({ ...inv, key })).key).toBe(key)
    expect(parseInvite(makeInvite({ ...inv, key: 'zz' })).key).toBeUndefined()
  })
  it('lehnt Fremdes und Beschädigtes ab', () => {
    expect(() => parseInvite('hallo')).toThrow('keine Grid-Einladung')
    expect(() => parseInvite('grid-invite:1:%%%')).toThrow('beschädigt')
    expect(() => parseInvite(makeInvite({ ...inv, doc: '../x' }))).toThrow('unvollständig')
    expect(() => parseInvite(makeInvite({ ...inv, server: 'ftp://x' }))).toThrow('unvollständig')
  })
})
