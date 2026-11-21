import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { editText, formatDate, isoDate, parseDateInput, type DateStyle } from './dateFormat'

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleDateString('de-DE', { month: 'long' }))
const POPUP_W = 288
const POPUP_H = 372

const pad = (n: number) => String(n).padStart(2, '0')
const keyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const parseKey = (k: string) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d) }

/**
 * Datumsfeld: zeigt das Datum formatiert, ein Klick öffnet Texteingabe und Kalender. Getippt wird in üblichen
 * Schreibweisen (`17.11.`, `171126`, `heute` …, siehe parseDateInput); gespeichert wird nur, was ein echtes Datum ist.
 * Tippt man bei fokussiertem Feld sofort Ziffern, öffnet sich die Eingabe mit diesen Ziffern.
 */
export function DatePicker(props: {
  value: unknown
  withTime: boolean
  style: DateStyle
  onChange: (value: string | null) => void
  className?: string
  placeholder?: string
  autoFocus?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [seed, setSeed] = useState<string | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const shown = formatDate(props.value, props.style, props.withTime)
  const close = () => { setOpen(false); setSeed(null); btn.current?.focus({ preventScroll: true }) }
  useEffect(() => { if (props.autoFocus) btn.current?.focus() }, [])
  return (
    <>
      <button ref={btn} type="button" className={props.className} aria-haspopup="dialog" aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (open) return
          if (/^[0-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); setSeed(e.key); setOpen(true) }
          else if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true) }
          else if ((e.key === 'Backspace' || e.key === 'Delete') && props.value) { e.preventDefault(); props.onChange(null) }
        }}>
        {shown || <span className="placeholder">{props.placeholder}</span>}
      </button>
      {open && (
        <DatePopup anchor={btn.current!} value={props.value} withTime={props.withTime} seed={seed}
          onPick={(v) => { props.onChange(v); close() }} onClose={close} />
      )}
    </>
  )
}

