import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { addOption, deleteOption, setCell, updateOption, OPTION_COLORS, type ColumnInfo, type SelectOption } from './model'
import { ConfirmDialog, Modal } from './Modal'
import { useCell } from './useTables'

/** Farben der Optionen: Hintergrund, Text, Punkt. Das Dokument speichert nur die Farb-ID. */
const PALETTE: Record<string, { bg: string; fg: string; dot: string }> = {
  sand: { bg: 'var(--opt-sand-bg)', fg: 'var(--opt-sand-fg)', dot: 'var(--opt-sand-dot)' },
  green: { bg: 'var(--opt-green-bg)', fg: 'var(--opt-green-fg)', dot: 'var(--opt-green-dot)' },
  blue: { bg: 'var(--opt-blue-bg)', fg: 'var(--opt-blue-fg)', dot: 'var(--opt-blue-dot)' },
  rose: { bg: 'var(--opt-rose-bg)', fg: 'var(--opt-rose-fg)', dot: 'var(--opt-rose-dot)' },
  violet: { bg: 'var(--opt-violet-bg)', fg: 'var(--opt-violet-fg)', dot: 'var(--opt-violet-dot)' },
  gray: { bg: 'var(--opt-gray-bg)', fg: 'var(--opt-gray-fg)', dot: 'var(--opt-gray-dot)' },
}
const paletteOf = (id: string) => PALETTE[id] ?? PALETTE.gray

export function Pill({ option }: { option: SelectOption }) {
  const p = paletteOf(option.color)
  return (
    <span className="pill" style={{ background: p.bg, color: p.fg }}>
      <i style={{ background: p.dot }} />
      {option.name}
    </span>
  )
}

function SelectPicker(props: {
  doc: Y.Doc
  tableId: string
  rowId: string
  col: ColumnInfo
  value: string | null
  onManage: () => void
  onClose: () => void
}) {
  const { doc, tableId, rowId, col } = props
  const options = col.options ?? []
  const [name, setName] = useState('')
  // Tastatur: Pfeil hoch/runter wählt einen Eintrag aus (Optionen, dann „Keine Auswahl“), Enter übernimmt ihn.
  const entries: (string | null)[] = [...options.map((o) => o.id), ...(props.value ? [null] : [])]
  const [active, setActive] = useState<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (active !== null) listRef.current?.querySelectorAll<HTMLElement>('.opt-row')[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])
  const move = (dir: 1 | -1) => {
    if (entries.length === 0) return
    setActive((a) => {
      if (a === null) { // Start: aktuelle Auswahl, sonst erster bzw. letzter Eintrag
        const cur = entries.indexOf(props.value)
        return props.value && cur >= 0 ? Math.min(Math.max(cur + dir, 0), entries.length - 1) : dir === 1 ? 0 : entries.length - 1
      }
      return Math.min(Math.max(a + dir, 0), entries.length - 1)
    })
  }
  const choose = (id: string | null) => { setCell(doc, tableId, rowId, col.id, id); props.onClose() }
  const create = () => {
    const n = name.trim()
    if (!n) return
    const existing = options.find((o) => o.name.toLowerCase() === n.toLowerCase())
    choose(existing ? existing.id : addOption(doc, tableId, col.id, n))
  }
  return (
    <Modal onClose={props.onClose}>
      <div className="dialog selectpicker" onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') props.onClose()
          else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(e.key === 'ArrowDown' ? 1 : -1) }
        }}>
        <h3>{col.name}</h3>
        <div className="opt-list" ref={listRef}>
          {options.map((o, i) => (
            <button key={o.id} type="button" className={`opt-row ${o.id === props.value ? 'on' : ''} ${active === i ? 'active' : ''}`}
              onClick={() => choose(o.id)} onMouseMove={() => setActive(i)}>
              <Pill option={o} />
              {o.id === props.value && <span className="check">✓</span>}
            </button>
          ))}
          {options.length === 0 && <p className="hint">Noch keine Optionen. Lege unten eine an.</p>}
          {props.value && (
            <button type="button" className={`opt-row clear ${active === options.length ? 'active' : ''}`}
              onClick={() => choose(null)} onMouseMove={() => setActive(options.length)}>Keine Auswahl</button>
          )}
        </div>
        <form className="opt-new" onSubmit={(e) => { e.preventDefault(); create() }}>
          <input autoFocus placeholder="Neue Option …" value={name}
            onChange={(e) => { setName(e.target.value); setActive(null) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !name.trim() && active !== null) { e.preventDefault(); choose(entries[active] ?? null) }
            }} />
          <button type="submit" className="primary" disabled={!name.trim()}>Anlegen</button>
        </form>
        <div className="actions split">
          <button type="button" onClick={props.onManage}>Optionen verwalten</button>
          <button type="button" onClick={props.onClose}>Schließen</button>
        </div>
      </div>
    </Modal>
  )
}

