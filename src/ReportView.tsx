/** Anzeige und Bearbeitung eines Berichts (report.ts). Das Blatt sieht in jedem Erscheinungsbild wie Papier aus. */
import { useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import { FUNCTIONS, FormulaSyntaxError, splitTemplate, canonicalFn } from './formula'
import { IconPicker } from './icons'
import { Modal } from './Modal'
import { addBlock, moveBlock, removeBlock, updateBlock, type BlockKind, type ReportBlock, type ReportInfo, type TableInfo, type ViewInfo } from './model'
import { placeholderFor, reportEngine } from './report'
import { RichField, sanitizeHtml } from './richText'
import type { Rights } from './rights'
import { useRingVersion } from './useTables'
import { t } from './i18n'

type Engine = ReturnType<typeof reportEngine>

/** Ein Stück Text mit Platzhaltern als DOM-Knoten: Werte eingesetzt, Fehler markiert. */
function fill(doc: Document, text: string, engine: Engine): Node {
  const out = doc.createDocumentFragment()
  const mark = (className: string, content: string, title?: string) => {
    const el = doc.createElement('span')
    el.className = className
    el.textContent = content
    if (title) el.title = title
    out.appendChild(el)
  }
  try {
    for (const part of splitTemplate(text)) {
      if ('text' in part) { out.appendChild(doc.createTextNode(part.text)); continue }
      const r = engine.value(part.expr)
      if (r.ok) mark('rp-val', r.text)
      else mark('rp-err', engine.isLocked(r) ? t('nicht vollständig verfügbar') : r.code, r.message)
    }
  } catch (e) {
    if (!(e instanceof FormulaSyntaxError)) throw e
    mark('rp-err', text, e.message)
  }
  return out
}

/** Einfaches HTML (bereinigt), in dessen Textstellen die Platzhalter ausgewertet sind. */
export function renderHtml(html: string, engine: Engine): string {
  const page = new DOMParser().parseFromString(`<body>${sanitizeHtml(html)}</body>`, 'text/html')
  const walker = page.createTreeWalker(page.body, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  while (walker.nextNode()) texts.push(walker.currentNode as Text)
  for (const node of texts) if (node.data.includes('{{')) node.replaceWith(fill(page, node.data, engine))
  return page.body.innerHTML
}

const plain = (text: string) => { const d = document.createElement('div'); d.textContent = text; return d.innerHTML }

function Block({ block, engine }: { block: ReportBlock; engine: Engine }) {
  if (block.kind === 'heading') {
    const Tag = block.level === 2 ? 'h2' : 'h1'
    return <Tag dangerouslySetInnerHTML={{ __html: renderHtml(plain(block.text ?? ''), engine) }} />
  }
  if (block.kind === 'text') return <div className="rp-text" dangerouslySetInnerHTML={{ __html: renderHtml(block.text ?? '', engine) }} />
  const result = block.source ? engine.table(block.source, block.hide, block.totals) : null
  if (!result) return <p className="rp-err">{block.source ? t('Diese Tabelle gibt es nicht mehr.') : t('Noch keine Tabelle gewählt.')}</p>
  if ('error' in result) return <p className="rp-err" title={result.error}>{t('Tabelle „{name}“: nicht vollständig verfügbar', { name: result.name })}</p>
  const cls = (i: number) => (result.columns[i].numeric ? 'num' : undefined)
  return (
    <table className="rp-table">
      <thead><tr>{result.columns.map((c, i) => <th key={c.id} className={cls(i)}>{c.name}</th>)}</tr></thead>
      <tbody>
        {result.rows.map((row, y) => <tr key={y}>{row.map((v, i) => <td key={i} className={cls(i)}>{v}</td>)}</tr>)}
        {result.rows.length === 0 && <tr><td colSpan={result.columns.length} className="rp-none">{t('Keine Einträge')}</td></tr>}
        {result.totals && <tr className="rp-total">{result.totals.map((v, i) => <td key={i} className={cls(i)}>{v}</td>)}</tr>}
      </tbody>
    </table>
  )
}

export function ReportView(props: { doc: Y.Doc; report: ReportInfo; tables: TableInfo[]; views: ViewInfo[]; rights: Rights; editing: boolean }) {
  const { doc, report, tables, views, rights, editing } = props
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const h = () => setTick((n) => n + 1)
    doc.on('update', h)
    return () => { doc.off('update', h) }
  }, [doc])
  const ringV = useRingVersion(doc)
  // Ein Rechner je Stand: Spalten werden dabei nur einmal berechnet
  const engine = useMemo(() => reportEngine(doc, tables, views, rights), [doc, tables, views, rights, tick, ringV])
  const add = (kind: BlockKind) => addBlock(doc, report.id, kind === 'table' ? { kind, source: tables[0]?.id, totals: true } : kind === 'heading' ? { kind, level: 2, text: '' } : { kind, text: '' })
  const label: Record<BlockKind, string> = { heading: t('Überschrift'), text: t('Text'), table: t('Tabelle') }

  return (
    <div className={`report${editing ? ' editing' : ''}`}>
      <article className="rp-paper">
        {report.blocks.map((b, i) => editing ? (
          <section key={b.id} className="rp-edit">
            <div className="rp-edit-head">
              <strong>{label[b.kind]}</strong>
              <button type="button" disabled={i === 0} aria-label={t('Nach oben')} title={t('Nach oben')} onClick={() => moveBlock(doc, report.id, b.id, -1)}>↑</button>
              <button type="button" disabled={i === report.blocks.length - 1} aria-label={t('Nach unten')} title={t('Nach unten')} onClick={() => moveBlock(doc, report.id, b.id, 1)}>↓</button>
              <button type="button" aria-label={t('Abschnitt entfernen')} title={t('Abschnitt entfernen')} onClick={() => removeBlock(doc, report.id, b.id)}>✕</button>
            </div>
            <BlockEditor block={b} tables={tables} views={views} onChange={(patch) => updateBlock(doc, report.id, b.id, patch)} />
            <div className="rp-preview"><Block block={b} engine={engine} /></div>
          </section>
        ) : <Block key={b.id} block={b} engine={engine} />)}
        {report.blocks.length === 0 && <p className="rp-none">{t('Dieser Bericht ist noch leer.')}</p>}
        {editing && (
          <div className="rp-add">
            <button type="button" onClick={() => add('heading')}>{t('+ Überschrift')}</button>
            <button type="button" onClick={() => add('text')}>{t('+ Text')}</button>
            <button type="button" onClick={() => add('table')}>{t('+ Tabelle')}</button>
          </div>
        )}
      </article>
    </div>
  )
}

