import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as Y from 'yjs'
import 'leaflet/dist/leaflet.css'
import { deleteMapShape, getCell, setCell, setMapShape, uid, type MapInfo, type MapShape, type TableInfo } from './model'
import { decodeGeo, encodeGeo } from './geo'
import { addBaseMap } from './baseMap'
import { newCtx } from './cells'
import { reprMap, type Repr } from './repr'
import { TileContent } from './ReprTile'
import { useFileIndex, useLinkIndex } from './useTables'
import { glide, type Tag } from './markerGlide'
import { formatArea, formatLength, pathLength, ringArea, type Pt } from './mapGeometry'
import { t } from './i18n'
import { useRights } from './rights'

type Mode = 'select' | 'point' | 'line' | 'area'
/** Marker einer Zeile: dazu ein laufendes Ausblenden (Zeitgeber) und die zuletzt gezeigte Darstellung, die während des Ausblendens stehen bleibt */
type LiveTag = Tag & { leaving: number | null; repr?: Repr }
/** Dauer des Ein- und Ausblendens in Millisekunden (siehe .geo-tag-host.appearing/.leaving in styles.css) */
const FADE_MS = 500
const calmMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const COLORS = ['#0a84ff', '#34c759', '#ff3b30', '#ff9500', '#af52de', '#5856d6', '#8e8e93', '#1c1c1e']
const kindLabel = (k: 'point' | 'line' | 'area') => ({ point: t('Punkt'), line: t('Strecke'), area: t('Gebiet') })[k]
const MIN_POINTS = { line: 2, area: 3 } as const
const r7 = (n: number) => Math.round(n * 1e7) / 1e7
const normLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/**
 * Kartenseite: zeigt die Zeilen der gewählten Geo-Spalten (mit ihrer Darstellung) und eigene Objekte –
 * Punkte, Strecken und Gebiete –, die im Dokument an der Karte gespeichert sind.
 */
