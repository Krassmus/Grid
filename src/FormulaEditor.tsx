import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConfigContext, FormulaConfig, TemplateConfig } from './columnTypes'
import { FUNCTIONS, FormulaSyntaxError, parseFormula, parseTemplate } from './formula'

/** Namen mit Leerzeichen oder Sonderzeichen brauchen eckige Klammern. */
export const refName = (name: string) => (/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) ? name : `[${name}]`)

const SHORT_LIST = FUNCTIONS.slice(0, 8).join(', ') + ', RUNDEN, HEUTE, TAGE_SEIT'

/** Kurzer Überblick über die Formelsprache, aufklappbar unter dem Eingabefeld. */
function FormulaHelp({ template = false }: { template?: boolean }) {
  const c = (t: string) => <code>{t}</code>
  return (
    <details className="formula-ref">
      <summary>Hilfe: Schreibweise und Funktionen</summary>
      <h5>Schreibweise</h5>
      <ul>
        {template && <li>Text mit Werten: alles in {c('{{ }}')} wird ausgewertet, der Rest bleibt Text. In den Klammern gilt die ganze Formelsprache.</li>}
        <li>Spalten: {c('[Name der Spalte]')}; ohne Leerzeichen und Sonderzeichen geht auch {c('Name')}. Groß-/Kleinschreibung ist egal.</li>
        <li>Zahlen mit Punkt ({c('3.5')}), Text in Anführungszeichen ({c('"Hallo"')}, ein {c('"')} im Text doppelt schreiben), {c('WAHR')} und {c('FALSCH')}.</li>
        <li>Rechnen: {c('+ − * / ^')} mit Klammern ({c('^')} vor {c('* /')} vor {c('+ −')}). Leere Zellen zählen als 0, Kästchen als 1/0, Text zählt, wenn er wie eine Zahl aussieht.</li>
        <li>Text verbinden: {c('&')}, z. B. {c('"Gruppe " & [Name]')}. Zahlen erscheinen dabei ohne Einheit.</li>
        <li>Vergleichen: {c('= <> < <= > >=')} → Wahr/Falsch. Text vergleicht ohne Groß-/Kleinschreibung und Zahlen im Text nach Wert. Datum steht als {c('JJJJ-MM-TT')} und lässt sich so vergleichen.</li>
        <li>Argumente trennst du mit {c(';')} oder {c(',')}. Funktionsnamen gehen deutsch und englisch ({c('WENN')} = {c('IF')}).</li>
      </ul>
      <h5>Funktionen</h5>
      <dl>
        <dt>{c('WENN(Bedingung; dann; sonst)')}</dt><dd>{c('IF')}; ohne „sonst“ bleibt das Feld leer. Falsch sind 0, leer, Text {c('""')} und {c('FALSCH')}.</dd>
        <dt>{c('UND(…)')} {c('ODER(…)')} {c('NICHT(x)')}</dt><dd>{c('AND')}, {c('OR')}, {c('NOT')}: Wahr/Falsch verknüpfen.</dd>
        <dt>{c('ISTLEER(x)')}</dt><dd>{c('ISEMPTY')}: Wahr, wenn die Zelle leer ist.</dd>
        <dt>{c('SUMME(…)')} {c('MITTELWERT(…)')}</dt><dd>{c('SUM')}, {c('AVERAGE')}/{c('AVG')}: mehrere Werte, Spalten oder verknüpfte Zeilen.</dd>
        <dt>{c('MIN(…)')} {c('MAX(…)')}</dt><dd>Kleinster/größter Wert; auch für Text (alphabetisch) und Datum.</dd>
        <dt>{c('ANZAHL(…)')}</dt><dd>{c('COUNT')}: zählt die nicht leeren Werte.</dd>
        <dt>{c('TEXTVERBINDEN(Werte; Trenner)')}</dt><dd>{c('JOIN')}: fügt Werte zu einem Text zusammen, Standardtrenner {c('", "')}.</dd>
        <dt>{c('RUNDEN(Zahl; Stellen)')}</dt><dd>{c('ROUND')}: rundet kaufmännisch, Stellen 0 bis 10 (Standard 0).</dd>
        <dt>{c('ABS(Zahl)')}</dt><dd>Betrag ohne Vorzeichen.</dd>
      </dl>
      <h5>Datum</h5>
      <p className="ref-note">Datum ist Text im Format {c('JJJJ-MM-TT')} (mit Uhrzeit {c('JJJJ-MM-TTTHH:MM')}), so wie es Datumsspalten liefern. Gerechnet wird mit ganzen Kalendertagen, die Uhrzeit zählt nicht. „Heute“ ist der Tag auf diesem Gerät. Leere Datumsfelder ergeben ein leeres Ergebnis, andere Texte {c('#WERT!')}.</p>
      <dl>
        <dt>{c('TAGE_SEIT(Datum)')}</dt><dd>{c('DAYSINCE')}: Tage vom Datum bis heute, z. B. {c('TAGE_SEIT([Eingang])')}. Liegt das Datum in der Zukunft, ist das Ergebnis negativ.</dd>
        <dt>{c('TAGE_BIS(Datum)')}</dt><dd>{c('DAYSUNTIL')}: Tage von heute bis zum Datum (negativ, wenn es vorbei ist).</dd>
        <dt>{c('TAGE(von; bis)')}</dt><dd>{c('DAYS')}: Tage zwischen zwei Daten.</dd>
        <dt>{c('ALTER(Datum; [bis])')}</dt><dd>{c('AGE')}: volle Jahre, z. B. für Geburtstage; ohne „bis“ bis heute.</dd>
        <dt>{c('JAHR(Datum)')} {c('MONAT(Datum)')} {c('TAG(Datum)')}</dt><dd>{c('YEAR')}, {c('MONTH')}, {c('DAY')}.</dd>
        <dt>{c('WOCHENTAG(Datum)')}</dt><dd>{c('WEEKDAY')}: 1 = Montag … 7 = Sonntag.</dd>
        <dt>{c('TAGE_ADDIEREN(Datum; n)')}</dt><dd>{c('ADDDAYS')}: Datum plus n Tage (negativ = zurück); eine Uhrzeit bleibt erhalten.</dd>
        <dt>{c('DATUM(Jahr; Monat; Tag)')}</dt><dd>{c('DATE')}: baut ein Datum; {c('DATUM(2026; 13; 1)')} ergibt den 1.1.2027.</dd>
        <dt>{c('HEUTE()')} {c('JETZT()')}</dt><dd>{c('TODAY')}, {c('NOW')}: heutiges Datum bzw. mit Uhrzeit. Die Ergebnisse stehen als Text {c('JJJJ-MM-TT')}.</dd>
      </dl>
      <h5>Verknüpfte Zeilen</h5>
      <ul>
        <li>{c('Relation.Spalte')} liefert die Werte aller verknüpften Zeilen, z. B. {c('SUMME(Gruppen.Führer)')}. Auch über mehrere Relationen: {c('A.B.Spalte')}.</li>
        <li>Nur eine Relationsspalte {c('ANZAHL(Gruppen)')} zählt die Verknüpfungen, {c('TEXTVERBINDEN(Gruppen)')} listet deren Titel auf.</li>
        <li>Solche Listen gehen nur in {c('SUMME')}, {c('MITTELWERT')}, {c('MIN')}, {c('MAX')}, {c('ANZAHL')} und {c('TEXTVERBINDEN')}.</li>
      </ul>
      <h5>Darstellung des Ergebnisses</h5>
      <ul>
        <li>Der Typ ergibt sich aus der Formel: Zahl, Text oder Wahr/Falsch (als Kästchen). {c('WENN')} mit verschiedenen Typen ergibt Text.</li>
        <li>Zahlen: unten im Dialog Nachkommastellen (0–4 oder beliebig) und Einheit (z. B. € oder kg) wählen. Ohne Auswahl wird auf 12 Stellen genau gerechnet.</li>
        <li>Fehler stehen in der Zelle: {c('#NAME?')} (Spalte oder Funktion unbekannt), {c('#WERT!')} (z. B. Text statt Zahl), {c('#DIV/0!')}, {c('#SYNTAX')} (Formel unvollständig), {c('#ZYKLUS')} (bezieht sich auf sich selbst). Zeigt man mit der Maus darauf, steht dort der Grund.</li>
      </ul>
      {!template && <>
        <h5>Beispiele</h5>
        <ul>
          <li>{c('[Preis] * [Menge]')}</li>
          <li>{c('RUNDEN([Summe] / [Anzahl]; 2)')}</li>
          <li>{c('WENN([Helfer] > 10; "viele"; "wenige")')}</li>
          <li>{c('WENN(ISTLEER([Fertig am]); "offen"; "fertig")')}</li>
          <li>{c('SUMME(Gruppen.Führer) + SUMME(Gruppen.Helfer)')}</li>
          <li>{c('WENN(TAGE_SEIT([Eingang]) > 30; "überfällig"; "ok")')}</li>
          <li>{c('TAGE_ADDIEREN([Start]; 14)')} · {c('ALTER([Geburtstag])')}</li>
        </ul>
        <p className="hint">Text mit eingestreuten Werten geht einfacher mit der Spalte „Text mit Platzhaltern“.</p>
      </>}
    </details>
  )
}

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
        : <p className="hint formula-help">Rechnen mit + − * / ^, Text mit &amp;, Vergleiche mit = &lt;&gt; &lt; &gt;. Funktionen: {SHORT_LIST} u. a. (alle in der Hilfe). Für verknüpfte Zeilen: <code>SUMME(Relation.Spalte)</code>.</p>}
      <FormulaHelp />
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

