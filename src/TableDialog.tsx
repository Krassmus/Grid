import { useMemo, useState } from 'react'
import * as Y from 'yjs'
import { renameTable, setColumnHidden, setTableRepr, type TableInfo } from './model'
import { Modal } from './Modal'
import { newCtx } from './cells'
import { NO_TITLE, computeRepr, reprConfig, type AvatarMode } from './repr'
import { TileContent, tileClasses } from './ReprTile'

const AVATAR_LABELS: [AvatarMode, string][] = [
  ['default', 'Standard (Initialen, nur in der Auswahl)'],
  ['none', 'Kein Avatar'],
  ['initial', 'Initialen'],
  ['image', 'Bild aus einer Dateispalte'],
  ['icon', 'Festes Symbol oder Emoji'],
  ['text', 'Symbol aus einer Spalte'],
]

/**
 * Einstellungen einer Tabelle: Name, Darstellung eines Datensatzes in anderen Tabellen (Titel, Untertitel, Avatar)
 * und ausgeblendete Spalten. Einstellungen gelten sofort, der Name wird beim Schließen übernommen.
 */
export function TableDialog(props: {
  doc: Y.Doc
  table: TableInfo
  tables: TableInfo[]
  onDelete: () => void
  onClose: () => void
}) {
  const { doc, table, tables } = props
  const [name, setName] = useState(table.name)
  const cfg = reprConfig(table)
  const set = (key: string, value: string) => setTableRepr(doc, table.id, key, value === '' ? undefined : value)
  const close = () => {
    const n = name.trim()
    if (n && n !== table.name) renameTable(doc, table.id, n)
    props.onClose()
  }

  const valueCols = table.columns.filter((c) => c.type !== 'relation' && c.type !== 'file')
  const fileCols = table.columns.filter((c) => c.type === 'file')
  const hidden = table.columns.filter((c) => c.hidden)
  const preview = useMemo(() => {
    const m = computeRepr(doc, tables, table, newCtx())
    return table.rowIds.slice(0, 3).map((id) => m.get(id)!).filter(Boolean)
  }, [doc, tables, table])

  return (
    <Modal onClose={close}>
      <form className="dialog columndialog tabledialog" onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); close() }}
        onKeyDown={(e) => e.key === 'Escape' && close()}>
        <h3>Tabelle bearbeiten</h3>
        <label className="cfg-field">
          <span>Name</span>
          <input autoFocus value={name} onFocus={(e) => e.target.select()} onChange={(e) => setName(e.target.value)} />
        </label>

        <section className="vd-section">
          <h4>Darstellung eines Datensatzes</h4>
          <p className="hint">So erscheint eine Zeile dieser Tabelle in anderen Tabellen, etwa als verknüpfte Kachel.</p>
          <label className="cfg-field">
            <span>Titel</span>
            <select value={cfg.title} onChange={(e) => set('title', e.target.value)}>
              <option value="">Standard (erste Textspalte)</option>
              <option value={NO_TITLE}>Keiner (nur der Avatar)</option>
              {valueCols.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="cfg-field">
            <span>Untertitel (klein und grau)</span>
            <select value={cfg.sub} onChange={(e) => set('sub', e.target.value)}>
              <option value="">Keiner</option>
              {valueCols.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="cfg-field">
            <span>Avatar</span>
            <select value={cfg.avatar} onChange={(e) => set('avatar', e.target.value)}>
              {AVATAR_LABELS.map(([v, label]) => <option key={v} value={v} disabled={v === 'image' && fileCols.length === 0}>{label}</option>)}
            </select>
          </label>
          {cfg.avatar === 'image' && (
            <label className="cfg-field">
              <span>Dateispalte mit dem Bild</span>
              <select value={cfg.avatarCol} onChange={(e) => set('avatarCol', e.target.value)}>
                <option value="">Spalte wählen …</option>
                {fileCols.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          )}
          {cfg.avatar === 'text' && (
            <label className="cfg-field">
              <span>Spalte mit dem Symbol (z. B. ein Emoji)</span>
              <select value={cfg.avatarCol} onChange={(e) => set('avatarCol', e.target.value)}>
                <option value="">Spalte wählen …</option>
                {valueCols.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          )}
          {cfg.avatar === 'icon' && (
            <label className="cfg-field">
              <span>Symbol</span>
              <input value={cfg.icon} placeholder="z. B. 🚒" maxLength={8} onChange={(e) => set('icon', e.target.value)} />
            </label>
          )}
          <div className="repr-preview" aria-label="Vorschau">
            {preview.length === 0 && <span className="hint">Sobald die Tabelle Zeilen hat, erscheint hier eine Vorschau.</span>}
            {preview.map((r, i) => (
              <div key={i} className={`tile ${tileClasses({ avatarInCells: true, subInCells: true })}`}><TileContent repr={r} /></div>
            ))}
          </div>
        </section>

        {hidden.length > 0 && (
          <section className="vd-section">
            <h4>Ausgeblendete Spalten</h4>
            {hidden.map((c) => (
              <div key={c.id} className="hidden-col">
                <span>{c.name}</span>
                <button type="button" onClick={() => setColumnHidden(doc, table.id, c.id, false)}>Einblenden</button>
              </div>
            ))}
          </section>
        )}

        <div className="actions split">
          <button type="button" className="danger-outline" onClick={props.onDelete}>Löschen …</button>
          <button type="submit" className="primary">Fertig</button>
        </div>
      </form>
    </Modal>
  )
}