export function MapView(props: { doc: Y.Doc; map: MapInfo; tables: TableInfo[]; onOpenRecord: (tableId: string, rowId: string) => void }) {
  const { doc, map, tables } = props
  const rights = useRights()
  const rightsRef = useRef(rights)
  rightsRef.current = rights
  const mapWrite = rights.access(map.id) === 'write' // Objekte der Karte zeichnen und ändern
  const mapWriteRef = useRef(mapWrite)
  mapWriteRef.current = mapWrite
  const index = useLinkIndex(doc)
  const fileIndex = useFileIndex(doc)
  const el = useRef<HTMLDivElement>(null)
  const lf = useRef<{ L: any; map: any; data: any; shapes: any; draft: any } | null>(null)
  const [ready, setReady] = useState(false)
  const [mode, setMode] = useState<Mode>('select')
  const [draft, setDraft] = useState<Pt[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  /** Marker der Zeilen auf der Karte (Schlüssel: Tabelle|Zeile|Spalte) samt laufender Bewegung */
  const tags = useRef(new Map<string, LiveTag>())
  const firstFill = useRef(true) // beim ersten Füllen der Karte erscheinen die Marker ohne Animation
  const [hosts, setHosts] = useState<{ key: string; el: HTMLElement; repr?: Repr }[]>([])
  const live = useRef({ mode, draft, map, selected })
  live.current = { mode, draft, map, selected }
  const openRef = useRef(props.onOpenRecord)
  openRef.current = props.onOpenRecord

  const nextColor = () => COLORS[map.shapes.length % COLORS.length]
  const reprs = useMemo(() => {
    const ctx = newCtx()
    const m = new Map<string, Map<string, Repr>>()
    for (const t of tables) if (map.layers.some((l) => l.table === t.id)) m.set(t.id, reprMap(doc, tables, t, ctx))
    return m
    // Verknüpfungen und Bilder gehören zur Darstellung (Titel aus Relationen, Avatar)
  }, [doc, tables, map.layers, index, fileIndex])

  /** Alle Positionen (Zeilen der Ebenen und eigene Objekte), z. B. für den ersten Kartenausschnitt. */
  const allPoints = (): Pt[] => {
    const out: Pt[] = []
    for (const l of map.layers) {
      const t = tables.find((x) => x.id === l.table)
      if (t) for (const rid of t.rowIds) { const p = decodeGeo(getCell(doc, t.id, rid, l.col)); if (p) out.push([p.lat, p.lon]) }
    }
    for (const { shape } of map.shapes) shape.kind === 'point' ? out.push([shape.lat, shape.lon]) : out.push(...shape.pts)
    return out
  }

  // ---------- Zeichnen ----------
  const clickRef = useRef<(ll: { lat: number; lng: number }) => void>(() => {})
  clickRef.current = (ll) => {
    const { mode, draft } = live.current
    const p: Pt = [r7(Math.max(-90, Math.min(90, ll.lat))), r7(normLon(ll.lng))]
    if (mode === 'select') setSelected(null)
    else if (mode === 'point') {
      const id = uid()
      setMapShape(doc, map.id, id, { kind: 'point', lat: p[0], lon: p[1], label: '', color: nextColor() })
      setSelected(id); setMode('select')
    } else setDraft([...draft, p])
  }
  const finishRef = useRef<(dbl: boolean) => void>(() => {})
  finishRef.current = (dbl) => {
    const { mode, draft } = live.current
    if (mode !== 'line' && mode !== 'area') return
    // Ein Doppelklick liefert zuvor zwei Einzelklicks: der letzte Punkt ist überzählig
    let pts = dbl ? draft.slice(0, -1) : draft
    pts = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1])
    if (pts.length >= MIN_POINTS[mode]) {
      const id = uid()
      setMapShape(doc, map.id, id, { kind: mode, pts, label: '', color: nextColor() })
      setSelected(id)
    }
    setDraft([]); setMode('select')
  }
  const choose = (m: Mode) => { setMode(m); setDraft([]); if (m !== 'select') setSelected(null) }
  const cancelDraw = () => { setDraft([]); setMode('select') }
  const removeShape = (id: string) => { deleteMapShape(doc, map.id, id); setSelected(null) }

  // ---------- Leaflet ----------
  useEffect(() => {
    let alive = true
    let m: any
    ;(async () => {
      const L = (await import('leaflet')).default
      if (!alive || !el.current) return
      m = L.map(el.current).setView([51.1657, 10.4515], 6)
      await addBaseMap(L, m)
      if (!alive) return
      lf.current = { L, map: m, data: L.layerGroup().addTo(m), shapes: L.layerGroup().addTo(m), draft: L.layerGroup().addTo(m) }
      m.on('click', (e: any) => clickRef.current(e.latlng))
      m.on('dblclick', () => finishRef.current(true))
      setReady(true)
      setTimeout(() => m.invalidateSize(), 50)
    })()
    return () => { alive = false; for (const t of tags.current.values()) { cancelAnimationFrame(t.anim); if (t.leaving !== null) clearTimeout(t.leaving) } tags.current.clear(); m?.remove(); lf.current = null }
  }, [])

  // Erster Ausschnitt: alles, was auf der Karte liegt
  useEffect(() => {
    const g = lf.current
    if (!ready || !g) return
    const pts = allPoints()
    if (pts.length === 1) g.map.setView(pts[0], 15)
    else if (pts.length > 1) g.map.fitBounds(g.L.latLngBounds(pts).pad(0.2))
  }, [ready])

  useEffect(() => {
    const g = lf.current
    if (!ready || !g) return
    g.map.doubleClickZoom[mode === 'line' || mode === 'area' ? 'disable' : 'enable']()
    g.map.getContainer().style.cursor = mode === 'select' ? '' : 'crosshair'
  }, [ready, mode])

  // Zeilen der gewählten Geo-Spalten, jeweils mit ihrer Darstellung.
  // Die Marker bleiben bestehen und werden nur nachgeführt: Ändert sich eine Position (z. B. weil jemand anderes das Objekt
  // verschoben hat), gleitet der Marker in einer Sekunde dorthin.
  useEffect(() => {
    const g = lf.current
    if (!ready || !g) return
    const seen = new Set<string>()
    const next: { key: string; el: HTMLElement; repr?: Repr }[] = []
    for (const layer of map.layers) {
      const t = tables.find((x) => x.id === layer.table)
      if (!t || !t.columns.some((c) => c.id === layer.col)) continue
      for (const rid of t.rowIds) {
        const p = decodeGeo(getCell(doc, t.id, rid, layer.col))
        if (!p) continue
        const key = `${t.id}|${rid}|${layer.col}`
        let tag = tags.current.get(key)
        if (tag) {
          if (tag.leaving !== null) { clearTimeout(tag.leaving); tag.leaving = null; tag.host.classList.remove('leaving') } // kommt zurück, bevor es ausgeblendet war
          glide(tag, p.lat, p.lon)
        } else {
          const marker = g.L.marker([p.lat, p.lon], { keyboard: false, icon: g.L.divIcon({ className: 'geo-tag-wrap', html: '', iconSize: [0, 0], iconAnchor: [0, 0] }) }).addTo(g.data)
          let moved = false
          marker.on('click', (e: any) => {
            if (moved) { moved = false; return }
            // Öffnen nur über das Label (oder den Pin ohne Label); alles darunter ist zum Ziehen da
            const hit = (e.originalEvent?.target as HTMLElement | null)?.closest('.tile, .geo-pin')
            if (hit && live.current.mode === 'select') openRef.current(t.id, rid)
          })
          const icon: HTMLElement | undefined = marker.getElement()
          if (!icon) continue
          const host = document.createElement('div')
          host.className = 'geo-tag-host'
          icon.appendChild(host)
          tag = { marker, host, anim: 0, target: { lat: p.lat, lng: p.lon }, leaving: null }
          tags.current.set(key, tag)
          if (!firstFill.current && !calmMotion()) { // neu dazugekommen: einblenden und von klein auf groß wachsen
            host.classList.add('appearing')
            const done = () => host.classList.remove('appearing')
            host.addEventListener('animationend', done, { once: true })
            setTimeout(done, FADE_MS + 150) // falls der Browser die Animation nicht abspielt (z. B. verdeckter Tab): Marker trotzdem zeigen
          }
          // Verschieben: die Spitze (Pfeil bzw. Punkt) ziehen und loslassen; ein Klick auf die Kachel öffnet weiter das Formular
          // Leaflet schwenkt die Karte bei mousedown/touchstart: dort darf die Spitze nicht durchgereicht werden
          const onTip = (e: Event) => !(e.target as HTMLElement).closest('.tile') && live.current.mode === 'select' && rightsRef.current.access(t.id) === 'write'
          for (const type of ['mousedown', 'touchstart']) host.addEventListener(type, (e) => { if (onTip(e)) e.stopPropagation() })
          host.addEventListener('pointerdown', (e: PointerEvent) => {
            if (e.button !== 0 || !onTip(e)) return
            e.stopPropagation()
            const map = g.map
            const self = tags.current.get(key)
            if (self) { cancelAnimationFrame(self.anim); self.anim = 0 } // wer greift, hält das Objekt an
            const start = map.mouseEventToContainerPoint(e)
            const origin = map.latLngToContainerPoint(marker.getLatLng())
            let target = marker.getLatLng()
            moved = false
            const move = (ev: PointerEvent) => {
              const q = map.mouseEventToContainerPoint(ev)
              if (!moved && Math.hypot(q.x - start.x, q.y - start.y) < 4) return
              moved = true
              host.classList.add('dragging')
              target = map.containerPointToLatLng([origin.x + q.x - start.x, origin.y + q.y - start.y])
              marker.setLatLng(target)
            }
            const up = () => {
              window.removeEventListener('pointermove', move)
              window.removeEventListener('pointerup', up)
              host.classList.remove('dragging')
              if (moved) {
                const lon = ((target.lng + 540) % 360) - 180
                if (self) self.target = { lat: target.lat, lng: lon } // eigene Bewegung: der Marker steht schon dort
                setCell(doc, t.id, rid, layer.col, encodeGeo({ lat: target.lat, lon }))
              }
            }
            window.addEventListener('pointermove', move)
            window.addEventListener('pointerup', up)
          })
        }
        seen.add(key)
        tag.repr = reprs.get(t.id)?.get(rid)
        next.push({ key, el: tag.host, repr: tag.repr })
      }
    }
    for (const [key, tag] of tags.current) {
      if (seen.has(key)) continue
      cancelAnimationFrame(tag.anim)
      tag.anim = 0
      if (tag.leaving === null) {
        const remove = () => { g.data.removeLayer(tag.marker); tags.current.delete(key); setHosts((h) => h.filter((x) => x.key !== key)) }
        if (calmMotion()) { remove(); continue }
        tag.host.classList.remove('appearing')
        tag.host.classList.add('leaving') // ausblenden; der Marker verschwindet danach
        tag.leaving = window.setTimeout(remove, FADE_MS)
      }
      next.push({ key, el: tag.host, repr: tag.repr }) // die Kachel bleibt während des Ausblendens stehen
    }
    firstFill.current = false
    setHosts(next)
  }, [ready, tables, map.layers, reprs])

  // Eigene Objekte
  useEffect(() => {
    const g = lf.current
    if (!ready || !g) return
    const { L } = g
    g.shapes.clearLayers()
    const interactive = mode === 'select'
    for (const { id, shape } of map.shapes) {
      const sel = id === selected
      const pick = () => { if (live.current.mode === 'select') setSelected(id) }
      if (shape.kind === 'point') {
        const icon = L.divIcon({
          className: 'mapmark-wrap', iconSize: [0, 0], iconAnchor: [0, 0],
          html: `<div class="mapmark${sel ? ' sel' : ''}" style="--c:${shape.color}"><i class="geo-pin"><span></span></i>${shape.label ? `<b>${esc(shape.label)}</b>` : ''}</div>`,
        })
        const m = L.marker([shape.lat, shape.lon], { icon, draggable: sel && mapWriteRef.current, interactive, keyboard: false }).addTo(g.shapes)
        m.on('click', pick)
        m.on('dragend', () => { const ll = m.getLatLng(); setMapShape(doc, map.id, id, { ...shape, lat: r7(ll.lat), lon: r7(normLon(ll.lng)) }) })
        continue
      }
      const style = { color: shape.color, weight: sel ? 5 : 4, fillOpacity: 0.2, interactive, bubblingMouseEvents: false }
      const layer = (shape.kind === 'line' ? L.polyline(shape.pts, style) : L.polygon(shape.pts, style)).addTo(g.shapes)
      layer.on('click', pick)
      if (shape.label) layer.bindTooltip(shape.label, { permanent: true, direction: 'center', className: 'map-label', interactive: false })
      if (!sel || !mapWriteRef.current) continue
      // Eckpunkte ziehen; die Mitte einer Kante ziehen fügt einen Punkt ein; Doppelklick auf einen Eckpunkt entfernt ihn
      const write = (pts: Pt[]) => setMapShape(doc, map.id, id, { ...shape, pts })
      const handle = (at: Pt, mid: boolean) =>
        L.marker(at, { draggable: true, keyboard: false, icon: L.divIcon({ className: 'vtx-wrap', html: `<i class="vtx${mid ? ' mid' : ''}"></i>`, iconSize: [14, 14], iconAnchor: [7, 7] }) }).addTo(g.shapes)
      const at = (h: any): Pt => [r7(h.getLatLng().lat), r7(normLon(h.getLatLng().lng))]
      shape.pts.forEach((pt, i) => {
        const h = handle(pt, false)
        h.on('drag', () => layer.setLatLngs(shape.pts.map((p, j) => (j === i ? [h.getLatLng().lat, h.getLatLng().lng] : p))))
        h.on('dragend', () => write(shape.pts.map((p, j) => (j === i ? at(h) : p))))
        h.on('dblclick', () => { if (shape.pts.length > MIN_POINTS[shape.kind]) write(shape.pts.filter((_, j) => j !== i)) })
      })
      const edges = shape.kind === 'area' ? shape.pts.length : shape.pts.length - 1
      for (let i = 0; i < edges; i++) {
        const a = shape.pts[i], b = shape.pts[(i + 1) % shape.pts.length]
        const h = handle([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], true)
        h.on('dragend', () => { const pts = [...shape.pts]; pts.splice(i + 1, 0, at(h)); write(pts) })
      }
    }
  }, [ready, map.shapes, selected, mode])

  // Linie bzw. Fläche, die gerade gezeichnet wird
  useEffect(() => {
    const g = lf.current
    if (!ready || !g) return
    g.draft.clearLayers()
    if (draft.length === 0 || (mode !== 'line' && mode !== 'area')) return
    const color = nextColor()
    const opts = { color, weight: 4, dashArray: '6 6', fillOpacity: 0.15, interactive: false }
    if (draft.length > 1) (mode === 'area' ? g.L.polygon(draft, opts) : g.L.polyline(draft, opts)).addTo(g.draft)
    for (const p of draft) g.L.circleMarker(p, { radius: 5, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1, interactive: false }).addTo(g.draft)
  }, [ready, draft, mode])

  // Tasten: Enter beendet, Escape bricht ab bzw. hebt die Auswahl auf, Entf löscht das gewählte Objekt
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('.backdrop')) return // ein Dialog ist offen
      const typing = (e.target as Element | null)?.closest('input, textarea, select, [contenteditable]')
      const { mode, selected } = live.current
      if (e.key === 'Enter' && (mode === 'line' || mode === 'area') && !typing) { e.preventDefault(); finishRef.current(false) }
      else if (e.key === 'Escape' && !typing) {
        if (mode !== 'select') cancelDraw(); else if (selected) setSelected(null)
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !typing && mapWriteRef.current) { e.preventDefault(); removeShape(selected) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const sel = map.shapes.find((s) => s.id === selected)
  const drawing = mode === 'line' || mode === 'area'
  const hint = mode === 'point' ? t('Auf die Karte klicken, um einen Punkt zu setzen.')
    : drawing ? t(mode === 'line' ? 'Klicken, um Punkte zu setzen ({n}). Doppelklick oder „Fertig“ beendet die Strecke.' : 'Klicken, um Punkte zu setzen ({n}). Doppelklick oder „Fertig“ beendet das Gebiet.', { n: draft.length })
    : null

  return (
    <div className="mapview">
      <div ref={el} className="mapview-map" />
      {hosts.map((h) => createPortal(
        h.repr
          ? <div className="geo-tag"><div className="tile"><TileContent repr={h.repr} /></div><i className="geo-tag-arrow" /></div>
          : <i className="geo-pin"><span /></i>, h.el, h.key))}
      {mapWrite && <div className="map-tools" role="toolbar" aria-label={t('Zeichenwerkzeuge')}>
        {([['select', t('Auswählen')], ['point', t('+ Punkt')], ['line', t('+ Strecke')], ['area', t('+ Gebiet')]] as const).map(([m, label]) => (
          <button key={m} type="button" className={mode === m ? 'on' : ''} onClick={() => choose(m)}>{label}</button>
        ))}
        {drawing && (
          <>
            <button type="button" className="primary" disabled={draft.length < MIN_POINTS[mode]} onClick={() => finishRef.current(false)}>{t('Fertig')}</button>
            <button type="button" onClick={cancelDraw}>{t('Abbrechen')}</button>
          </>
        )}
      </div>}
      {hint && <div className="map-hint">{hint}</div>}
      {sel && mapWrite && <ShapePanel key={sel.id} shape={sel.shape}
        onChange={(patch) => setMapShape(doc, map.id, sel.id, { ...sel.shape, ...patch } as MapShape)}
        onDelete={() => removeShape(sel.id)} onClose={() => setSelected(null)} />}
    </div>
  )
}

