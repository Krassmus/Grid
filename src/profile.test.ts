import { describe, expect, it } from 'vitest'
import { initialsOf } from './profile'

describe('Avatar-Buchstaben', () => {
  it('nimmt Vor- und Nachnamen', () => {
    expect(initialsOf('Anna Beispiel')).toBe('AB')
    expect(initialsOf('  anna   maria   beispiel ')).toBe('AB')
    expect(initialsOf('Anna')).toBe('AN')
    expect(initialsOf('')).toBe('?')
    expect(initialsOf('Ärger Öl')).toBe('ÄÖ')
  })
})

import * as Y from 'yjs'
import { FakeHub } from './sync'
import { profilesOf, publishProfile } from './model'
import { safeAvatar } from './Avatar'

describe('Profile im Dokument', () => {
  it('kommen bei den anderen Mitgliedern an und erzeugen keine Änderung, wenn nichts neu ist', () => {
    const a = new Y.Doc(), b = new Y.Doc()
    const hub = new FakeHub(); hub.join('a', a); hub.join('b', b)
    let updates = 0
    a.on('update', () => { updates++ })
    publishProfile(a, 'acct-a', { name: 'Anna', avatar: 'data:image/jpeg;base64,AAAA' })
    expect(profilesOf(b).get('acct-a')).toEqual({ name: 'Anna', avatar: 'data:image/jpeg;base64,AAAA' })
    publishProfile(a, 'acct-a', { name: 'Anna', avatar: 'data:image/jpeg;base64,AAAA' })
    expect(updates).toBe(1)
    publishProfile(a, 'acct-a', { name: 'Anna B.', avatar: '' })
    expect(profilesOf(b).get('acct-a')?.name).toBe('Anna B.')
  })

  it('zeigt nur eingebettete kleine Bilder an', () => {
    expect(safeAvatar('data:image/jpeg;base64,/9j/4AAQ')).toBeTruthy()
    expect(safeAvatar('https://tracker.example/pixel.png')).toBe('')
    expect(safeAvatar('data:image/svg+xml;base64,PHN2Zz4=')).toBe('')
    expect(safeAvatar('data:image/png;base64,' + 'A'.repeat(100_000))).toBe('')
    expect(safeAvatar(42)).toBe('')
  })
})
