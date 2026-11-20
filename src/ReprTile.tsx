import { createContext, useContext } from 'react'
import { thumbKey } from './blobStore'
import { useBlobUrl } from './FileCell'
import type { Repr, ReprAvatar } from './repr'

/** Darstellung der Zeilen je Tabelle (von ClientPane bereitgestellt); fehlt eine Tabelle, gilt die Standarddarstellung. */
export const ReprContext = createContext<(tableId: string) => Map<string, Repr> | undefined>(() => undefined)
export const useReprs = () => useContext(ReprContext)

function AvatarImage({ avatar }: { avatar: ReprAvatar }) {
  const { url } = useBlobUrl([thumbKey(avatar.hash!), avatar.hash!])
  return url ? <img className="avatar image" src={url} alt="" draggable={false} /> : <div className="avatar">{avatar.text}</div>
}

export function Avatar({ avatar }: { avatar: ReprAvatar }) {
  if (avatar.hash) return <AvatarImage avatar={avatar} />
  return <div className={`avatar${avatar.symbol ? ' symbol' : ''}`}>{avatar.text}</div>
}

/** Inhalt einer Kachel: Avatar, Titel und Untertitel. */
export function TileContent({ repr }: { repr: Pick<Repr, 'title' | 'subs' | 'avatar' | 'hideTitle'> }) {
  const bare = !!repr.hideTitle && repr.subs.length === 0 // nur Avatar
  return (
    <>
      {repr.avatar && <Avatar avatar={repr.avatar} />}
      {!bare && (
        <div className="tile-body">
          {!repr.hideTitle && <div className="tile-title">{repr.title}</div>}
          {repr.subs.map((x, i) => <div key={i} className="tile-sub">{x}</div>)}
        </div>
      )}
    </>
  )
}

export const tileClasses = (r: Pick<Repr, 'avatarInCells' | 'subInCells'> | null) =>
  `${r?.avatarInCells ? 'rich-avatar' : ''} ${r?.subInCells ? 'rich-sub' : ''}`
