import { useEffect, useMemo, useState } from 'react'
import * as Y from 'yjs'
import { calendarData, overlapWarnings, readableColumns, type CalendarData } from './calendarData'
import { readCalendars, readTables, type CellValue, type TableInfo } from './model'
import { useRingVersion } from './useTables'
import { useRights } from './rights'

/**
 * Für das Formular eines Datensatzes: Ist die Tabelle die Quelle eines Kalenders, warnt es, wenn sich der Eintrag mit einem
 * anderen überschneidet (docs/KALENDER.md), auch wenn es nicht im Kalender geöffnet wurde. Sonst `undefined`.
 */
export function useOverlapWarnings(doc: Y.Doc, tables: TableInfo[], table: TableInfo, rowId?: string) {
  const rights = useRights()
  // Nur mitzählen, wann sich Verknüpfungen ändern: den Index baut `calendarData` selbst, und das nur einmal
  const [linkVersion, setLinkVersion] = useState(0)
  useEffect(() => {
    const links = doc.getMap('links')
    const bump = () => setLinkVersion((v) => v + 1)
    links.observe(bump)
    return () => links.unobserve(bump)
  }, [doc])
  const ringVersion = useRingVersion(doc)
  const calendars = useMemo(() => {
    const own = readCalendars(doc).filter((c) => c.def.layers[0]?.table === table.id)
    if (!own.length) return []
    const readable = readableColumns(doc, tables, (tableId, colId) => rights.colAccess(tableId, colId))
    const all = readTables(doc)
    return own.map((c) => calendarData(doc, tables, c.def, readable, all)).filter((d): d is CalendarData => !('problem' in d))
  }, [doc, tables, table.id, rights, linkVersion, ringVersion])
  if (!calendars.length) return undefined
  // Zwei Kalender über dieselbe Tabelle sagen dasselbe nur einmal
  return (values: Record<string, CellValue>, relations: Record<string, string[]>) =>
    [...new Set(calendars.flatMap((data) => overlapWarnings(data, values, relations, rowId)))]
}