/** Eigenschaften des gewählten Objekts: Beschriftung, Farbe, Länge bzw. Fläche. */
function ShapePanel(props: { shape: MapShape; onChange: (patch: Partial<MapShape>) => void; onDelete: () => void; onClose: () => void }) {
  const { shape } = props
  const [label, setLabel] = useState(shape.label)
  const commit = () => { if (label !== shape.label) props.onChange({ label }) }
  const measure = shape.kind === 'line' ? t('Länge {n}', { n: formatLength(pathLength(shape.pts)) })
    : shape.kind === 'area' ? t('Fläche {a}, Umfang {u}', { a: formatArea(ringArea(shape.pts)), u: formatLength(pathLength([...shape.pts, shape.pts[0]])) }) : null
  return (
    <div className="map-panel" role="dialog" aria-label={kindLabel(shape.kind)}>
      <div className="map-panel-head"><b>{kindLabel(shape.kind)}</b><button type="button" aria-label={t('Schließen')} onClick={() => { commit(); props.onClose() }}>✕</button></div>
      <input value={label} placeholder={t('Beschriftung')} aria-label={t('Beschriftung')} onChange={(e) => setLabel(e.target.value)}
        onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { commit(); (e.target as HTMLElement).blur() } }} />
      <div className="map-colors" role="radiogroup" aria-label={t('Farbe')}>
        {COLORS.map((c) => (
          <button key={c} type="button" role="radio" aria-checked={shape.color === c} className={shape.color === c ? 'on' : ''}
            style={{ background: c }} aria-label={c} onClick={() => props.onChange({ color: c })} />
        ))}
      </div>
      {measure && <p className="hint">{measure}</p>}
      {shape.kind !== 'point' && <p className="hint">{t('Eckpunkte ziehen; Punkt in der Kantenmitte ziehen fügt einen ein; Doppelklick auf einen Eckpunkt entfernt ihn.')}</p>}
      {shape.kind === 'point' && <p className="hint">{t('Zum Verschieben die Markierung ziehen.')}</p>}
      <button type="button" className="danger-outline" onClick={props.onDelete}>{t('Löschen')}</button>
    </div>
  )
}
