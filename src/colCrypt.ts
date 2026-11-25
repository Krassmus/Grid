/**
 * Vertrauliche Spalten (docs/RIGHTS.md, „Verschlüsselung je Spalte“): Die Zellwerte einer Spalte, die nicht jedes Mitglied lesen darf, stehen
 * verschlüsselt im Dokument. Jede Spalte hat einen oder mehrere Schlüssel (Kennung `kid`); der neueste verschlüsselt. Admins verpacken jeden
 * Schlüssel für jeden Leser einzeln (Schlüsselkiste wie beim Dokumentschlüssel, `e2e.ts`) und legen sie im Dokument ab (`colkeys`).
 *
 * Aufbau von `colkeys` (nur Admins schreiben, für alle anderen gilt es als Struktur):
 *  - `<Spalte>|<kid>`            → `{ n }`           ein Schlüssel der Spalte; der mit größtem `n` (bei Gleichstand kleinster `kid`) ist der neueste
 *  - `<Spalte>|<kid>|<Konto>`    → `{ from, box }`   der Schlüssel, für dieses Konto von Admin `from` verpackt
 * Zellwert: `gce1:<kid>:<base64(Nonce 24 | XChaCha20-Poly1305(JSON des Werts))>`, zugeordnete Daten `grid-col-v1|<Spalte>|<kid>`.
 */
import * as Y from 'yjs'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { randomBytes } from '@noble/ciphers/utils.js'
import type { AdminState } from './adminLog'
import { b64, openKeyBox, sealKeyBox, unb64 } from './e2e'
import type { Identity } from './identity'
import { t } from './i18n'

export const PREFIX = 'gce1:'
const enc = new TextEncoder(), dec = new TextDecoder()

export const colKeysOf = (doc: Y.Doc) => doc.getMap<any>('colkeys')

export interface KeyMeta { kid: string; n: number }

/** Herkunft von Änderungen, die nur ver- oder umschlüsseln (das Änderungsprotokoll übergeht sie). */
export const COLCRYPT = Symbol('colcrypt')

const aad = (col: string, kid: string) => enc.encode(`grid-col-v1|${col}|${kid}`)
const boxScope = (docId: string, col: string, kid: string) => `${docId}|col|${col}|${kid}`

export const newKid = () => [...randomBytes(8)].map((x) => x.toString(16).padStart(2, '0')).join('')

/** Die Metaeinträge der Schlüssel aus dem Dokument, je Spalte, neueste zuerst. */
function readIndex(doc: Y.Doc): Map<string, KeyMeta[]> {
  const idx = new Map<string, KeyMeta[]>()
  colKeysOf(doc).forEach((v, key) => {
    const p = key.split('|')
    if (p.length !== 2 || !v || typeof v.n !== 'number') return
    const list = idx.get(p[0]) ?? []
    list.push({ kid: p[1], n: v.n })
    idx.set(p[0], list)
  })
  for (const list of idx.values()) list.sort((a, b) => b.n - a.n || (a.kid < b.kid ? -1 : 1))
  return idx
}

export class Ring {
  /** Schlüssel, die dieses Gerät kennt */
  private keys = new Map<string, Uint8Array>()
  private idx: Map<string, KeyMeta[]> | null = null
  private cache = new Map<string, unknown>()
  private listeners = new Set<() => void>()
  /** zählt hoch, wenn sich etwas ändert, das Anzeigen betrifft (neue Schlüssel, neue geschützte Spalten) */
  version = 0

  constructor(readonly doc: Y.Doc) {
    colKeysOf(doc).observe(() => { this.idx = null; this.bump() })
  }

