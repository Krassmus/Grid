import { describe, expect, it } from 'vitest'
import { MAX_RECENT, recentLabels, withRecent } from './recentFiles'

describe('Zuletzt geöffnet', () => {
  it('stellt den neuesten Pfad nach vorn, ohne Dopplung', () => {
    expect(withRecent(['/a.grid', '/b.grid'], '/b.grid')).toEqual(['/b.grid', '/a.grid'])
  })
  it('behält höchstens zehn', () => {
    let l: string[] = []
    for (let i = 0; i < 15; i++) l = withRecent(l, `/f${i}.grid`)
    expect(l).toHaveLength(MAX_RECENT)
    expect(l[0]).toBe('/f14.grid')
  })
  it('unterscheidet gleiche Dateinamen über den Ordner', () => {
    expect(recentLabels(['/x/Plan.grid', '/y/Plan.grid', '/z/Rest.grid'])).toEqual(['Plan — x', 'Plan — y', 'Rest'])
  })
})
