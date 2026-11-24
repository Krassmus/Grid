import { useEffect, useRef } from 'react'
import * as Y from 'yjs'
import { setCell } from './model'
import { Modal } from './Modal'
import { t } from './i18n'

/** Erlaubt sind nur einfache Formatierungen. Alles andere (Skripte, Attribute, Stile) wird entfernt. */
const ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'UL', 'OL', 'LI', 'BR', 'P', 'DIV'])

export function sanitizeHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const out = document.createElement('div')
  const walk = (src: Node, dst: Node) => {
    src.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) dst.appendChild(document.createTextNode(n.textContent ?? ''))
      else if (n.nodeType === Node.ELEMENT_NODE) {
        const el = n as Element
        if (ALLOWED.has(el.tagName)) {
          const copy = document.createElement(el.tagName.toLowerCase())
          walk(el, copy)
          dst.appendChild(copy)
        } else if (el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE') walk(el, dst) // Hülle weg, Inhalt bleibt
      }
    })
  }
  walk(parsed.body, out)
  return out.innerHTML
}

/** Reiner Text ohne Formatierung (für Vergleiche und leere Zellen). */
export function plainText(html: string): string {
  const d = document.createElement('div')
  d.innerHTML = sanitizeHtml(html)
  return d.textContent ?? ''
}

export function RichPreview({ html, placeholder }: { html: string; placeholder: string }) {
  if (!html || !plainText(html).trim()) return <span className="rich-empty">{placeholder}</span>
  return <div className="rich-view" dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />
}

const TOOLS: { cmd: string; label: string; title: string; style?: React.CSSProperties }[] = [
  { cmd: 'bold', label: 'B', title: 'Fett (⌘B)', style: { fontWeight: 700 } },
  { cmd: 'italic', label: 'I', title: 'Kursiv (⌘I)', style: { fontStyle: 'italic' } },
  { cmd: 'underline', label: 'U', title: 'Unterstrichen (⌘U)', style: { textDecoration: 'underline' } },
  { cmd: 'insertUnorderedList', label: '• Liste', title: 'Aufzählung' },
  { cmd: 'insertOrderedList', label: '1. Liste', title: 'Nummerierte Liste' },
]

/** Bearbeitet formatierten Text einer Zelle in einem Dialog. „Speichern“ übernimmt, alles andere verwirft. */
export function RichTextDialog(props: { doc: Y.Doc; tableId: string; rowId: string; colId: string; title: string; html: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.innerHTML = sanitizeHtml(props.html)
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const sel = getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }, [])
  const save = () => {
    const html = sanitizeHtml(ref.current?.innerHTML ?? '')
    setCell(props.doc, props.tableId, props.rowId, props.colId, plainText(html).trim() ? html : null)
    props.onClose()
  }
  return (
    <Modal onClose={props.onClose}>
      <div className="dialog richdialog" onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') props.onClose(); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save() }}>
        <h3>{props.title}</h3>
        <div className="rich-tools">
          {TOOLS.map((tool) => (
            <button key={tool.cmd} type="button" title={t(tool.title)} style={tool.style}
              onMouseDown={(e) => { e.preventDefault(); document.execCommand(tool.cmd) }}>{t(tool.label)}</button>
          ))}
        </div>
        <div ref={ref} className="rich-editor" contentEditable suppressContentEditableWarning />
        <div className="actions">
          <button type="button" onClick={props.onClose}>{t('Abbrechen')}</button>
          <button type="button" className="primary" onClick={save}>{t('Speichern')}</button>
        </div>
      </div>
    </Modal>
  )
}

/** Formatierter Text als Formularfeld (Werkzeugleiste + Eingabefläche); `onChange` bekommt bereinigtes HTML. */
export function RichField({ value, onChange }: { value: string; onChange: (html: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (ref.current) ref.current.innerHTML = sanitizeHtml(value) }, [])
  return (
    <div className="rich-field">
      <div className="rich-tools">
        {TOOLS.map((tool) => (
          <button key={tool.cmd} type="button" title={t(tool.title)} style={tool.style} tabIndex={-1}
            onMouseDown={(e) => { e.preventDefault(); document.execCommand(tool.cmd); onChange(sanitizeHtml(ref.current?.innerHTML ?? '')) }}>{t(tool.label)}</button>
        ))}
      </div>
      <div ref={ref} className="rich-editor" contentEditable suppressContentEditableWarning
        onInput={() => onChange(sanitizeHtml(ref.current?.innerHTML ?? ''))} />
    </div>
  )
}
