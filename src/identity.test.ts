import { beforeEach, describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { exportAccount, fingerprint, fromHex, getIdentity, importAccount, signMessage, useKeyStore } from './identity'

let saved: string | null
beforeEach(() => { saved = null; useKeyStore({ load: async () => saved, save: async (v) => { saved = v } }) })

describe('Konto', () => {
  it('legt beim ersten Mal ein Konto an und liefert danach dasselbe', async () => {
    const a = await getIdentity()
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(a.publicKey).toHaveLength(64)
    expect(saved).toContain(a.id)
    useKeyStore({ load: async () => saved, save: async (v) => { saved = v } }) // „Neustart“
    expect((await getIdentity()).publicKey).toBe(a.publicKey)
  })

  it('signiert so, dass der öffentliche Schlüssel die Signatur bestätigt', async () => {
    const a = await getIdentity()
    const sig = signMessage(a, 'grid-login-v1\nx\ny')
    expect(ed25519.verify(fromHex(sig), new TextEncoder().encode('grid-login-v1\nx\ny'), fromHex(a.publicKey))).toBe(true)
    expect(ed25519.verify(fromHex(sig), new TextEncoder().encode('anderer Text'), fromHex(a.publicKey))).toBe(false)
  })

  it('überträgt das Konto mit Passwort auf ein anderes Gerät', async () => {
    const a = await getIdentity()
    const text = await exportAccount('geheim')
    expect(text).not.toContain(a.id)
    saved = null
    useKeyStore({ load: async () => saved, save: async (v) => { saved = v } }) // zweites Gerät
    await expect(importAccount(text, 'falsch')).rejects.toThrow('Passwort falsch')
    await expect(importAccount('quatsch', 'geheim')).rejects.toThrow('kein Grid-Konto')
    const b = await importAccount(text, 'geheim')
    expect([b.id, b.publicKey]).toEqual([a.id, a.publicKey])
    expect((await getIdentity()).id).toBe(a.id)
    expect(saved).toContain(a.id)
  })

  it('zeigt einen Fingerabdruck in vier Blöcken', async () => {
    expect(fingerprint((await getIdentity()).publicKey)).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/)
  })
})
