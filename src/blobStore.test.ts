import { describe, expect, it } from 'vitest'
import { typedBlob } from './blobStore'

const blob = (text: string, type = 'application/octet-stream') => new Blob([text], { type })

describe('typedBlob', () => {
  it('erkennt SVG ohne Typ (z. B. aus der Cloud) und setzt image/svg+xml', async () => {
    expect((await typedBlob(blob('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).type).toBe('image/svg+xml')
    expect((await typedBlob(blob('﻿  <?xml version="1.0"?>\n<!-- Logo -->\n<svg width="1"/>', ''))).type).toBe('image/svg+xml')
    expect((await typedBlob(blob('<SVG viewBox="0 0 1 1"></SVG>'))).type).toBe('image/svg+xml')
  })
  it('lässt Bilder mit Typ und andere Dateien unverändert', async () => {
    const png = blob('x', 'image/png')
    expect(await typedBlob(png)).toBe(png)
    const other = blob('<html><svg></svg></html>')
    expect(await typedBlob(other)).toBe(other)
    expect((await typedBlob(blob('Hallo Welt'))).type).toBe('application/octet-stream')
  })
})
