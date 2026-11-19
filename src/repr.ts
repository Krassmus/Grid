/**
 * Darstellung eines Datensatzes („Repräsentation“): wie eine Zeile in Relationszellen, Rückverweisen und der Auswahl erscheint.
 * Je Tabelle einstellbar: Titel, Untertitel und Avatar. Ohne Einstellung gilt das bisherige Verhalten.
 */
import * as Y from 'yjs'
import { summarize, type ColumnInfo, type TableInfo } from './model'
import { columnCells, fileIndex, newCtx, type CellCtx } from './cells'

export type AvatarMode = 'default' | 'none' | 'initial' | 'image' | 'icon' | 'text'

export interface ReprConfig {
  /** Spalte für den Titel; '' = Standard (erste Textspalte). */
  title: string
  /** Spalte für den Untertitel; '' = keiner. */
  sub: string
  avatar: AvatarMode
  /** Dateispalte (Bild) bzw. Textspalte (Symbol aus Spalte). */
  avatarCol: string
  /** Festes Symbol oder Emoji. */
  icon: string
}

const DEFAULTS: ReprConfig = { title: '', sub: '', avatar: 'default', avatarCol: '', icon: '' }
const AVATARS: AvatarMode[] = ['default', 'none', 'initial', 'image', 'icon', 'text']

export function reprConfig(table: Pick<TableInfo, 'repr'>): ReprConfig {
  const r = table.repr ?? {}
  const str = (k: keyof ReprConfig) => (typeof r[k] === 'string' ? (r[k] as string) : DEFAULTS[k] as string)
  const avatar = AVATARS.includes(r.avatar as AvatarMode) ? (r.avatar as AvatarMode) : 'default'
  return { title: str('title'), sub: str('sub'), avatar, avatarCol: str('avatarCol'), icon: str('icon') }
}

export const initials = (t: string) =>
  t.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('')

export interface ReprAvatar {
  /** Initialen, Symbol oder (bei Bildern) Ersatztext, solange das Bild fehlt. */
  text: string
  hash?: string
  /** Fest gewähltes Symbol statt Initialen. */
  symbol?: boolean
}
export interface Repr {
  title: string
  subs: string[]
  avatar?: ReprAvatar
  /** Avatar bzw. Untertitel auch in den Zellen zeigen (nur, wenn ausdrücklich eingestellt). */
  avatarInCells: boolean
  subInCells: boolean
}

const titleCapable = (c: ColumnInfo) => c.type !== 'relation' && c.type !== 'file'

/** Darstellung aller Zeilen der Tabelle. Spalten werden dafür je einmal berechnet. */
export function computeRepr(doc: Y.Doc, tables: TableInfo[], table: TableInfo, ctx: CellCtx = newCtx()): Map<string, Repr> {
  const cfg = reprConfig(table)
  const col = (id: string) => table.columns.find((c) => c.id === id)
  const titleCol = cfg.title ? col(cfg.title) : undefined
  const subCol = cfg.sub ? col(cfg.sub) : undefined
  const iconCol = cfg.avatar === 'text' ? col(cfg.avatarCol) : undefined
  const imgCol = cfg.avatar === 'image' ? col(cfg.avatarCol) : undefined
  const cellsOf = (c: ColumnInfo | undefined) => (c && titleCapable(c) ? columnCells(doc, tables, table, c, ctx) : undefined)
  const titles = cellsOf(titleCol), subs = cellsOf(subCol), icons = cellsOf(iconCol)
  const files = imgCol ? fileIndex(doc, ctx) : undefined
  const avatarInCells = cfg.avatar !== 'default' && cfg.avatar !== 'none'
  const subInCells = !!subCol

  const out = new Map<string, Repr>()
  for (const rid of table.rowIds) {
    const base = summarize(doc, table, rid)
    const title = titles ? titles.get(rid)?.text || 'Ohne Titel' : base.title
    const t = subs?.get(rid)?.text
    const subList = t && t !== title ? [t] : []

    let avatar: ReprAvatar | undefined
    const fallback = { text: initials(title) }
    switch (cfg.avatar) {
      case 'none': avatar = undefined; break
      case 'icon': avatar = cfg.icon.trim() ? { text: cfg.icon.trim(), symbol: true } : fallback; break
      case 'text': { const t = icons?.get(rid)?.text.trim(); avatar = t ? { text: [...t].slice(0, 4).join(''), symbol: true } : fallback; break }
      case 'image': {
        const img = (files?.get(`${rid}|${imgCol?.id}`) ?? []).find((f) => (f as { mime?: string }).mime?.startsWith('image/')) as { hash: string } | undefined
        avatar = img ? { ...fallback, hash: img.hash } : fallback
        break
      }
      default: avatar = fallback
    }
    out.set(rid, { title, subs: subList, avatar, avatarInCells, subInCells })
  }
  return out
}

/** Wie `computeRepr`, aber je Tabelle nur einmal pro Zwischenspeicher. Zyklen (Titelformel verweist über Relationen zurück) fallen auf die Standarddarstellung zurück. */
export function reprMap(doc: Y.Doc, tables: TableInfo[], table: TableInfo, ctx: CellCtx): Map<string, Repr> {
  const key = table.id
  const hit = ctx.reprs?.get(key)
  if (hit) return hit
  ctx.reprBusy ??= new Set()
  if (ctx.reprBusy.has(key)) return computeRepr(doc, tables, { ...table, repr: {} }, ctx)
  ctx.reprBusy.add(key)
  try {
    const m = computeRepr(doc, tables, table, ctx);
    (ctx.reprs ??= new Map()).set(key, m)
    return m
  } finally { ctx.reprBusy.delete(key) }
}
