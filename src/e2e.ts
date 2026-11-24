/**
 * Ende-zu-Ende-Verschlüsselung: Bausteine (Formate und Hintergrund: docs/E2E.md).
 *  - Einträge und Dateien: AES-256-GCM mit dem Dokumentschlüssel der jeweiligen Epoche.
 *  - Schlüsselkisten: X25519 zwischen den Konto-Schlüsseln (aus Ed25519 abgeleitet), HKDF-SHA-256, AES-GCM.
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromHex, type Identity } from './identity'
import { t } from './i18n'

const enc = new TextEncoder()
const bytes = (s: string) => enc.encode(s)
const buf = (b: Uint8Array) => b as BufferSource

export const b64 = (b: Uint8Array) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s) }
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

export const newDocKey = () => crypto.getRandomValues(new Uint8Array(32))

const NONCE = 12
const TAG = 16
/** Kleinste mögliche Länge eines verschlüsselten Eintrags: Epoche + Nonce + Tag. */
export const MIN_ENTRY = 1 + NONCE + TAG

async function aes(raw: Uint8Array) {
  return crypto.subtle.importKey('raw', buf(raw), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

async function seal(raw: Uint8Array, plain: Uint8Array, aad: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(NONCE))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(bytes(aad)) }, await aes(raw), buf(plain)))
  const out = new Uint8Array(NONCE + ct.length)
  out.set(iv); out.set(ct, NONCE)
  return out
}

async function open(raw: Uint8Array, data: Uint8Array, aad: string): Promise<Uint8Array> {
  if (data.length < NONCE + TAG) throw new Error(t('Verschlüsselte Daten sind zu kurz'))
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(data.subarray(0, NONCE)), additionalData: buf(bytes(aad)) }, await aes(raw), buf(data.subarray(NONCE))))
  } catch { throw new Error(t('Entschlüsseln fehlgeschlagen (falscher Schlüssel oder veränderte Daten)')) }
}

/** Der Schlüssel für diese Epoche fehlt (noch): ein Admin muss ihn senden. */
export class MissingKey extends Error { constructor(readonly epoch: number) { super(t("Schlüssel für Epoche {epoch} fehlt", { epoch })) } }

// ---------- Einträge des Protokolls und Dateien ----------

const entryAad = (doc: string, epoch: number) => `grid-e2e-v1|${doc}|${epoch}`
const blobAad = (doc: string, epoch: number, name: string) => `grid-e2e-blob-v1|${doc}|${epoch}|${name}`

function withEpoch(epoch: number, body: Uint8Array) {
  const out = new Uint8Array(1 + body.length)
  out[0] = epoch
  out.set(body, 1)
  return out
}

/** `Epoche (1) | Nonce (12) | Chiffretext+Tag` */
export async function encryptEntry(doc: string, epoch: number, key: Uint8Array, plain: Uint8Array) {
  return withEpoch(epoch, await seal(key, plain, entryAad(doc, epoch)))
}
export async function decryptEntry(doc: string, keyFor: (epoch: number) => Promise<Uint8Array | undefined>, data: Uint8Array) {
  if (data.length < MIN_ENTRY) throw new Error(t('Eintrag zu kurz'))
  const epoch = data[0]
  const key = await keyFor(epoch)
  if (!key) throw new MissingKey(epoch)
  return open(key, data.subarray(1), entryAad(doc, epoch))
}

export async function encryptBlob(doc: string, epoch: number, key: Uint8Array, name: string, plain: Uint8Array) {
  return withEpoch(epoch, await seal(key, plain, blobAad(doc, epoch, name)))
}
export async function decryptBlob(doc: string, keyFor: (epoch: number) => Promise<Uint8Array | undefined>, name: string, data: Uint8Array) {
  if (data.length < MIN_ENTRY) throw new Error(t('Datei zu kurz'))
  const epoch = data[0]
  const key = await keyFor(epoch)
  if (!key) throw new MissingKey(epoch)
  return open(key, data.subarray(1), blobAad(doc, epoch, name))
}

// ---------- Schlüsselkisten ----------

function boxKey(me: Identity, theirPubHex: string): Uint8Array {
  const shared = x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(me.secretKey), ed25519.utils.toMontgomery(fromHex(theirPubHex)))
  return hkdf(sha256, shared, undefined, bytes('grid-key-v1'), 32)
}
const boxAad = (doc: string, epoch: number, sender: string, recipient: string) => `grid-key-v1|${doc}|${epoch}|${sender}|${recipient}`

/** Dokumentschlüssel einer Epoche für ein Mitglied verpacken (Text, base64). */
export async function sealKeyBox(me: Identity, recipient: { id: string; pub: string }, doc: string, epoch: number, key: Uint8Array): Promise<string> {
  return b64(await seal(boxKey(me, recipient.pub), key, boxAad(doc, epoch, me.id, recipient.id)))
}
/** Kiste von einem Absender öffnen (dessen öffentlicher Schlüssel muss aus dem geprüften Admin-Protokoll stammen). */
export async function openKeyBox(me: Identity, sender: { id: string; pub: string }, doc: string, epoch: number, box: string): Promise<Uint8Array> {
  const key = await open(boxKey(me, sender.pub), unb64(box), boxAad(doc, epoch, sender.id, me.id))
  if (key.length !== 32) throw new Error(t('Ungültiger Dokumentschlüssel'))
  return key
}