/** Text mit Platzhaltern bearbeiten: wie die Formel, aber mit `{{ … }}` im Text. */
export function TemplateEditor({ config, set, table, tables, column }: ConfigContext<TemplateConfig>) {
  const [draft, setDraft] = useState(config.tpl)
  const area = useRef<HTMLTextAreaElement>(null)
  const latest = useRef({ draft, saved: config.tpl, set })
  latest.current = { draft, saved: config.tpl, set }
  useEffect(() => () => {
    const { draft: d, saved, set: s } = latest.current
    if (d !== saved) s({ tpl: d })
  }, [])
  const apply = () => { if (draft !== config.tpl) set({ tpl: draft }) }
  const error = useMemo(() => {
    if (!draft.trim()) return null
    try { parseTemplate(draft); return null } catch (e) { return e instanceof FormulaSyntaxError ? e.message : String(e) }
  }, [draft])
  const insert = (text: string) => {
    const el = area.current
    const at = el ? [el.selectionStart, el.selectionEnd] : [draft.length, draft.length]
    setDraft(draft.slice(0, at[0]) + text + draft.slice(at[1]))
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at[0] + text.length, at[0] + text.length) })
  }
  const own = table.columns.filter((c) => c.id !== column.id)
  const paths = table.columns.filter((c) => c.type === 'relation').flatMap((rel) => {
    const target = tables.find((t) => t.id === rel.target)
    return (target?.columns ?? []).map((c) => ({ key: `${rel.id}.${c.id}`, text: `SUMME(${refName(rel.name)}.${refName(c.name)})` }))
  })
  return (
    <>
      <label className="cfg-field">
        <span>Text mit Platzhaltern</span>
        <textarea ref={area} className="formula-input" rows={4} spellCheck={false} value={draft}
          placeholder={'z. B. {{Vorname}} {{Name}} – {{[Führer] + [Helfer]}} Personen'}
          onChange={(e) => setDraft(e.target.value)} onBlur={apply}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); apply() } }} />
      </label>
      {error ? <p className="formula-error" role="alert">{error}</p>
        : <p className="hint formula-help">Alles in <code>{'{{ }}'}</code> wird ausgewertet und darf eine ganze Formel sein, z. B. <code>{'{{RUNDEN([Preis] * 1.19; 2)}}'}</code>. Funktionen: {SHORT_LIST} u. a. (alle in der Hilfe).</p>}
      <FormulaHelp template />
      <div className="cfg-field">
        <span>Platzhalter einfügen</span>
        <div className="formula-chips">
          {own.map((c) => <button key={c.id} type="button" onClick={() => insert(`{{${refName(c.name)}}}`)}>{c.name}</button>)}
          {paths.map((p) => <button key={p.key} type="button" className="path" onClick={() => insert(`{{${p.text}}}`)}>{p.text}</button>)}
          {own.length + paths.length === 0 && <span className="hint">Keine weiteren Spalten.</span>}
        </div>
      </div>
    </>
  )
}
