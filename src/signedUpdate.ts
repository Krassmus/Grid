/**
 * Signierte Änderungen (Rechte Phase 2, docs/RIGHTS.md): Solange es Gruppen gibt, trägt jeder verschlüsselte Eintrag im Datenstrom
 * Konto-Kennung und Unterschrift des Autors. Aufbau des Klartexts (vor der AES-Verschlüsselung):
 * `GRU1 | Art (1: 0 Änderung, 1 Gesamtzustand) | Länge der Kennung (1) | Kennung (UTF-8) | Unterschrift (64) | Yjs-Update`.
 * Ohne Gruppen bleibt der Klartext das bloße Update (so bleiben alte Clients lesefähig).
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromHex, signMessage, toHex, type Identity } from './identity'

const MAGIC = [0x47, 0x52, 0x55, 0x31] // „GRU1“
export type SealKind = 'upd' | 'snap'

export interface Seal { author: string; kind: SealKind; sig: Uint8Array; update: Uint8Array; header: number }

const message = (doc: string, kind: SealKind, author: string, update: Uint8Array) =>
  ['grid-upd-v1', doc, kind, author, toHex(sha256(update))].join('\n')

export function seal(me: Identity, doc: string, update: Uint8Array, kind: SealKind = 'upd'): Uint8Array {
  const id = new TextEncoder().encode(me.id)
  const sig = fromHex(signMessage(me, message(doc, kind, me.id, update)))
  const out = new Uint8Array(4 + 1 + 1 + id.length + 64 + update.length)
  out.set(MAGIC, 0)
  out[4] = kind === 'snap' ? 1 : 0
  out[5] = id.length
  out.set(id, 6)
  out.set(sig, 6 + id.length)
  out.set(update, 6 + id.length + 64)
  return out
}

/** Liest die Hülle; `null`, wenn der Klartext keine hat (oder sie unvollständig ist). Die Unterschrift wird hier noch nicht geprüft. */
export function unseal(plain: Uint8Array): Seal | null {
  if (plain.length < 6 + 64 || MAGIC.some((b, i) => plain[i] !== b)) return null
  const n = plain[5]
  if (n < 8 || plain.length < 6 + n + 64) return null
  const author = new TextDecoder().decode(plain.subarray(6, 6 + n))
  return { author, kind: plain[4] === 1 ? 'snap' : 'upd', sig: plain.slice(6 + n, 6 + n + 64), update: plain.slice(6 + n + 64), header: 6 + n + 64 }
}

/** Stammt die Hülle wirklich vom Konto mit diesem öffentlichen Schlüssel? */
export function verifySeal(doc: string, s: Seal, pubHex: string): boolean {
  try { return ed25519.verify(s.sig, new TextEncoder().encode(message(doc, s.kind, s.author, s.update)), fromHex(pubHex)) } catch { return false }
}
