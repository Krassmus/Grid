import { initialsOf } from './profile'

/** Nur Bilder aus dem Dokument anzeigen, die wirklich kleine eingebettete Bilder sind (keine fremden Adressen). */
export const safeAvatar = (a: unknown): string => (typeof a === 'string' && a.length < 100_000 && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(a) ? a : '')

/** Runder Avatar: das Bild, sonst die Anfangsbuchstaben des Namens. */
export function Avatar(props: { name: string; avatar?: string; size?: number }) {
  const { name, size = 28 } = props
  const src = safeAvatar(props.avatar)
  return src
    ? <img className="profile-avatar" src={src} alt="" width={size} height={size} />
    : <span className="profile-avatar initials" style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden>{initialsOf(name)}</span>
}
