import { useEffect, useState } from 'react'
import * as Y from 'yjs'
import { plainOf, ringOf } from './colCrypt'
import { profilesOf, type MemberProfile, calendarsOf, readCalendars, type CalendarInfo, buildFileIndex, buildLinkIndex, mapsOf, readMaps, readReports, reportsOf, readTables, readTabs, readViews, tableOrderOf, tablesOf, viewsOf, type FileRef, type LinkIndex, type MapInfo, type ReportInfo, type TabInfo, type TableInfo, type ViewInfo } from './model'

/** Liest die Tabellenstruktur reaktiv; Zellwerte werden in der Zelle selbst beobachtet. */
export function useTables(doc: Y.Doc): TableInfo[] {
  const [tables, setTables] = useState(() => readTables(doc))
  useEffect(() => {
    const update = () => setTables(readTables(doc))
    const root = tablesOf(doc)
    root.observeDeep(update)
    update()
    return () => root.unobserveDeep(update)
  }, [doc])
  return tables
}

export function useCell(doc: Y.Doc, tableId: string, rowId: string, colId: string) {
  const row = () => tablesOf(doc).get(tableId)?.get('rows').get(rowId) as Y.Map<any> | undefined
  const [value, setValue] = useState<any>(() => row()?.get(colId) ?? null)
  useEffect(() => {
    const r = row()
    if (!r) return
    const update = () => setValue(r.get(colId) ?? null)
    r.observe(update)
    update()
    return () => r.unobserve(update)
  }, [doc, tableId, rowId, colId])
  useRingVersion(doc) // neu lesen, wenn ein Schlüssel eintrifft
  return plainOf(doc, colId, value)
}

/** Zählt hoch, wenn sich Schlüssel vertraulicher Spalten ändern (neue Schlüssel, neu geschützte Spalten). */
export function useRingVersion(doc: Y.Doc): number {
  const [v, setV] = useState(() => ringOf(doc).version)
  useEffect(() => ringOf(doc).subscribe(() => setV((n) => n + 1)), [doc])
  return v
}

export function useLinkIndex(doc: Y.Doc): LinkIndex {
  const [index, setIndex] = useState(() => buildLinkIndex(doc))
  useEffect(() => {
    const links = doc.getMap('links')
    const update = () => setIndex(buildLinkIndex(doc))
    links.observe(update)
    update()
    return () => links.unobserve(update)
  }, [doc])
  return index
}

/** Zählt hoch, wenn sich die Zeile ändert (für Kacheln, die Zellwerte anzeigen). */
export function useRowVersion(doc: Y.Doc, tableId: string, rowId: string) {
  const [v, setV] = useState(0)
  useEffect(() => {
    const row = tablesOf(doc).get(tableId)?.get('rows').get(rowId) as Y.Map<any> | undefined
    if (!row) return
    const bump = () => setV((n) => n + 1)
    row.observe(bump)
    return () => row.unobserve(bump)
  }, [doc, tableId, rowId])
  return v
}

export function useFileIndex(doc: Y.Doc): Map<string, FileRef[]> {
  const [index, setIndex] = useState(() => buildFileIndex(doc))
  useEffect(() => {
    const files = doc.getMap('files')
    const update = () => setIndex(buildFileIndex(doc))
    files.observe(update)
    update()
    return () => files.unobserve(update)
  }, [doc])
  return index
}

/** Tabellen, abgeleitete Tabellen und ihre gemeinsame Reihenfolge in der Kopfzeile, reaktiv. */
export function useTabs(doc: Y.Doc): { tables: TableInfo[]; views: ViewInfo[]; maps: MapInfo[]; reports: ReportInfo[]; calendars: CalendarInfo[]; tabs: TabInfo[] } {
  const read = () => ({ tables: readTables(doc), views: readViews(doc), maps: readMaps(doc), reports: readReports(doc), calendars: readCalendars(doc), tabs: readTabs(doc) })
  const [state, setState] = useState(read)
  useEffect(() => {
    const update = () => setState(read())
    const targets = [tablesOf(doc), viewsOf(doc), mapsOf(doc), reportsOf(doc), calendarsOf(doc)]
    for (const t of targets) t.observeDeep(update)
    const order = tableOrderOf(doc)
    order.observe(update)
    update()
    return () => { for (const t of targets) t.unobserveDeep(update); order.unobserve(update) }
  }, [doc])
  return state
}

/** Name und Avatar der Mitglieder, wie sie im Dokument stehen (jeder Client trägt sein eigenes Profil ein). */
export function useProfiles(doc: Y.Doc): Record<string, MemberProfile> {
  const read = () => Object.fromEntries(profilesOf(doc).entries())
  const [profiles, setProfiles] = useState(read)
  useEffect(() => {
    const m = profilesOf(doc)
    const update = () => setProfiles(Object.fromEntries(m.entries()))
    update()
    m.observe(update)
    return () => m.unobserve(update)
  }, [doc])
  return profiles
}
