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
