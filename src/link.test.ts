import { describe, expect, it } from 'vitest'
import { linkHref } from './link'

describe('Link', () => {
  it('Web-Adressen', () => {
    expect(linkHref('url', 'example.com')).toBe('https://example.com/')
    expect(linkHref('url', 'http://example.com/a?b=1')).toBe('http://example.com/a?b=1')
    expect(linkHref('url', 'javascript:alert(1)')).toBeNull()
    expect(linkHref('url', 'nur ein Wort')).toBeNull()
    expect(linkHref('url', '')).toBeNull()
  })
  it('E-Mail und Telefon', () => {
    expect(linkHref('email', 'a@b.de')).toBe('mailto:a@b.de')
    expect(linkHref('email', 'a@b')).toBeNull()
    expect(linkHref('phone', '+49 (30) 123-456')).toBe('tel:+4930123456')
    expect(linkHref('phone', 'abc')).toBeNull()
  })
})
