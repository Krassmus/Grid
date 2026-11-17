import { invoke } from '@tauri-apps/api/core'
import { baseName, isTauri } from './gridFile'

const KEY = 'grid-recent-files'
export const MAX_RECENT = 10

/** Pfad nach vorn, ohne Dopplung, höchstens `MAX_RECENT` Einträge. */
export const withRecent = (list: string[], path: string): string[] =>
  [path, ...list.filter((p) => p !== path)].slice(0, MAX_RECENT)

/** Menütexte: Dateiname, bei gleichen Namen mit dem Ordner dahinter. */
export function recentLabels(list: string[]): string[] {
  const count = new Map<string, number>()
  for (const p of list) count.set(baseName(p), (count.get(baseName(p)) ?? 0) + 1)
  return list.map((p) => {
    const name = baseName(p)
    if ((count.get(name) ?? 0) < 2) return name
    const parts = p.split(/[\\/]/)
    return `${name} — ${parts[parts.length - 2] ?? ''}`
  })
}

export function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX_RECENT) : []
  } catch { return [] }
}

/** Speichert die Liste und gibt sie an das Menü weiter. */
export function writeRecent(list: string[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)) } catch { /* egal */ }
  if (isTauri) void invoke('set_recent_menu', { names: recentLabels(list) }).catch(() => {})
}

export const noteRecent = (path: string) => writeRecent(withRecent(readRecent(), path))
export const forgetRecent = (path: string) => writeRecent(readRecent().filter((p) => p !== path))
