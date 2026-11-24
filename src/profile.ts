/**
 * Dein Profil, einmal für alle Dokumente: Anzeigename, E-Mail-Adresse und Avatar. Es liegt nur auf diesem Gerät
 * (der Name geht in Beitrittsanfragen und ins Mitgliederprotokoll ein, die Adresse nur an den Server, den du dafür wählst).
 */
import { getAccountName, setAccountName } from './identity'
import { t } from './i18n'

export interface Profile { name: string; email: string; /** kleines Bild als Daten-Adresse, oder leer */ avatar: string }

const EMAIL = 'grid-profile-email'
const AVATAR = 'grid-profile-avatar'
const listeners = new Set<() => void>()
const read = (k: string) => { try { return localStorage.getItem(k) ?? '' } catch { return '' } }
const write = (k: string, v: string) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k) } catch { /* egal */ } }

export const getProfile = (): Profile => ({ name: getAccountName(), email: read(EMAIL), avatar: read(AVATAR) })

export function setProfile(p: Partial<Profile>) {
  if (p.name !== undefined) setAccountName(p.name)
  if (p.email !== undefined) write(EMAIL, p.email.trim().slice(0, 254))
  if (p.avatar !== undefined) write(AVATAR, p.avatar.startsWith('data:image/') && p.avatar.length < 200_000 ? p.avatar : '')
  listeners.forEach((f) => f())
}

/** Meldet Änderungen am Profil (z. B. für die Anzeige des Avatars). */
export const onProfileChange = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

/** Anfangsbuchstaben für den Avatar ohne Bild („Anna Beispiel“ → „AB“). */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return (parts.length === 1 ? [...parts[0]].slice(0, 2) : [[...parts[0]][0], [...parts[parts.length - 1]][0]]).join('').toUpperCase()
}

/** Bilddatei auf ein kleines Quadrat (128 px, Mitte) verkleinern. Das Ergebnis ist eine Daten-Adresse (JPEG). */
export async function avatarFromFile(file: File, size = 128): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error(t('Das ist kein Bild'))
  const bitmap = await createImageBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error(t('Bild konnte nicht verarbeitet werden'))
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size)
  bitmap.close?.()
  return canvas.toDataURL('image/jpeg', 0.85)
}
