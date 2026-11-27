import { beforeEach, describe, expect, it } from 'vitest'
import { readZoom, setZoom, viewportFor } from './zoom'

describe('Größe der Oberfläche', () => {
  const store = new Map<string, string>()
  beforeEach(() => {
    store.clear()
    globalThis.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } } as Storage
  })

  it('ist ohne Eintrag 100 %', () => expect(readZoom()).toBe(1))
  it('merkt sich die Wahl', () => { setZoom(1.5); expect(readZoom()).toBe(1.5) })
  it('ignoriert Werte, die nicht zur Auswahl stehen (sonst ließe sich die Oberfläche unbedienbar einstellen)', () => {
    for (const v of ['0.05', '40', 'groß', '']) { store.set('grid-zoom', v); expect(readZoom()).toBe(1) }
  })
  it('skaliert auf iPad und iPhone über den Viewport, ohne feste Breite (sonst passte es nach dem Drehen nicht)', () => {
    expect(viewportFor(1)).toBe('width=device-width, initial-scale=1, viewport-fit=cover')
    expect(viewportFor(2.5)).toBe('initial-scale=2.5, minimum-scale=2.5, maximum-scale=2.5, user-scalable=no, viewport-fit=cover')
  })
})
