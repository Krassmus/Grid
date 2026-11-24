import { useMemo, useState } from 'react'
import * as Y from 'yjs'
import { emptyViewDef, type ColumnInfo, type FilterOp, type TableInfo, type ViewDef, type ViewFilter } from './model'
import { IconPicker } from './icons'
import { Modal } from './Modal'
import { effectiveType } from './columnTypes'
import { OPS_BY_TYPE, aggLabel, aggOf, allowedAggs, computeView, opLabel, opNeedsValue } from './viewEngine'
import { t } from './i18n'

/** Neue abgeleitete Tabelle anlegen oder eine vorhandene bearbeiten (Bedingungen, Gruppierung, Zusammenfassung je Spalte). */
export function ViewDialog(props: {
  doc: Y.Doc
  source: TableInfo
  tables: TableInfo[]
  /** Zum Bearbeiten: bisheriger Name und Definition. */
  initial?: { name: string; def: ViewDef; icon?: string }
  onSubmit: (name: string, def: ViewDef, icon: string) => void
  onClose: () => void
}) {
  const { doc, source, tables } = props
  const typeOf = (c: ColumnInfo) => effectiveType(c, tables)
  const [icon, setIcon] = useState(props.initial?.icon ?? '')
  const [name, setName] = useState(props.initial?.name ?? t('{name} – abgeleitet', { name: source.name }))
  const [def, setDef] = useState<ViewDef>(props.initial?.def ?? emptyViewDef(source.id))
  const cols = source.columns
  const colOf = (id: string) => cols.find((c) => c.id === id)
  const result = useMemo(() => computeView(doc, def), [doc, def])

  const setFilter = (i: number, patch: Partial<ViewFilter>) =>
    setDef((d) => ({ ...d, filters: d.filters.map((f, j) => (j === i ? { ...f, ...patch } : f)) }))
  const addFilter = () => {
    const c = cols[0]
    if (!c) return
    setDef((d) => ({ ...d, filters: [...d.filters, { col: c.id, op: OPS_BY_TYPE[typeOf(c)][0], value: '' }] }))
  }
  const changeFilterColumn = (i: number, colId: string) => {
    const c = colOf(colId)!
    const cur = def.filters[i]
    setFilter(i, { col: colId, op: OPS_BY_TYPE[typeOf(c)].includes(cur.op) ? cur.op : OPS_BY_TYPE[typeOf(c)][0], value: '' })
  }
  const groupCol = def.group.mode === 'column' ? colOf(def.group.col ?? '') : undefined
  const setAgg = (c: ColumnInfo, patch: { fn?: string; sep?: string }) =>
    setDef((d) => {
      const cur = aggOf(d, c, tables)
      return { ...d, aggs: { ...d.aggs, [c.id]: { ...cur, ...patch } as any } }
    })

  const valid = name.trim() !== '' && (def.group.mode !== 'column' || !!groupCol)
  const submit = () => { if (valid) props.onSubmit(name.trim(), def, icon) }

  const valueInput = (f: ViewFilter, i: number, c: ColumnInfo) => {
    if (!opNeedsValue(f.op)) return <span />
    if (typeOf(c) === 'select') {
      return (
        <select value={f.value} onChange={(e) => setFilter(i, { value: e.target.value })}>
          <option value="">{t('Option wählen …')}</option>
          {(c.options ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      )
    }
    return (
      <input type={typeOf(c) === 'number' ? 'number' : typeOf(c) === 'date' ? 'date' : 'text'} step="any" value={f.value} placeholder={t('Wert')}
        onChange={(e) => setFilter(i, { value: e.target.value })} />
    )
  }

  return (
    <Modal onClose={props.onClose}>
      <form className="dialog columndialog viewdialog" onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); submit() }}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>{props.initial ? t('Abgeleitete Tabelle bearbeiten') : t('Abgeleitete Tabelle')}</h3>
        <p className="cfg-static">{t('Aus Tabelle:')} <strong>{source.name}</strong> <small>{t('(nur Lesen, aktualisiert sich automatisch)')}</small></p>
        <label className="cfg-field">
          <span>{t('Name')}</span>
          <input autoFocus value={name} onFocus={(e) => e.target.select()} onChange={(e) => setName(e.target.value)} />
        </label>
        <IconPicker value={icon} kind="view" onChange={setIcon} />

        <section className="vd-section">
          <h4>{t('Bedingungen')}</h4>
          {def.filters.length > 1 && (
            <select value={def.match} onChange={(e) => setDef({ ...def, match: e.target.value as 'all' | 'any' })}>
              <option value="all">{t('Alle Bedingungen müssen zutreffen')}</option>
              <option value="any">{t('Mindestens eine Bedingung muss zutreffen')}</option>
            </select>
          )}
          {def.filters.map((f, i) => {
            const c = colOf(f.col)
            return (
              <div key={i} className="vd-filter">
                <select value={f.col} onChange={(e) => changeFilterColumn(i, e.target.value)}>
                  {!c && <option value={f.col}>{t('(Spalte gelöscht)')}</option>}
                  {cols.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
                {c ? (
                  <select value={f.op} onChange={(e) => setFilter(i, { op: e.target.value as FilterOp })}>
                    {OPS_BY_TYPE[typeOf(c)].map((op) => <option key={op} value={op}>{opLabel(typeOf(c), op)}</option>)}
                  </select>
                ) : <span />}
                {c ? valueInput(f, i, c) : <span />}
                <button type="button" className="del" title={t('Bedingung entfernen')}
                  onClick={() => setDef((d) => ({ ...d, filters: d.filters.filter((_, j) => j !== i) }))}>✕</button>
              </div>
            )
          })}
          {def.filters.length === 0 && <p className="hint">{t('Keine Bedingung: alle Zeilen der Tabelle.')}</p>}
          <button type="button" className="vd-add" onClick={addFilter}>{t('+ Bedingung')}</button>
        </section>

        <section className="vd-section">
          <h4>{t('Gruppierung')}</h4>
          <select value={def.group.mode}
            onChange={(e) => {
              const mode = e.target.value as ViewDef['group']['mode']
              setDef({ ...def, group: { mode, col: mode === 'column' ? def.group.col ?? cols[0]?.id : undefined } })
            }}>
            <option value="none">{t('Keine (jede Zeile bleibt eine Zeile)')}</option>
            <option value="column">{t('Nach dem Wert einer Spalte')}</option>
            <option value="all">{t('Ganze Tabelle in eine Zeile')}</option>
          </select>
          {def.group.mode === 'column' && (
            <select value={def.group.col ?? ''} onChange={(e) => setDef({ ...def, group: { mode: 'column', col: e.target.value } })}>
              {cols.map((x) => <option key={x.id} value={x.id}>{t('Gruppieren nach „{name}“', { name: x.name })}</option>)}
            </select>
          )}
          {def.group.mode !== 'none' && (
            <div className="vd-aggs">
              <p className="hint">{t('Was soll pro Gruppe aus den übrigen Spalten werden?')}</p>
              {cols.filter((c) => c !== groupCol).map((c) => {
                const a = aggOf(def, c, tables)
                const ct = typeOf(c)
                return (
                  <div key={c.id} className="vd-agg">
                    <span title={c.name}>{c.name}</span>
                    <select value={a.fn} onChange={(e) => setAgg(c, { fn: e.target.value })}>
                      {allowedAggs(ct).map((fn) => <option key={fn} value={fn}>{aggLabel(ct, fn)}</option>)}
                    </select>
                    {a.fn === 'concat'
                      ? <input value={a.sep ?? ', '} maxLength={12} title={t('Trennzeichen')} aria-label={t('Trennzeichen für {name}', { name: c.name })} onChange={(e) => setAgg(c, { sep: e.target.value })} />
                      : <span />}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        <p className="cfg-static">{t('Ergebnis:')} <strong>{result.rows.length}</strong> {t(result.rows.length === 1 ? 'Zeile' : 'Zeilen')}</p>
        <div className="actions">
          <button type="button" onClick={props.onClose}>{t('Abbrechen')}</button>
          <button type="submit" className="primary" disabled={!valid}>{props.initial ? t('Speichern') : t('Anlegen')}</button>
        </div>
      </form>
    </Modal>
  )
}