  private bump() { this.version++; for (const l of this.listeners) l() }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }

  private index() { return (this.idx ??= readIndex(this.doc)) }
  metas(col: string): KeyMeta[] { return this.index().get(col) ?? [] }
  /** Hat die Spalte (mindestens) einen Schlüssel, sind ihre Zellen verschlüsselt. */
  isProtected(col: string) { return this.index().has(col) }
  protectedColumns(): string[] { return [...this.index().keys()] }
  current(col: string): string | null { return this.metas(col)[0]?.kid ?? null }
  has(kid: string) { return this.keys.has(kid) }
  keyOf(kid: string) { return this.keys.get(kid) }
  /** Geschützt, aber der neueste Schlüssel fehlt auf diesem Gerät: lesen und schreiben geht nicht. */
  locked(col: string) { const k = this.current(col); return k !== null && !this.keys.has(k) }

  /** Übernimmt die Schlüssel eines anderen Rings (Kopie des Dokuments, z. B. für die Zeitreise). */
  inherit(from: Ring) { for (const [kid, key] of from.keys) this.keys.set(kid, key); this.cache.clear() }

  adopt(kid: string, key: Uint8Array) {
    if (this.keys.has(kid)) return
    this.keys.set(kid, key)
    this.cache.clear()
    this.bump()
  }

  /** Klartext einer Zelle (`null`, wenn der Schlüssel fehlt oder der Wert nicht lesbar ist). */
  decrypt(col: string, raw: string): unknown {
    if (this.cache.has(raw)) return this.cache.get(raw)
    let out: unknown = null
    const m = /^gce1:([0-9a-f]+):(.*)$/.exec(raw)
    const key = m && this.keys.get(m[1])
    if (m && key) {
      try {
        const data = unb64(m[2])
        out = JSON.parse(dec.decode(xchacha20poly1305(key, data.subarray(0, 24), aad(col, m[1])).decrypt(data.subarray(24))))
      } catch { out = null }
      if (this.cache.size > 20000) this.cache.clear()
      this.cache.set(raw, out)
    }
    return out
  }

  /** Verschlüsselt einen Zellwert mit dem neuesten Schlüssel der Spalte. */
  encrypt(col: string, value: unknown, kid = this.current(col)): string {
    const key = kid ? this.keys.get(kid) : undefined
    if (!kid || !key) throw new Error(t('Der Schlüssel dieser Spalte fehlt: Ein Admin muss ihn senden.'))
    const nonce = randomBytes(24)
    const ct = xchacha20poly1305(key, nonce, aad(col, kid)).encrypt(enc.encode(JSON.stringify(value)))
    const body = new Uint8Array(24 + ct.length)
    body.set(nonce); body.set(ct, 24)
    return `${PREFIX}${kid}:${b64(body)}`
  }

  /** Die Kennung eines verschlüsselten Werts (`null`: kein Chiffretext). */
  kidOf(raw: unknown): string | null { return typeof raw === 'string' ? (/^gce1:([0-9a-f]+):/.exec(raw)?.[1] ?? null) : null }

  /**
   * Öffnet die Schlüsselkisten für `me`, die noch nicht geöffnet sind. Kisten gelten nur von Admins des geprüften Protokolls.
   * Gibt `true` zurück, wenn etwas Neues geöffnet wurde.
   */
  async openBoxes(docId: string, me: Identity, state: AdminState | null): Promise<boolean> {
    if (!state) return false
    let fresh = false
    const jobs: Promise<void>[] = []
    colKeysOf(this.doc).forEach((v, key) => {
      const p = key.split('|')
      if (p.length !== 3 || p[2] !== me.id || this.keys.has(p[1]) || !v || typeof v.box !== 'string') return
      const sender = state.members.get(v.from)
      if (!sender || sender.role !== 'admin') return
      jobs.push(openKeyBox(me, { id: v.from, pub: sender.pub }, boxScope(docId, p[0], p[1]), 0, v.box).then((k) => { if (!this.keys.has(p[1])) { this.keys.set(p[1], k); this.cache.clear(); fresh = true } }, () => { /* nicht für uns oder verfälscht */ }))
    })
    await Promise.all(jobs)
    if (fresh) this.bump()
    return fresh
  }

  /** Legt einen neuen Schlüssel für die Spalte an (nur Admins) und verpackt ihn für `readers`. Gibt die Kennung zurück. */
  async createKey(docId: string, me: Identity, state: AdminState, col: string, readers: Iterable<string>): Promise<string> {
    const kid = newKid(), key = randomBytes(32)
    const n = (this.metas(col)[0]?.n ?? 0) + 1
    const boxes = await this.boxesFor(docId, me, state, col, kid, key, readers)
    this.keys.set(kid, key)
    this.cache.clear()
    this.doc.transact(() => {
      const map = colKeysOf(this.doc)
      map.set(`${col}|${kid}`, { n })
      for (const [acct, box] of boxes) map.set(`${col}|${kid}|${acct}`, { from: me.id, box })
    }, COLCRYPT)
    return kid
  }

  /** Verpackt einen bekannten Schlüssel für weitere Leser (nur Admins, die ihn kennen). */
  async shareKey(docId: string, me: Identity, state: AdminState, col: string, kid: string, readers: Iterable<string>): Promise<void> {
    const key = this.keys.get(kid)
    if (!key) return
    const boxes = await this.boxesFor(docId, me, state, col, kid, key, readers)
    if (!boxes.length) return
    this.doc.transact(() => { for (const [acct, box] of boxes) colKeysOf(this.doc).set(`${col}|${kid}|${acct}`, { from: me.id, box }) }, COLCRYPT)
  }

  private async boxesFor(docId: string, me: Identity, state: AdminState, col: string, kid: string, key: Uint8Array, readers: Iterable<string>) {
    const out: [string, string][] = []
    for (const acct of readers) {
      const m = state.members.get(acct)
      if (m) out.push([acct, await sealKeyBox(me, { id: acct, pub: m.pub }, boxScope(docId, col, kid), 0, key)])
    }
    return out
  }

  /** Konten, für die ein Schlüssel der Spalte verpackt ist, je Schlüsselkennung. */
  boxedFor(col: string, kid: string): Set<string> {
    const out = new Set<string>()
    const prefix = `${col}|${kid}|`
    colKeysOf(this.doc).forEach((_v, key) => { if (key.startsWith(prefix) && key.split('|').length === 3) out.add(key.slice(prefix.length)) })
    return out
  }
}

const rings = new WeakMap<Y.Doc, Ring>()
export const ringOf = (doc: Y.Doc): Ring => { let r = rings.get(doc); if (!r) { r = new Ring(doc); rings.set(doc, r) } return r }

/** Der lesbare Wert einer gespeicherten Zelle: Klartext, entschlüsselt, oder `null` (Schlüssel fehlt). Für ungeschützte Spalten der Wert selbst. */
export function plainOf(doc: Y.Doc, col: string, raw: unknown): any {
  if (typeof raw !== 'string' || !raw.startsWith(PREFIX)) return raw
  const ring = ringOf(doc)
  return ring.isProtected(col) ? ring.decrypt(col, raw) : raw
}

/** Der Wert, der gespeichert werden soll: bei geschützten Spalten verschlüsselt (wirft, wenn der Schlüssel fehlt). */
export function sealCell(doc: Y.Doc, col: string, value: any): any {
  if (value === null || value === undefined || value === '') return value
  const ring = ringOf(doc)
  return ring.isProtected(col) ? ring.encrypt(col, value) : value
}
