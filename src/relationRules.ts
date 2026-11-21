import { RELATION } from './columnTypes'
import type { ColumnInfo, LinkIndex } from './model'

/** Darf ein Zieldatensatz von mehreren Zeilen aus verknüpft werden (Einstellung der Relationsspalte)? */
export const allowsMultiTarget = (col: ColumnInfo): boolean => !!RELATION.config(col).multiTarget

/**
 * Darf `targetId` in dieser Relationsspalte noch verknüpft werden? Ohne die Einstellung „Zieldatensatz darf mehrfach
 * verknüpft werden“ nur, wenn keine andere Zeile schon darauf verweist. `ignore`: Zeilen, die nicht zählen (die Zeile
 * selbst, oder die Quelle einer Verschiebung). `exists` blendet Verknüpfungen gelöschter Zeilen aus.
 */
export function targetAvailable(index: LinkIndex, col: ColumnInfo, targetId: string, ignore: string[] = [], exists: (rowId: string) => boolean = () => true): boolean {
  if (allowsMultiTarget(col)) return true
  return !(index.backward.get(`${targetId}|${col.id}`) ?? []).some((r) => !ignore.includes(r) && exists(r))
}
