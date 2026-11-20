import { useState } from 'react'
import { Modal } from './Modal'
import type { MapLayer, TableInfo } from './model'
import { effectiveType } from './columnTypes'
import { IconPicker } from './icons'

/** Geo-Spalten aller Tabellen: Aus ihnen speisen sich die Objekte einer Karte. */
export const geoLayers = (tables: TableInfo[]): (MapLayer & { label: string })[] =>
  tables.flatMap((t) => t.columns.filter((c) => effectiveType(c, tables) === 'geo').map((c) => ({ table: t.id, col: c.id, label: `${t.name} · ${c.name}` })))

/** Karte anlegen oder bearbeiten: Name und welche Geo-Spalten (Tabellen) auf der Karte erscheinen. */
export function MapDialog(props: {
  tables: TableInfo[]
  initial?: { name: string; layers: MapLayer[]; icon?: string }
  onSubmit: (name: string, layers: MapLayer[], icon: string) => void
  onClose: () => void
  onDelete?: () => void
}) {
  const available = geoLayers(props.tables)
  const key = (l: MapLayer) => `${l.table}|${l.col}`
  const [name, setName] = useState(props.initial?.name ?? 'Karte')
  const [icon, setIcon] = useState(props.initial?.icon ?? '')
  const [on, setOn] = useState(() => new Set((props.initial ? props.initial.layers : available).map(key)))
  const toggle = (l: MapLayer) => setOn((s) => { const n = new Set(s); n.has(key(l)) ? n.delete(key(l)) : n.add(key(l)); return n })
  const submit = () => { if (name.trim()) props.onSubmit(name.trim(), available.filter((l) => on.has(key(l))).map(({ table, col }) => ({ table, col })), icon) }

  return (
    <Modal onClose={props.onClose}>
      <form className="dialog mapdialog" onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); submit() }} onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>{props.initial ? 'Karte bearbeiten' : 'Neue Karte'}</h3>
        <label>Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
        <IconPicker value={icon} kind="map" onChange={setIcon} />
        <fieldset className="map-layers">
          <legend>Angezeigte Objekte</legend>
          {available.length === 0 && <p className="hint">Noch keine Tabelle hat eine Spalte vom Typ Geokoordinaten. Die Karte kann trotzdem eigene Punkte, Strecken und Gebiete enthalten.</p>}
          {available.map((l) => (
            <label key={key(l)} className="check"><input type="checkbox" checked={on.has(key(l))} onChange={() => toggle(l)} /> {l.label}</label>
          ))}
        </fieldset>
        <div className="actions split">
          {props.onDelete ? <button type="button" className="danger-outline" onClick={props.onDelete}>Löschen …</button> : <span />}
          <span className="actions-right">
            <button type="button" onClick={props.onClose}>Abbrechen</button>
            <button type="submit" className="primary" disabled={!name.trim()}>{props.initial ? 'Speichern' : 'Anlegen'}</button>
          </span>
        </div>
      </form>
    </Modal>
  )
}
