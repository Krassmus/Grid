import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { decryptBlob, decryptEntry, encryptBlob, encryptEntry, MissingKey, newDocKey, openKeyBox, sealKeyBox } from './e2e'
import { fromHex, toHex, type Identity } from './identity'

const ident = (n: number): Identity => {
  const secretKey = new Uint8Array(32).fill(n)
  return { id: `acct-${n}`, secretKey, publicKey: toHex(ed25519.getPublicKey(secretKey)) }
}
const DOC = '11111111-2222-3333-4444-555555555555'
const text = (s: string) => new TextEncoder().encode(s)

describe('Einträge', () => {
  it('lassen sich mit dem Epochenschlüssel entschlüsseln, nicht mit einem anderen', async () => {
    const key = newDocKey()
    const e = await encryptEntry(DOC, 2, key, text('Hallo Welt'))
    expect(e[0]).toBe(2)
    expect(new TextDecoder().decode(await decryptEntry(DOC, async () => key, e))).toBe('Hallo Welt')
    await expect(decryptEntry(DOC, async () => newDocKey(), e)).rejects.toThrow('Entschlüsseln')
    await expect(decryptEntry(DOC, async () => undefined, e)).rejects.toBeInstanceOf(MissingKey)
  })
  it('sind an Dokument und Epoche gebunden und verfälschte werden erkannt', async () => {
    const key = newDocKey()
    const e = await encryptEntry(DOC, 1, key, text('x'))
    await expect(decryptEntry('99999999-2222-3333-4444-555555555555', async () => key, e)).rejects.toThrow()
    const swapped = Uint8Array.from(e); swapped[0] = 2 // andere Epoche behauptet
    await expect(decryptEntry(DOC, async () => key, swapped)).rejects.toThrow()
    const bent = Uint8Array.from(e); bent[bent.length - 1] ^= 1
    await expect(decryptEntry(DOC, async () => key, bent)).rejects.toThrow()
  })
  it('zwei gleiche Klartexte ergeben verschiedene Chiffretexte', async () => {
    const key = newDocKey()
    expect(toHex(await encryptEntry(DOC, 1, key, text('a')))).not.toBe(toHex(await encryptEntry(DOC, 1, key, text('a'))))
  })
})

describe('Dateien', () => {
  it('sind an ihren Namen gebunden', async () => {
    const key = newDocKey()
    const name = 'a'.repeat(64)
    const b = await encryptBlob(DOC, 1, key, name, text('Bytes'))
    expect(new TextDecoder().decode(await decryptBlob(DOC, async () => key, name, b))).toBe('Bytes')
    await expect(decryptBlob(DOC, async () => key, 'b'.repeat(64), b)).rejects.toThrow()
  })
})

describe('Schlüsselkisten', () => {
  const anna = ident(1), ben = ident(2), eve = ident(3)
  it('öffnet nur der Empfänger, und nur mit dem richtigen Absender', async () => {
    const key = newDocKey()
    const box = await sealKeyBox(anna, { id: ben.id, pub: ben.publicKey }, DOC, 1, key)
    expect(toHex(await openKeyBox(ben, { id: anna.id, pub: anna.publicKey }, DOC, 1, box))).toBe(toHex(key))
    await expect(openKeyBox(eve, { id: anna.id, pub: anna.publicKey }, DOC, 1, box)).rejects.toThrow() // falscher Empfänger
    await expect(openKeyBox(ben, { id: eve.id, pub: eve.publicKey }, DOC, 1, box)).rejects.toThrow() // falscher Absender
    await expect(openKeyBox(ben, { id: anna.id, pub: anna.publicKey }, DOC, 2, box)).rejects.toThrow() // falsche Epoche
  })
  it('Schlüssel aus Ed25519-Paaren sind nicht kurz oder leer', () => {
    expect(fromHex(anna.publicKey).length).toBe(32)
  })
})
