import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as Y from 'yjs'
import 'leaflet/dist/leaflet.css'
import { readTables, setCell, type ColumnInfo } from './model'
import { startTracking, stopTracking, useTracking } from './tracking'
import { GEO } from './columnTypes'
import { GEO_FORMATS, decodeGeo, encodeGeo, formatGeo, parseGeo, tilesAround, type GeoFormat, type LatLon } from './geo'
import { Modal } from './Modal'
import { addBaseMap } from './baseMap'
import { useCell } from './useTables'
import { TileContent, useReprs } from './ReprTile'
import type { Repr } from './repr'

const MAP_W = 200, MAP_H = 96, MAP_ZOOM = 14

/** Kleine, feste Karte um den Punkt (nur Kacheln, keine Bedienung). Fehlt die Verbindung, bleiben Hintergrund und Markierung. */
function MiniMap({ point, repr }: { point: LatLon; repr?: Repr }) {
  const [failed, setFailed] = useState(0)
  const tiles = tilesAround(point, MAP_ZOOM, MAP_W, MAP_H)
  return (
    <span className="minimap" style={{ width: MAP_W, height: MAP_H }} title={formatGeo(point, 'dd')}>
      {tiles.map((t) => (
        <img key={t.src} src={t.src} alt="" draggable={false} style={{ left: t.left, top: t.top }} onError={() => setFailed((n) => n + 1)} />
      ))}
      {repr
        ? <div className="geo-tag-host compact"><div className="geo-tag"><div className="tile rich-avatar"><TileContent repr={repr} /></div><i className="geo-tag-arrow" /></div></div>
        : <i className="geo-pin"><span /></i>}
      {failed > 0 && <small>{formatGeo(point, 'dd')}</small>}
    </span>
  )
}

export function GeoCell(props: { doc: Y.Doc; tableId: string; rowId: string; col: ColumnInfo }) {
  const { doc, tableId, rowId, col } = props
  const point = decodeGeo(useCell(doc, tableId, rowId, col.id))
  const format = GEO.config(col).format
  const repr = useReprs()(tableId)?.get(rowId) // so erscheint die Zeile auf der Karte
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)
  useEffect(() => { // nach dem Schließen zurück auf die Zelle (Tab geht weiter)
    if (!open && wasOpen.current) btn.current?.focus()
    wasOpen.current = open
  }, [open])
  return (
    <div className="c geocell">
      <button ref={btn} type="button" className={`cell-geo${format === 'map' && point ? ' with-map' : ''}`} title={col.name} onClick={() => setOpen(true)}>
        {!point ? <span className="select-empty">Position wählen …</span>
          : format === 'map' ? <MiniMap point={point} repr={repr} />
          : <span className="geo-text">{formatGeo(point, format)}</span>}
      </button>
      {open && (
        <GeoDialog doc={doc} tableId={tableId} rowId={rowId} colId={col.id} tableName={readTables(doc).find((t) => t.id === tableId)?.name ?? ''} rowLabel={repr?.title || 'Zeile'} title={col.name} initial={point} format={format} repr={repr}
          onSave={(p) => { setCell(doc, tableId, rowId, col.id, p ? encodeGeo(p) : null); setOpen(false) }}
          onClose={() => setOpen(false)} />
      )}
    </div>
  )
}

const normLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180
const round7 = (p: LatLon): LatLon => ({ lat: Math.round(p.lat * 1e7) / 1e7, lon: Math.round(p.lon * 1e7) / 1e7 })

