import { describe, expect, it } from 'vitest'
import { ago, safeFileName, uniqueName } from './documents'

describe('Dokumentnamen', () => {
  it('macht Namen dateitauglich', () => {
    expect(safeFileName('Büro: Plan/2026?')).toBe('Büro Plan 2026')
    expect(safeFileName('  ..versteckt ')).toBe('versteckt')
    expect(safeFileName('   ')).toBe('Neues Dokument')
    expect(safeFileName('x'.repeat(200))).toHaveLength(80)
  })
  it('vergibt freie Namen', () => {
    expect(uniqueName('Plan', [])).toBe('Plan')
    expect(uniqueName('Plan', ['plan'])).toBe('Plan 2')
    expect(uniqueName('Plan', ['Plan', 'Plan 2', 'PLAN 3'])).toBe('Plan 4')
  })
  it('beschreibt die Änderungszeit', () => {
    const now = Date.UTC(2026, 10, 21, 12, 0, 0)
    const s = (secondsAgo: number) => now / 1000 - secondsAgo
    expect(ago(s(10), now)).toBe('gerade eben')
    expect(ago(s(300), now)).toBe('vor 5 Min.')
    expect(ago(s(7200), now)).toBe('vor 2 Std.')
    expect(ago(s(90000), now)).toBe('gestern')
    expect(ago(s(86400 * 10), now)).toMatch(/2026/)
  })
})
