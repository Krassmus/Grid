import { useState } from 'react'
import * as Y from 'yjs'
import { renameColumn, setColumnConfig, setColumnHidden, type ColumnInfo, type TableInfo } from './model'
import { columnTypeOf } from './columnTypes'
import { Modal } from './Modal'
import { OptionsEditor } from './SelectCell'

/**
 * Konfiguration einer Spalte. Der Typ ist nur zur Information sichtbar (nicht änderbar), die ID bleibt beim Umbenennen gleich.
 * Einstellungen des Typs gelten sofort, der Name wird beim Schließen übernommen.
 */
export function ColumnDialog(props: {
  doc: Y.Doc
  table: TableInfo
  tables: TableInfo[]
  column: ColumnInfo
  onDelete: () => void
  onClose: () => void
}) {
  const { doc, table, tables, column } = props
  const type = columnTypeOf(column.type)
  const config = type.config(column)
  const [name, setName] = useState(column.name)
  const [options, setOptions] = useState(false)

  const set = (patch: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(patch)) {
      // Standardwerte werden nicht gespeichert, damit spätere Änderungen der Standards greifen.
      setColumnConfig(doc, table.id, column.id, key, value === type.defaults[key] ? undefined : value)
    }
  }
  const close = () => {
    const n = name.trim()
    if (n && n !== column.name) renameColumn(doc, table.id, column.id, n)
    props.onClose()
  }

  return (
    <Modal onClose={close}>
      <form className="dialog columndialog" onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); close() }}
        onKeyDown={(e) => e.key === 'Escape' && !options && close()}>
        <h3>Spalte konfigurieren</h3>
        <label className="cfg-field">
          <span>Name</span>
          <input autoFocus value={name} onFocus={(e) => e.target.select()} onChange={(e) => setName(e.target.value)} />
        </label>
        <p className="cfg-static">Typ: <strong>{type.label}</strong> <small>(lässt sich nicht ändern)</small></p>
        {type.renderConfig({ doc, table, tables, column, config, set, editOptions: () => setOptions(true) })}
        <label className="cfg-check">
          <input type="checkbox" checked={!!column.hidden} onChange={(e) => setColumnHidden(doc, table.id, column.id, e.target.checked)} />
          <span>In der Tabelle ausblenden<small>Die Spalte bleibt für Formeln und die Darstellung nutzbar. Einblenden: Menü der Tabelle → Bearbeiten.</small></span>
        </label>
        <div className="actions split">
          <button type="button" className="danger-outline" onClick={props.onDelete}>Löschen …</button>
          <button type="submit" className="primary">Fertig</button>
        </div>
        {options && <OptionsEditor doc={doc} tableId={table.id} col={column} onClose={() => setOptions(false)} />}
      </form>
    </Modal>
  )
}