export function OptionsEditor(props: { doc: Y.Doc; tableId: string; col: ColumnInfo; onClose: () => void }) {
  const { doc, tableId, col } = props
  const options = col.options ?? []
  const [removing, setRemoving] = useState<SelectOption | null>(null)
  return (
    <Modal onClose={props.onClose}>
      <div className="dialog optionseditor" onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>Optionen von „{col.name}“</h3>
        <div className="opt-edit-list">
          {options.map((o) => (
            <div key={o.id} className="opt-edit">
              <input value={o.name} onChange={(e) => updateOption(doc, tableId, col.id, o.id, { name: e.target.value })} />
              <div className="swatches">
                {OPTION_COLORS.map((c) => (
                  <button key={c} type="button" className={`sw ${c === o.color ? 'on' : ''}`} title={c}
                    style={{ background: paletteOf(c).dot }} onClick={() => updateOption(doc, tableId, col.id, o.id, { color: c })} />
                ))}
              </div>
              <button type="button" className="del" title="Option löschen" onClick={() => setRemoving(o)}>✕</button>
            </div>
          ))}
          {options.length === 0 && <p className="hint">Keine Optionen.</p>}
        </div>
        <div className="actions">
          <button type="button" className="primary" onClick={() => {
            const n = addOption(doc, tableId, col.id, 'Neue Option'); void n
          }}>+ Option</button>
          <button type="button" onClick={props.onClose}>Fertig</button>
        </div>
        {removing && (
          <ConfirmDialog detail={`Option „${removing.name}“. Zeilen mit dieser Option zeigen danach nichts an.`}
            onCancel={() => setRemoving(null)}
            onConfirm={() => { deleteOption(doc, tableId, col.id, removing.id); setRemoving(null) }} />
        )}
      </div>
    </Modal>
  )
}

export function SelectCell(props: { doc: Y.Doc; tableId: string; rowId: string; col: ColumnInfo }) {
  const { doc, tableId, rowId, col } = props
  const value = useCell(doc, tableId, rowId, col.id) as string | null
  const current = (col.options ?? []).find((o) => o.id === value)
  const [mode, setMode] = useState<'pick' | 'edit' | null>(null)
  // Nach dem Schließen des Dialogs zurück auf die Zelle, damit man mit Tab weitermachen kann
  const btn = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)
  useEffect(() => {
    if (mode === null && wasOpen.current) btn.current?.focus()
    wasOpen.current = mode !== null
  }, [mode])
  return (
    <div className="c selectcell">
      <button ref={btn} type="button" className="select-btn" onClick={() => setMode('pick')} title={col.name}>
        {current ? <Pill option={current} /> : <span className="select-empty">Auswählen …</span>}
      </button>
      {mode === 'pick' && (
        <SelectPicker doc={doc} tableId={tableId} rowId={rowId} col={col} value={current ? value : null}
          onManage={() => setMode('edit')} onClose={() => setMode(null)} />
      )}
      {mode === 'edit' && <OptionsEditor doc={doc} tableId={tableId} col={col} onClose={() => setMode(null)} />}
    </div>
  )
}