function BlockEditor({ block, tables, views, onChange }: { block: ReportBlock; tables: TableInfo[]; views: ViewInfo[]; onChange: (patch: Partial<ReportBlock>) => void }) {
  const box = useRef<HTMLDivElement>(null)
  /** Wo der Cursor stand, bevor die Einfügehilfe aufging */
  const caret = useRef<Range | number | null>(null)
  const [inserting, setInserting] = useState(false)

  const openInsert = () => {
    const input = box.current?.querySelector<HTMLInputElement>('input.rp-heading')
    if (input) caret.current = input.selectionStart
    else {
      const sel = getSelection(), editor = box.current?.querySelector('.rich-editor')
      caret.current = sel && sel.rangeCount && editor?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null
    }
    setInserting(true)
  }
  const insert = (snippet: string) => {
    setInserting(false)
    if (block.kind === 'heading') {
      const text = block.text ?? '', at = typeof caret.current === 'number' ? caret.current : text.length
      onChange({ text: text.slice(0, at) + snippet + text.slice(at) })
      return
    }
    const at = caret.current
    // Der Dialog muss zu sein, bevor das Textfeld den Fokus nehmen kann
    setTimeout(() => {
      const editor = box.current?.querySelector<HTMLElement>('.rich-editor')
      if (!editor) return
      editor.focus()
      const range = at instanceof Range ? at : document.createRange()
      if (!(at instanceof Range)) { range.selectNodeContents(editor); range.collapse(false) }
      const sel = getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
      document.execCommand('insertText', false, snippet)
    })
  }

  if (block.kind === 'table') {
    const view = views.find((v) => v.id === block.source)
    const source = tables.find((x) => x.id === (view ? view.def.source : block.source))
    const columns = source?.columns.filter((c) => !c.hidden) ?? []
    const hidden = new Set(block.hide ?? [])
    return (
      <div className="rp-config">
        <label>{t('Tabelle')}
          <select value={block.source ?? ''} onChange={(e) => onChange({ source: e.target.value, hide: [] })}>
            {!source && <option value={block.source ?? ''}>–</option>}
            <SourceOptions tables={tables} views={views} />
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={!!block.totals} onChange={(e) => onChange({ totals: e.target.checked })} /> {t('Summenzeile')}</label>
        <div className="rp-columns" role="group" aria-label={t('Spalten im Bericht')}>
          {columns.map((c) => (
            <label key={c.id} className="check"><input type="checkbox" checked={!hidden.has(c.id)}
              onChange={(e) => onChange({ hide: e.target.checked ? [...hidden].filter((x) => x !== c.id) : [...hidden, c.id] })} /> {c.name}</label>
          ))}
        </div>
      </div>
    )
  }
  return (
    <div ref={box} className="rp-input">
      {block.kind === 'heading' ? (
        <div className="rp-heading-row">
          <input className="rp-heading" value={block.text ?? ''} placeholder={t('Überschrift')} aria-label={t('Überschrift')} onChange={(e) => onChange({ text: e.target.value })} />
          <select value={block.level ?? 1} aria-label={t('Größe der Überschrift')} onChange={(e) => onChange({ level: e.target.value === '2' ? 2 : 1 })}>
            <option value="1">{t('Groß')}</option>
            <option value="2">{t('Klein')}</option>
          </select>
        </div>
      ) : <RichField value={block.text ?? ''} onChange={(text) => onChange({ text })} />}
      <button type="button" className="rp-insert" onMouseDown={(e) => e.preventDefault()} onClick={openInsert}>{t('Wert einfügen …')}</button>
      {inserting && <InsertDialog tables={tables} views={views} onClose={() => setInserting(false)} onInsert={insert} />}
    </div>
  )
}