/** Position auf einer Karte ansehen und ändern (klicken oder Markierung ziehen) oder in einem der Formate eintippen. */
function GeoDialog(props: { doc: Y.Doc; tableId: string; rowId: string; colId: string; tableName: string; rowLabel: string; title: string; initial: LatLon | null; format: GeoFormat; repr?: Repr; onSave: (p: LatLon | null) => void; onClose: () => void }) {
  const [inputFormat, setInputFormat] = useState<Exclude<GeoFormat, 'map'>>(props.format === 'map' ? 'dd' : props.format)
  const [pos, setPos] = useState<LatLon | null>(props.initial)
  const [text, setText] = useState(props.initial ? formatGeo(props.initial, inputFormat) : '')
  const [error, setError] = useState<string | null>(null)
  const mapEl = useRef<HTMLDivElement>(null)
  const leaflet = useRef<{ L: any; map: any; marker: any } | null>(null)
  // Die Darstellung der Zeile (Avatar, Titel, Untertitel) steht als Schild über der Markierung; die Spitze zeigt auf den Punkt.
  const [tagHost, setTagHost] = useState<HTMLElement | null>(null)
  const repr = props.repr
  const reprRef = useRef(repr)
  reprRef.current = repr
  /** Markierung auf die Karte setzen (falls noch nicht dort) und das Schild daran hängen. */
  const placeMarker = () => {
    const l = leaflet.current
    if (!l) return
    if (!l.map.hasLayer(l.marker)) l.marker.addTo(l.map)
    const el: HTMLElement | undefined = l.marker.getElement()
    if (!el || !reprRef.current) return
    let host = el.querySelector<HTMLElement>('.geo-tag-host')
    if (!host) { host = document.createElement('div'); host.className = 'geo-tag-host'; el.appendChild(host) }
    setTagHost(host)
  }

  /** Markierung und Kartenausschnitt auf den Punkt setzen. */
  const showOnMap = (p: LatLon) => {
    const l = leaflet.current
    if (!l) return
    l.marker.setLatLng([p.lat, p.lon])
    placeMarker()
    l.map.panTo([p.lat, p.lon])
  }
  const fromMap = (ll: { lat: number; lng: number }) => {
    const p = round7({ lat: Math.max(-90, Math.min(90, ll.lat)), lon: normLon(ll.lng) })
    setPos(p); setText(formatGeo(p, inputFormat)); setError(null)
    leaflet.current?.marker.setLatLng([p.lat, p.lon])
    placeMarker()
  }
  const fromMapRef = useRef(fromMap)
  fromMapRef.current = fromMap

  useEffect(() => {
    let alive = true
    let map: any
    ;(async () => {
      const L = (await import('leaflet')).default
      if (!alive || !mapEl.current) return
      const start = props.initial
      map = L.map(mapEl.current).setView(start ? [start.lat, start.lon] : [51.1657, 10.4515], start ? 15 : 5)
      await addBaseMap(L, map)
      if (!alive) return
      const icon = reprRef.current
        ? L.divIcon({ className: 'geo-tag-wrap', html: '', iconSize: [0, 0], iconAnchor: [0, 0] })
        : L.divIcon({ className: 'geo-pin-wrap', html: '<i class="geo-pin"><span></span></i>', iconSize: [28, 28], iconAnchor: [14, 28] })
      const marker = L.marker(start ? [start.lat, start.lon] : [0, 0], { draggable: true, icon })
      map.on('click', (e: any) => fromMapRef.current(e.latlng))
      marker.on('dragend', () => fromMapRef.current(marker.getLatLng()))
      leaflet.current = { L, map, marker }
      if (start) placeMarker()
      setTimeout(() => map.invalidateSize(), 50)
    })()
    return () => { alive = false; map?.remove(); leaflet.current = null }
  }, [])

  const onText = (v: string) => {
    setText(v)
    const r = parseGeo(v, inputFormat === 'lonlat' ? 'lonlat' : 'latlon')
    if (r.ok) { setPos(r.point); setError(null); showOnMap(r.point) } else setError(r.error)
  }
  const changeFormat = (f: Exclude<GeoFormat, 'map'>) => {
    setInputFormat(f)
    if (pos) setText(formatGeo(pos, f))
    setError(null)
  }
  const example = GEO_FORMATS.find((f) => f.id === inputFormat)?.example

  // Aktueller Standort des Geräts: einmal übernehmen oder die Zelle dauerhaft nachführen (siehe tracking.ts).
  const [locating, setLocating] = useState(false)
  const [locError, setLocError] = useState<string | null>(null)
  const tracking = useTracking()
  const trackedHere = !!tracking && tracking.target.doc === props.doc && tracking.target.tableId === props.tableId && tracking.target.rowId === props.rowId && tracking.target.colId === props.colId
  const locate = () => {
    setLocError(null)
    if (!navigator.geolocation) { setLocError('Dieses Gerät kann den Standort nicht ermitteln.'); return }
    setLocating(true)
    navigator.geolocation.getCurrentPosition((g) => {
      const p = round7({ lat: g.coords.latitude, lon: g.coords.longitude })
      setPos(p); setText(formatGeo(p, inputFormat)); setError(null); showOnMap(p); setLocating(false)
    }, (e) => {
      setLocating(false)
      setLocError(e.code === e.PERMISSION_DENIED ? 'Der Zugriff auf den Standort ist nicht erlaubt (Einstellungen des Geräts).' : 'Der Standort konnte nicht ermittelt werden.')
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 })
  }
  const track = () => {
    try {
      startTracking({ doc: props.doc, tableId: props.tableId, rowId: props.rowId, colId: props.colId, tableName: props.tableName, colName: props.title, rowLabel: props.rowLabel })
      props.onClose()
    } catch (e) { setLocError((e as Error).message) }
  }

  return (
    <Modal onClose={props.onClose}>
      <form className="dialog geodialog" onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (pos && !error) props.onSave(pos) }}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>{props.title}</h3>
        <div ref={mapEl} className="geomap" />
        {tagHost && repr && createPortal(
          <div className="geo-tag"><div className="tile"><TileContent repr={repr} /></div><i className="geo-tag-arrow" /></div>, tagHost)}
        <p className="hint">Auf die Karte klicken oder die Markierung ziehen. Mit den Tasten + und − lässt sich zoomen.</p>
        <div className="geo-inputs">
          <select value={inputFormat} aria-label="Format" onChange={(e) => changeFormat(e.target.value as Exclude<GeoFormat, 'map'>)}>
            {GEO_FORMATS.filter((f) => f.id !== 'map').map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
          <input autoFocus value={text} placeholder={example} spellCheck={false} aria-label="Koordinaten" onChange={(e) => onText(e.target.value)} />
        </div>
        {error && <p className="formula-error" role="alert">{error}</p>}
        <div className="geo-locate">
          <button type="button" disabled={locating} onClick={locate}>◎ Aktueller Standort</button>
          {trackedHere
            ? <button type="button" onClick={() => stopTracking()}>GPS-Tracking beenden</button>
            : <button type="button" onClick={track} title="Die Zelle folgt dem Gerät, bis du es beendest – auch wenn dieser Dialog geschlossen ist.">Dauerhaft verfolgen</button>}
        </div>
        {locError && <p className="formula-error" role="alert">{locError}</p>}
        <div className="actions split">
          {props.initial
            ? <button type="button" className="danger-outline" onClick={() => props.onSave(null)}>Position entfernen</button>
            : <span />}
          <span className="actions-right">
            <button type="button" onClick={props.onClose}>Abbrechen</button>
            <button type="submit" className="primary" disabled={!pos || !!error}>Übernehmen</button>
          </span>
        </div>
      </form>
    </Modal>
  )
}
