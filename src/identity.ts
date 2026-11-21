/**
 * Das Grid-Konto: eine Kennung (UUID) und ein Ed25519-Schlüsselpaar. Es entsteht beim ersten Bedarf auf dem Gerät,
 * ohne Internet. Der geheime Schlüssel liegt im Schlüsselbund des Betriebssystems (Tauri) bzw. im lokalen Speicher
 * des Browsers (Entwicklung). Mit `exportAccount` lässt sich das Konto passwortgeschützt auf ein anderes Gerät übertragen.
 * Hintergrund: docs/SYNC.md
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './gridFile'

export interface Identity {
  /** Kennung des Kontos (UUID) */
  id: string
  /** öffentlicher Schlüssel, hexadezimal */
  publicKey: string
  secretKey: Uint8Array
}

export interface KeyStore {
  load(): Promise<string | null>
  save(value: string): Promise<void>
}

const LOCAL_KEY = 'grid-account'
const defaultStore: KeyStore = {
  async load() {
    if (isTauri) return (await invoke<string | null>('identity_load').catch(() => null)) ?? null
    try { return localStorage.getItem(LOCAL_KEY) } catch { return null }
  },
  async save(value) {
    if (isTauri) { await invoke('identity_store', { value }); return }
    localStorage.setItem(LOCAL_KEY, value)
  },
}

let store: KeyStore = defaultStore
let cached: Promise<Identity> | null = null
const listeners = new Set<() => void>()

/** Nur für Tests. */
export function useKeyStore(s: KeyStore | null) { store = s ?? defaultStore; cached = null }
/** Meldet, wenn das Konto ersetzt wurde (Import). */
export const onIdentityChanged = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

// ---------- Hilfen ----------

export const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
export const fromHex = (s: string) => {
  if (!/^([0-9a-f]{2})*$/i.test(s)) throw new Error('Ungültige Schlüsseldaten')
  return Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16))
}
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

function make(id: string, secretKey: Uint8Array): Identity {
  return { id, secretKey, publicKey: toHex(ed25519.getPublicKey(secretKey)) }
}

const serialize = (i: Identity) => JSON.stringify({ v: 1, id: i.id, secret: toHex(i.secretKey) })

function parse(text: string): Identity {
  const o = JSON.parse(text)
  if (o?.v !== 1 || typeof o.id !== 'string' || typeof o.secret !== 'string') throw new Error('Kein gültiges Konto')
  const secret = fromHex(o.secret)
  if (secret.length !== 32 || !/^[0-9a-zA-Z-]{8,64}$/.test(o.id)) throw new Error('Kein gültiges Konto')
  return make(o.id, secret)
}

// ---------- Konto laden/anlegen ----------

/** Das Konto dieses Geräts; wird beim ersten Aufruf angelegt. */
export function getIdentity(): Promise<Identity> {
  cached ??= (async () => {
    const saved = await store.load()
    if (saved) { try { return parse(saved) } catch { /* beschädigt: nicht überschreiben, siehe unten */ throw new Error('Das gespeicherte Konto ist beschädigt') } }
    const fresh = make(crypto.randomUUID(), ed25519.utils.randomSecretKey())
    await store.save(serialize(fresh))
    return fresh
  })().catch((e) => { cached = null; throw e })
  return cached
}

export const signMessage = (i: Identity, message: string) => toHex(ed25519.sign(new TextEncoder().encode(message), i.secretKey))

/** Kurzform zum Vergleichen, z. B. am Telefon: `ab12-cd34-ef56-7890` (aus dem öffentlichen Schlüssel). */
export function fingerprint(publicKeyHex: string): string {
  const h = toHex(sha256(fromHex(publicKeyHex))).slice(0, 16)
  return h.match(/.{4}/g)!.join('-')
}

// ---------- Anzeigename ----------

const NAME_KEY = 'grid-account-name'
/** Name, unter dem andere dich in Dokumenten sehen (nur auf diesem Gerät gespeichert, geht in Beitrittsanfragen ein). */
export const getAccountName = () => { try { return localStorage.getItem(NAME_KEY) ?? '' } catch { return '' } }
export const setAccountName = (n: string) => { try { localStorage.setItem(NAME_KEY, n.replace(/[\r\n]/g, ' ').trim().slice(0, 60)) } catch { /* egal */ } }

// ---------- Übertragen auf ein anderes Gerät ----------

const ITER = 600_000
const PREFIX = 'grid-account:1:'

async function wrapKey(pass: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: ITER }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

/** Das Konto als Text, mit Passwort verschlüsselt (zum Kopieren oder Speichern). */
export async function exportAccount(pass: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12))
  const plain = new TextEncoder().encode(serialize(await getIdentity()))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await wrapKey(pass, salt), plain))
  return `${PREFIX}${b64(salt)}:${b64(iv)}:${b64(ct)}`
}

/** Nimmt ein exportiertes Konto auf diesem Gerät in Gebrauch (ersetzt das bisherige). */
export async function importAccount(text: string, pass: string): Promise<Identity> {
  const t = text.trim()
  if (!t.startsWith(PREFIX)) throw new Error('Das ist kein Grid-Konto')
  const [salt, iv, ct] = t.slice(PREFIX.length).split(':')
  if (!salt || !iv || !ct) throw new Error('Das ist kein Grid-Konto')
  let plain: ArrayBuffer
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) as BufferSource }, await wrapKey(pass, unb64(salt)), unb64(ct) as BufferSource)
  } catch { throw new Error('Passwort falsch oder Text beschädigt') }
  const id = parse(new TextDecoder().decode(plain))
  await store.save(serialize(id))
  cached = Promise.resolve(id)
  listeners.forEach((f) => f())
  return id
}
