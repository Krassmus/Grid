/** Einladung als Text: Server, Dokument und der einladende Admin (mit Fingerabdruck zum Vergleichen). */
import { t as tr } from './i18n'

export interface Invite {
  server: string
  doc: string
  /** Name des Dokuments (nur zur Anzeige) */
  name: string
  /** Fingerabdruck des einladenden Kontos */
  admin: string
  /** öffentlicher Schlüssel des Servers (so erkennt der Eingeladene den richtigen Server) */
  key?: string
  /** Das Dokument ist Ende-zu-Ende-verschlüsselt (docs/E2E.md); der Eingeladene verbindet dann nur verschlüsselt. */
  enc?: boolean
}

const PREFIX = 'grid-invite:1:'

const toB64Url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64Url = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))

export const makeInvite = (i: Invite) => PREFIX + toB64Url(JSON.stringify(i))

export function parseInvite(text: string): Invite {
  const t = text.trim()
  if (!t.startsWith(PREFIX)) throw new Error(tr('Das ist keine Grid-Einladung'))
  let o: Partial<Invite>
  try { o = JSON.parse(fromB64Url(t.slice(PREFIX.length))) } catch { throw new Error(tr('Die Einladung ist beschädigt')) }
  if (typeof o.server !== 'string' || typeof o.doc !== 'string' || !/^[0-9a-zA-Z-]{8,64}$/.test(o.doc) || !/^https?:\/\//i.test(o.server)) {
    throw new Error(tr('Die Einladung ist unvollständig'))
  }
  return {
    server: o.server, doc: o.doc, name: typeof o.name === 'string' ? o.name : '', admin: typeof o.admin === 'string' ? o.admin : '',
    ...(typeof o.key === 'string' && /^[0-9a-f]{64}$/.test(o.key) ? { key: o.key } : {}),
    ...(o.enc === true ? { enc: true } : {}),
  }
}
