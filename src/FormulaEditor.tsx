import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConfigContext, FormulaConfig, TemplateConfig } from './columnTypes'
import { FUNCTIONS, FormulaSyntaxError, parseFormula, parseTemplate } from './formula'
import { t } from './i18n'

/** Namen mit Leerzeichen oder Sonderzeichen brauchen eckige Klammern. */
/** Ein Feld in der Formel: `{{Name der Spalte}}`. */
export const refName = (name: string) => `{{${name}}}`

const SHORT_LIST = FUNCTIONS.slice(0, 8).join(', ') + ', RUNDEN, HEUTE, TAGE_SEIT'

/** Kurzer Überblick über die Formelsprache, aufklappbar unter dem Eingabefeld. */
function FormulaHelp({ template = false }: { template?: boolean }) {
  const c = (x: string) => <code>{x}</code>
  return (
    <details className="formula-ref">
      <summary>{t('Hilfe: Schreibweise und Funktionen')}</summary>
      <h5>{t('Schreibweise')}</h5>
      <ul>
        {template && <li>{t('Text mit Werten: alles in')} {c('{{ }}')} {t('wird ausgewertet, der Rest bleibt Text. In den Klammern gilt die ganze Formelsprache.')} {t('Ein Feld allein:')} {c(t('{{Name}}'))}{t('; mit Rechnung steht das Feld darin wieder in Klammern:')} {c(t('{{ {{Preis}} * {{Menge}} }}'))}.</li>}
        <li>{t('Spalten:')} {c(t('{{Name der Spalte}}'))}{t('; ältere Schreibweisen:')} {c('[Name]')} {t('und, ohne Leerzeichen und Sonderzeichen,')} {c(t('Name'))}{t('. Groß-/Kleinschreibung ist egal.')}</li>
        <li>{t('Zahlen mit Punkt (')}{c('3.5')}{t('), Text in Anführungszeichen (')}{c('"Hallo"')}{t(', ein')} {c('"')} {t('im Text doppelt schreiben),')} {c(t('WAHR'))} {t('und')} {c(t('FALSCH'))}.</li>
        <li>{t('Rechnen:')} {c('+ − * / ^')} {t('mit Klammern (')}{c('^')} {t('vor')} {c('* /')} {t('vor')} {c('+ −')}{t('). Leere Zellen zählen als 0, Kästchen als 1/0, Text zählt, wenn er wie eine Zahl aussieht.')}</li>
        <li>{t('Text verbinden:')} {c('&')}{t(', z. B.')} {c(t('"Gruppe " & [Name]'))}{t('. Zahlen erscheinen dabei ohne Einheit.')}</li>
        <li>{t('Vergleichen:')} {c('= <> < <= > >=')} {t('→ Wahr/Falsch. Text vergleicht ohne Groß-/Kleinschreibung und Zahlen im Text nach Wert. Datum steht als')} {c(t('JJJJ-MM-TT'))} {t('und lässt sich so vergleichen.')}</li>
        <li>{t('Argumente trennst du mit')} {c(';')} {t('oder')} {c(',')}{t('. Funktionsnamen gehen deutsch und englisch (')}{c('WENN')} = {c('IF')}).</li>
      </ul>
      <h5>{t('Funktionen')}</h5>
      <dl>
        <dt>{c(t('WENN(Bedingung; dann; sonst)'))}</dt><dd>{c('IF')}{t('; ohne „sonst“ bleibt das Feld leer. Falsch sind 0, leer, Text')} {c('""')} {t('und')} {c(t('FALSCH'))}.</dd>
        <dt>{c(t('UND(…)'))} {c(t('ODER(…)'))} {c(t('NICHT(x)'))}</dt><dd>{c('AND')}, {c('OR')}, {c('NOT')}{t(': Wahr/Falsch verknüpfen.')}</dd>
        <dt>{c(t('ISTLEER(x)'))}</dt><dd>{c('ISEMPTY')}{t(': Wahr, wenn die Zelle leer ist.')}</dd>
        <dt>{c(t('SUMME(…)'))} {c(t('MITTELWERT(…)'))}</dt><dd>{c('SUM')}, {c('AVERAGE')}/{c('AVG')}{t(': mehrere Werte, Spalten oder verknüpfte Zeilen.')}</dd>
        <dt>{c('MIN(…)')} {c('MAX(…)')}</dt><dd>{t('Kleinster/größter Wert; auch für Text (alphabetisch) und Datum.')}</dd>
        <dt>{c(t('ANZAHL(…)'))}</dt><dd>{c('COUNT')}{t(': zählt die nicht leeren Werte.')}</dd>
        <dt>{c(t('TEXTVERBINDEN(Werte; Trenner)'))}</dt><dd>{c('JOIN')}{t(': fügt Werte zu einem Text zusammen, Standardtrenner')} {c('", "')}.</dd>
        <dt>{c(t('RUNDEN(Zahl; Stellen)'))}</dt><dd>{c('ROUND')}{t(': rundet kaufmännisch, Stellen 0 bis 10 (Standard 0).')}</dd>
        <dt>{c(t('ABS(Zahl)'))}</dt><dd>{t('Betrag ohne Vorzeichen.')}</dd>
      </dl>
      <h5>{t('Datum')}</h5>
      <p className="ref-note">{t('Datum ist Text im Format')} {c(t('JJJJ-MM-TT'))} {t('(mit Uhrzeit')} {c(t('JJJJ-MM-TTTHH:MM'))}{t('), so wie es Datumsspalten liefern. Gerechnet wird mit ganzen Kalendertagen, die Uhrzeit zählt nicht. „Heute“ ist der Tag auf diesem Gerät. Leere Datumsfelder ergeben ein leeres Ergebnis, andere Texte')} {c('#WERT!')}.</p>
      <dl>
        <dt>{c(t('TAGE_SEIT(Datum)'))}</dt><dd>{c('DAYSINCE')}{t(': Tage vom Datum bis heute, z. B.')} {c(t('TAGE_SEIT({{Eingang}})'))}{t('. Liegt das Datum in der Zukunft, ist das Ergebnis negativ.')}</dd>
        <dt>{c(t('TAGE_BIS(Datum)'))}</dt><dd>{c('DAYSUNTIL')}{t(': Tage von heute bis zum Datum (negativ, wenn es vorbei ist).')}</dd>
        <dt>{c(t('TAGE(von; bis)'))}</dt><dd>{c('DAYS')}{t(': Tage zwischen zwei Daten.')}</dd>
        <dt>{c(t('ALTER(Datum; [bis])'))}</dt><dd>{c('AGE')}{t(': volle Jahre, z. B. für Geburtstage; ohne „bis“ bis heute.')}</dd>
        <dt>{c(t('JAHR(Datum)'))} {c(t('MONAT(Datum)'))} {c(t('TAG(Datum)'))}</dt><dd>{c('YEAR')}, {c('MONTH')}, {c('DAY')}.</dd>
        <dt>{c(t('WOCHENTAG(Datum)'))}</dt><dd>{c('WEEKDAY')}{t(': 1 = Montag … 7 = Sonntag.')}</dd>
        <dt>{c(t('TAGE_ADDIEREN(Datum; n)'))}</dt><dd>{c('ADDDAYS')}{t(': Datum plus n Tage (negativ = zurück); eine Uhrzeit bleibt erhalten.')}</dd>
        <dt>{c(t('DATUM(Jahr; Monat; Tag)'))}</dt><dd>{c('DATE')}{t(': baut ein Datum;')} {c(t('DATUM(2026; 13; 1)'))} {t('ergibt den 1.1.2027.')}</dd>
        <dt>{c(t('HEUTE()'))} {c(t('JETZT()'))}</dt><dd>{c('TODAY')}, {c('NOW')}{t(': heutiges Datum bzw. mit Uhrzeit. Die Ergebnisse stehen als Text')} {c(t('JJJJ-MM-TT'))}.</dd>
      </dl>
      <h5>{t('Verknüpfte Zeilen')}</h5>
      <ul>
        <li>{c(t('{{Relation.Spalte}}'))} {t('liefert die Werte aller verknüpften Zeilen, z. B.')} {c(t('SUMME({{Gruppen.Führer}})'))}{t('. Auch über mehrere Relationen:')} {c('{{A.B.Spalte}}')}.</li>
        <li>{t('Nur eine Relationsspalte')} {c(t('ANZAHL({{Gruppen}})'))} {t('zählt die Verknüpfungen,')} {c(t('TEXTVERBINDEN({{Gruppen}})'))} {t('listet deren Titel auf.')}</li>
        <li>{t('Solche Listen gehen nur in')} {c(t('SUMME'))}, {c(t('MITTELWERT'))}, {c('MIN')}, {c('MAX')}, {c(t('ANZAHL'))} {t('und')} {c(t('TEXTVERBINDEN'))}.</li>
      </ul>
      <h5>{t('Darstellung des Ergebnisses')}</h5>
      <ul>
        <li>{t('Der Typ ergibt sich aus der Formel: Zahl, Text oder Wahr/Falsch (als Kästchen).')} {c('WENN')} {t('mit verschiedenen Typen ergibt Text.')}</li>
        <li>{t('Zahlen: unten im Dialog Nachkommastellen (0–4 oder beliebig) und Einheit (z. B. € oder kg) wählen. Ohne Auswahl wird auf 12 Stellen genau gerechnet.')}</li>
        <li>{t('Fehler stehen in der Zelle:')} {c('#NAME?')} {t('(Spalte oder Funktion unbekannt),')} {c('#WERT!')} {t('(z. B. Text statt Zahl),')} {c('#DIV/0!')}, {c('#SYNTAX')} {t('(Formel unvollständig),')} {c('#ZYKLUS')} {t('(bezieht sich auf sich selbst). Zeigt man mit der Maus darauf, steht dort der Grund.')}</li>
      </ul>
      {!template && <>
        <h5>{t('Beispiele')}</h5>
        <ul>
          <li>{c(t('{{Preis}} * {{Menge}}'))}</li>
          <li>{c(t('RUNDEN({{Summe}} / {{Anzahl}}; 2)'))}</li>
          <li>{c(t('WENN({{Helfer}} > 10; "viele"; "wenige")'))}</li>
          <li>{c(t('WENN(ISTLEER({{Fertig am}}); "offen"; "fertig")'))}</li>
          <li>{c(t('SUMME({{Gruppen.Führer}}) + SUMME({{Gruppen.Helfer}})'))}</li>
          <li>{c(t('WENN(TAGE_SEIT({{Eingang}}) > 30; "überfällig"; "ok")'))}</li>
          <li>{c(t('TAGE_ADDIEREN({{Start}}; 14)'))} · {c(t('ALTER({{Geburtstag}})'))}</li>
        </ul>
        <p className="hint">{t('Text mit eingestreuten Werten geht einfacher mit der Spalte „Text mit Platzhaltern“.')}</p>
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
    const target = tables.find((x) => x.id === rel.target)
    return (target?.columns ?? []).map((c) => ({ key: `${rel.id}.${c.id}`, text: `{{${rel.name}.${c.name}}}` }))
  })

  return (
    <>
      <label className="cfg-field">
        <span>{t('Formel')}</span>
        <textarea ref={area} className="formula-input" rows={3} spellCheck={false} value={draft} placeholder={t('z. B. {{Führer}} + {{Unterführer}} + {{Helfer}}')}
          onChange={(e) => setDraft(e.target.value)} onBlur={apply}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); apply() } }} />
      </label>
      {error ? <p className="formula-error" role="alert">{error}</p>
        : <p className="hint formula-help">{t('Rechnen mit + − * / ^, Text mit &, Vergleiche mit = <> < >. Funktionen:')} {SHORT_LIST} {t('u. a. (alle in der Hilfe). Für verknüpfte Zeilen:')} <code>{t('SUMME({{Relation.Spalte}})')}</code>.</p>}
      <FormulaHelp />
      <div className="cfg-field">
        <span>{t('Spalten einfügen')}</span>
        <div className="formula-chips">
          {own.map((c) => <button key={c.id} type="button" onClick={() => insert(refName(c.name))}>{c.name}</button>)}
          {paths.map((p) => <button key={p.key} type="button" className="path" onClick={() => insert(p.text)}>{p.text}</button>)}
          {own.length + paths.length === 0 && <span className="hint">{t('Keine weiteren Spalten.')}</span>}
        </div>
      </div>
      <label className="cfg-field">
        <span>{t('Nachkommastellen (bei Zahlen)')}</span>
        <select value={config.decimals} onChange={(e) => set({ decimals: Number(e.target.value) })}>
          <option value={-1}>{t('Beliebig')}</option>
          {[0, 1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <label className="cfg-field">
        <span>{t('Einheit')}</span>
        <input value={config.unit} placeholder={t('z. B. € oder kg')} maxLength={12} onChange={(e) => set({ unit: e.target.value })} />
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
    const target = tables.find((x) => x.id === rel.target)
    return (target?.columns ?? []).map((c) => ({ key: `${rel.id}.${c.id}`, text: `SUMME({{${rel.name}.${c.name}}})` }))
  })
  return (
    <>
      <label className="cfg-field">
        <span>{t('Text mit Platzhaltern')}</span>
        <textarea ref={area} className="formula-input" rows={4} spellCheck={false} value={draft}
          placeholder={t('z. B. {{Vorname}} {{Name}} – {{ {{Führer}} + {{Helfer}} }} Personen')}
          onChange={(e) => setDraft(e.target.value)} onBlur={apply}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); apply() } }} />
      </label>
      {error ? <p className="formula-error" role="alert">{error}</p>
        : <p className="hint formula-help">{t('Alles in')} <code>{'{{ }}'}</code> {t('wird ausgewertet und darf eine ganze Formel sein, z. B.')} <code>{t('{{RUNDEN({{Preis}} * 1.19; 2)}}')}</code>. {t('Funktionen:')} {SHORT_LIST} {t('u. a. (alle in der Hilfe).')}</p>}
      <FormulaHelp template />
      <div className="cfg-field">
        <span>{t('Platzhalter einfügen')}</span>
        <div className="formula-chips">
          {own.map((c) => <button key={c.id} type="button" onClick={() => insert(refName(c.name))}>{c.name}</button>)}
          {paths.map((p) => <button key={p.key} type="button" className="path" onClick={() => insert(`{{${p.text}}}`)}>{p.text}</button>)}
          {own.length + paths.length === 0 && <span className="hint">{t('Keine weiteren Spalten.')}</span>}
        </div>
      </div>
    </>
  )
}
