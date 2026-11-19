import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConfigContext, FormulaConfig } from './columnTypes'
import { FUNCTIONS, FormulaSyntaxError, parseFormula } from './formula'

/** Namen mit Leerzeichen oder Sonderzeichen brauchen eckige Klammern. */
export const refName = (name: string) => (/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) ? name : `[${name}]`)

/** Formel bearbeiten: Änderungen gelten, sobald das Feld verlassen oder der Dialog geschlossen wird. */
export function FormulaEditor({ config, set, table, tables, column }: ConfigContext<FormulaConfig>) {
  const [draft, setDraft] = useState(config.expr)
  const area = useRef<HTMLTextAreaElement>(null)
  const latest = useRef({ draft, saved: config.expr, set })
  latest.current = { draft, saved: config.expr, set }
  useEffect(() => () => { // Dialog schließt (z. B. mit Escape): Eingabe nicht verlieren
    const { draft: d, saved, set: s } = latest.current
    if (d !== saved) s({ expr: d })
  }, [])
  const apply = () => { if (draft !== config.expr) set({ expr: draft }) }

  const error = useMemo(() => {
    if (!draft.trim()) return null
    try { parseFormula(draft); return null } catch (e) { return e instanceof FormulaSyntaxError ? e.message : String(e) }
  }, [draft])

  const insert = (text: string) => {
    const el = area.current
    const at = el ? [el.selectionStart, el.selectionEnd] : [draft.length, draft.length]
    const next = draft.slice(0, at[0]) + text + draft.slice(at[1])
    setDraft(next)
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at[0] + text.length, at[0] + text.length) })
  }

  const own = table.columns.filter((c) => c.id !== column.id)
  const paths = table.columns.filter((c) => c.type === 'relation').flatMap((rel) => {
    const target = tables.find((t) => t.id === rel.target)
    return (target?.columns ?? []).map((c) => ({ key: `${rel.id}.${c.id}`, text: `${refName(rel.name)}.${refName(c.name)}` }))
  })

  return (
    <>
      <label className="cfg-field">
        <span>Formel</span>
        <textarea ref={area} className="formula-input" rows={3} spellCheck={false} value={draft} placeholder="z. B. [Führer] + [Unterführer] + [Helfer]"
          onChange={(e) => setDraft(e.target.value)} onBlur={apply}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); apply() } }} />
      </label>
      {error ? <p className="formula-error" role="alert">{error}</p>
        : <p className="hint formula-help">Rechnen mit + − * / ^, Text mit &amp;, Vergleiche mit = &lt;&gt; &lt; &gt;. Funktionen: {FUNCTIONS.join(', ')}. Für verknüpfte Zeilen: <code>SUMME(Relation.Spalte)</code>.</p>}
      <div className="cfg-field">
        <span>Spalten einfügen</span>
        <div className="formula-chips">
          {own.map((c) => <button key={c.id} type="button" onClick={() => insert(refName(c.name))}>{c.name}</button>)}
          {paths.map((p) => <button key={p.key} type="button" className="path" onClick={() => insert(p.text)}>{p.text}</button>)}
          {own.length + paths.length === 0 && <span className="hint">Keine weiteren Spalten.</span>}
        </div>
      </div>
      <label className="cfg-field">
        <span>Nachkommastellen (bei Zahlen)</span>
        <select value={config.decimals} onChange={(e) => set({ decimals: Number(e.target.value) })}>
          <option value={-1}>Beliebig</option>
          {[0, 1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <label className="cfg-field">
        <span>Einheit</span>
        <input value={config.unit} placeholder="z. B. € oder kg" maxLength={12} onChange={(e) => set({ unit: e.target.value })} />
      </label>
    </>
  )
}