function SourceOptions({ tables, views }: { tables: TableInfo[]; views: ViewInfo[] }) {
  return (
    <>
      <optgroup label={t('Tabellen')}>{tables.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup>
      {views.length > 0 && <optgroup label={t('Abgeleitete Tabellen')}>{views.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup>}
    </>
  )
}

/** Funktionen, die viele Zeilen zusammenfassen, mit dem Namen, den die Einfügehilfe schreibt. */
const INSERTABLE = FUNCTIONS.filter((f) => ['SUM', 'COUNT', 'AVG', 'MIN', 'MAX', 'JOIN'].includes(canonicalFn(f) ?? ''))

/** Einfügehilfe: Funktion, Tabelle und Spalte wählen, damit man keine Namen abtippen muss. */
function InsertDialog({ tables, views, onInsert, onClose }: { tables: TableInfo[]; views: ViewInfo[]; onInsert: (snippet: string) => void; onClose: () => void }) {
  const [fn, setFn] = useState('SUMME')
  const [sourceId, setSource] = useState(tables[0]?.id ?? '')
  const view = views.find((v) => v.id === sourceId)
  const table = tables.find((x) => x.id === (view ? view.def.source : sourceId))
  const columns = table?.columns.filter((c) => !c.hidden) ?? []
  const count = canonicalFn(fn) === 'COUNT'
  const numeric = columns.find((c) => c.type === 'number')
  const [colId, setCol] = useState<string | null>(null)
  // Ohne Wahl: beim Zählen die Zeilen, sonst die erste Zahlenspalte
  const col = columns.find((c) => c.id === colId) ?? (count && !colId ? undefined : numeric ?? columns[0])
  const name = view?.name ?? table?.name
  const snippet = name && (count || col) ? placeholderFor(fn, name, col?.name ?? null) : null
  return (
    <Modal onClose={onClose}>
      <form className="dialog rp-insert-dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}
        onSubmit={(e) => { e.preventDefault(); if (snippet) onInsert(snippet) }}>
        <h3>{t('Wert einfügen')}</h3>
        <label>{t('Berechnung')}
          <select autoFocus value={fn} onChange={(e) => { setFn(e.target.value); setCol(null) }}>
            {INSERTABLE.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
        <label>{t('Tabelle')}
          <select value={sourceId} onChange={(e) => { setSource(e.target.value); setCol(null) }}><SourceOptions tables={tables} views={views} /></select>
        </label>
        <label>{t('Spalte')}
          <select value={col?.id ?? ''} onChange={(e) => setCol(e.target.value || 'rows')}>
            {count && <option value="">{t('(alle Zeilen)')}</option>}
            {columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        {snippet && <code className="rp-snippet">{snippet}</code>}
        <div className="actions">
          <button type="button" onClick={onClose}>{t('Abbrechen')}</button>
          <button type="submit" className="primary" disabled={!snippet}>{t('Einfügen')}</button>
        </div>
      </form>
    </Modal>
  )
}

/** Name und Symbol eines Berichts. */
export function ReportDialog(props: { initial?: { name: string; icon?: string }; onSubmit: (name: string, icon: string) => void; onClose: () => void }) {
  const [name, setName] = useState(props.initial?.name ?? t('Bericht'))
  const [icon, setIcon] = useState(props.initial?.icon ?? '')
  return (
    <Modal onClose={props.onClose}>
      <form className="dialog mapdialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && props.onClose()}
        onSubmit={(e) => { e.preventDefault(); if (name.trim()) props.onSubmit(name.trim(), icon) }}>
        <h3>{props.initial ? t('Bericht bearbeiten') : t('Neuer Bericht')}</h3>
        <label>{t('Name')}<input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
        <IconPicker value={icon} kind="report" onChange={setIcon} />
        <div className="actions">
          <button type="button" onClick={props.onClose}>{t('Abbrechen')}</button>
          <button type="submit" className="primary" disabled={!name.trim()}>{props.initial ? t('Speichern') : t('Anlegen')}</button>
        </div>
      </form>
    </Modal>
  )
}