function DatePopup(props: { anchor: HTMLElement; value: unknown; withTime: boolean; seed: string | null; onPick: (v: string | null) => void; onClose: () => void }) {
  const { withTime } = props
  const today = new Date()
  const stored = typeof props.value === 'string' ? parseDateInput(editText(props.value, withTime)) : null
  const [text, setText] = useState(props.seed ?? editText(props.value, withTime))
  const parsed = text.trim() === '' ? null : parseDateInput(text)
  const [tried, setTried] = useState(false) // erst nach Enter als Fehler anzeigen, nicht schon beim Tippen
  const invalid = tried && text.trim() !== '' && !parsed
  const [view, setView] = useState(() => { const d = parseKey((stored?.date ?? keyOf(today))); return { y: d.getFullYear(), m: d.getMonth() } })
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  const time = (parsed?.time ?? stored?.time ?? '00:00')
  const result = (date: string, t: string | null) => (withTime ? `${date}T${t ?? time}` : date)

  // Ort: unter dem Feld, bei Platzmangel darüber; nie aus dem Fenster heraus
  useLayoutEffect(() => {
    const r = props.anchor.getBoundingClientRect()
    const below = r.bottom + 4 + POPUP_H <= window.innerHeight
    const top = below ? r.bottom + 4 : Math.max(8, r.top - POPUP_H - 4)
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - POPUP_W - 8)), top })
  }, [props.anchor])
  // erst fokussieren, wenn das Feld sichtbar ist (unsichtbare Elemente nehmen keinen Fokus an)
  const placed = pos !== null
  useEffect(() => { if (!placed) return; input.current?.focus(); if (props.seed === null) input.current?.select() }, [placed])

  // Der Kalender folgt dem, was getippt wird
  useEffect(() => { if (parsed) { const d = parseKey(parsed.date); setView({ y: d.getFullYear(), m: d.getMonth() }) } }, [parsed?.date])

  // Klick daneben: gültige, geänderte Eingabe übernehmen, sonst verwerfen
  const latest = useRef({ parsed, text, value: props.value })
  latest.current = { parsed, text, value: props.value }
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (box.current?.contains(e.target as Node) || props.anchor.contains(e.target as Node)) return
      const { parsed: p } = latest.current
      if (p) { const v = result(p.date, p.time); if (v !== latest.current.value) { props.onPick(v); return } }
      props.onClose()
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [])

  const shift = (days: number) => {
    const base = parsed ? parseKey(parsed.date) : today
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + days)
    setText(editText(withTime ? `${keyOf(d)}T${time}` : keyOf(d), withTime))
  }
  const moveMonth = (delta: number) => setView(({ y, m }) => { const d = new Date(y, m + delta, 1); return { y: d.getFullYear(), m: d.getMonth() } })
  const onKey = (e: ReactKeyboardEvent) => {
    // Der Dialog dahinter (Formular) soll Enter/Escape nicht mitbekommen
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); props.onClose() }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (parsed) props.onPick(result(parsed.date, parsed.time)); else if (!text.trim()) props.onPick(null); else setTried(true) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); shift(e.shiftKey ? -7 : -1) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); shift(e.shiftKey ? 7 : 1) }
    else if (e.key === 'PageUp') { e.preventDefault(); moveMonth(-1) }
    else if (e.key === 'PageDown') { e.preventDefault(); moveMonth(1) }
  }

  // 6 Wochen ab dem Montag vor dem Ersten des Monats
  const first = new Date(view.y, view.m, 1)
  const start = new Date(view.y, view.m, 1 - ((first.getDay() + 6) % 7))
  const days = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
  const selected = parsed?.date ?? stored?.date ?? null
  const todayKey = keyOf(today)

  return createPortal(
    <div ref={box} className="datepop" role="dialog" aria-label="Datum wählen" style={pos ? { left: pos.left, top: pos.top, width: POPUP_W } : { visibility: 'hidden' }}
      onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
      <input ref={input} className={`datepop-text${invalid ? ' invalid' : ''}`} value={text} placeholder={withTime ? 'TT.MM.JJJJ SS:MM' : 'TT.MM.JJJJ'}
        aria-invalid={invalid} aria-label="Datum eingeben" onChange={(e) => { setText(e.target.value); setTried(false) }} />
      <small className={`datepop-hint${invalid ? ' invalid' : ''}`}>
        {invalid ? 'Kein gültiges Datum' : parsed ? formatDate(`${parsed.date}${parsed.time ? `T${parsed.time}` : ''}`, 'weekday', withTime) : 'z. B. 17.11. · 171126 · heute'}
      </small>
      <div className="datepop-nav">
        <button type="button" aria-label="Vorheriger Monat" onClick={() => moveMonth(-1)}>‹</button>
        <select aria-label="Monat" value={view.m} onChange={(e) => setView((v) => ({ ...v, m: Number(e.target.value) }))}>
          {MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}
        </select>
        <input className="datepop-year" type="number" aria-label="Jahr" value={view.y} min={1000} max={9999}
          onChange={(e) => { const y = Number(e.target.value); if (isoDate(y, 1, 1)) setView((v) => ({ ...v, y })) }} />
        <button type="button" aria-label="Nächster Monat" onClick={() => moveMonth(1)}>›</button>
      </div>
      <div className="datepop-grid">
        {WEEKDAYS.map((w) => <span key={w} className="wd">{w}</span>)}
        {days.map((d) => {
          const k = keyOf(d)
          return (
            <button key={k} type="button" tabIndex={-1} className={`day${d.getMonth() !== view.m ? ' other' : ''}${k === todayKey ? ' today' : ''}${k === selected ? ' on' : ''}`}
              onClick={() => props.onPick(result(k, null))}>{d.getDate()}</button>
          )
        })}
      </div>
      <div className="datepop-actions">
        <button type="button" onClick={() => props.onPick(null)} disabled={!props.value}>Löschen</button>
        <button type="button" onClick={() => props.onPick(result(todayKey, null))}>Heute</button>
      </div>
    </div>,
    document.body,
  )
}
