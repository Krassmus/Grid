import { Fragment, useState } from 'react'
import { Modal, ConfirmDialog } from './Modal'
import type { Level } from './adminLog'
import type { GroupChange } from './members'
import type { MembersControl } from './MembersDialog'
import { t } from './i18n'

const message = (e: unknown) => String((e as Error).message ?? e)

/**
 * Gruppen und Rechte (nur Admins, docs/RIGHTS.md): Gruppen anlegen, Mitglieder zuordnen und je Tabelle,
 * abgeleiteter Tabelle und Karte „kein Zugriff“, „lesen“ oder „schreiben“ festlegen.
 */
export function GroupsDialog(props: { control: MembersControl; onClose: () => void }) {
  const { members, objects = [] } = props.control
  const state = members?.state
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  // Tabellen, bei denen die Spaltenliste offen ist („Spaltenweise“ gewählt), je Gruppe
  const [byColumn, setByColumn] = useState<Record<string, true>>({})
  const act = async (changes: GroupChange[]) => {
    setBusy(true); setError(null)
    try { await props.control.changeGroups(changes) } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  if (!state) return null
  const groups = [...state.groups.entries()]
  const people = [...state.members.entries()].filter(([, m]) => m.role !== 'admin')
  const who = (account: string) => props.control.profiles?.[account]?.name || state.members.get(account)?.name || t('Ohne Namen')
  const add = () => {
    const n = name.trim()
    if (!n) return
    setName('')
    void act([{ type: 'group', group: crypto.randomUUID(), name: n }])
  }
  const levelOf = (g: string, id: string): Level => state.grants.get(g)?.get(id) ?? 'none'
  const grantedColumns = (g: string, o: NonNullable<typeof objects>[number]) => (o.columns ?? []).filter((c) => levelOf(g, c.id) !== 'none')
  /** Auswahl einer Tabelle: Stufe, oder „Spaltenweise“ (kein Tabellenrecht, aber Rechte an Spalten oder Liste geöffnet). */
  const modeOf = (g: string, o: NonNullable<typeof objects>[number]): Level | 'columns' =>
    o.kind === 'table' && levelOf(g, o.id) === 'none' && (grantedColumns(g, o).length > 0 || byColumn[`${g}|${o.id}`]) ? 'columns' : levelOf(g, o.id)
  const choose = (g: string, o: NonNullable<typeof objects>[number], v: string) => {
    const key = `${g}|${o.id}`
    if (v === 'columns') {
      setByColumn((s) => ({ ...s, [key]: true }))
      // Das Recht an der ganzen Tabelle entfällt: ab jetzt zählen nur die Spalten
      if (levelOf(g, o.id) !== 'none') void act([{ type: 'grant', group: g, object: o.id, level: 'none' }])
      return
    }
    setByColumn((s) => { const { [key]: _gone, ...rest } = s; return rest })
    // Wer die ganze Tabelle bekommt oder verliert, braucht keine Spaltenrechte mehr
    void act([...grantedColumns(g, o).map((c) => ({ type: 'grant' as const, group: g, object: c.id, level: 'none' as Level })), { type: 'grant', group: g, object: o.id, level: v as Level }])
  }
  const kindLabel = (k: 'table' | 'view' | 'map') => (k === 'table' ? t('Tabelle') : k === 'view' ? t('Abgeleitete Tabelle') : t('Karte'))
  return (
    <Modal onClose={props.onClose}>
      <div className="dialog sync-dialog members-dialog cloud-dialog groups-dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>{t('Gruppen und Rechte')}</h3>
        <p className="cloud-lead">
          {groups.length === 0
            ? t('Noch gibt es keine Gruppen: alle Mitglieder dürfen alles. Mit der ersten Gruppe beginnt die Rechteverwaltung. Dann dürfen Mitglieder nur noch, was ihre Gruppen erlauben, und die Struktur (Tabellen, Spalten, Relationen, Karten) ändern nur Admins.')
            : t('Rechte vergibst du an Gruppen. Wer in mehreren Gruppen ist, hat je Tabelle die höchste Stufe. Admins dürfen immer alles. Wer in keiner Gruppe ist, sieht nichts.')}
        </p>
        {groups.map(([id, gname]) => (
          <details key={id} className="group-card">
            <summary><strong>{gname}</strong> <small>{t('{people} · {tables}', {
              people: [...state.memberGroups.entries()].filter(([, s]) => s.has(id)).length === 1 ? t('1 Person') : t('{n} Personen', { n: [...state.memberGroups.entries()].filter(([, s]) => s.has(id)).length }),
              tables: t('{n} mit Zugriff', { n: objects.filter((o) => levelOf(id, o.id) !== 'none' || grantedColumns(id, o).length > 0).length }),
            })}</small></summary>
            <div className="group-body">
              <label className="cfg-field">
                <span>{t('Name')}</span>
                <input defaultValue={gname} maxLength={60} disabled={busy}
                  onBlur={(e) => { const n = e.target.value.trim(); if (n && n !== gname) void act([{ type: 'group', group: id, name: n }]); else e.target.value = gname }} />
              </label>
              <h4>{t('Mitglieder der Gruppe')}</h4>
              {people.length === 0 && <p className="hint">{t('Noch keine Mitglieder außer den Admins.')}</p>}
              {people.map(([account]) => {
                const on = !!state.memberGroups.get(account)?.has(id)
                return (
                  <label key={account} className="check">
                    <input type="checkbox" checked={on} disabled={busy} onChange={() => void act([{ type: on ? 'leave-group' : 'join-group', group: id, account }])} /> {who(account)}
                  </label>
                )
              })}
              <h4>{t('Zugriff')}</h4>
              {objects.length === 0 && <p className="hint">{t('Noch keine Tabellen.')}</p>}
              <table className="rights-table">
                <tbody>
                  {objects.map((o) => {
                    const mode = modeOf(id, o)
                    return (
                      <Fragment key={o.id}>
                        <tr>
                          <td><strong>{o.name}</strong> <small>{kindLabel(o.kind)}</small>{o.kind === 'view' && o.blocked && <small className="hint" style={{ display: 'block' }}>{o.blocked}</small>}</td>
                          <td>
                            <select value={mode} disabled={busy} aria-label={t('Zugriff auf {name}', { name: o.name })} onChange={(e) => choose(id, o, e.target.value)}>
                              <option value="none">{t('Kein Zugriff')}</option>
                              <option value="read">{t('Lesen')}</option>
                              {(o.kind !== 'view' || !o.blocked) && <option value="write">{t('Schreiben')}</option>}
                              {o.kind === 'table' && <option value="columns">{t('Spaltenweise')}</option>}
                            </select>
                          </td>
                        </tr>
                        {mode === 'columns' && (o.columns ?? []).map((c) => (
                          <tr key={c.id} className="col-right">
                            <td><small>{c.name}</small></td>
                            <td>
                              <select value={levelOf(id, c.id)} disabled={busy} aria-label={t('Zugriff auf Spalte {name}', { name: c.name })}
                                onChange={(e) => void act([{ type: 'grant', group: id, object: c.id, level: e.target.value as Level }])}>
                                <option value="none">{t('Kein Zugriff')}</option>
                                <option value="read">{t('Lesen')}</option>
                                {!c.readOnly && <option value="write">{t('Schreiben')}</option>}
                              </select>
                            </td>
                          </tr>
                        ))}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
              <div className="actions"><button type="button" className="danger-outline" disabled={busy} onClick={() => setDeleting(id)}>{t('Gruppe löschen …')}</button></div>
            </div>
          </details>
        ))}
        <form className="group-add" onSubmit={(e) => { e.preventDefault(); add() }}>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={t('Neue Gruppe, z. B. Redaktion')} aria-label={t('Name der neuen Gruppe')} disabled={busy} />
          <button type="submit" className="primary" disabled={busy || !name.trim()}>{t('+ Gruppe')}</button>
        </form>
        {error && <p className="sync-error" role="alert">{error}</p>}
        <div className="actions"><button type="button" className="primary" onClick={props.onClose}>{t('Fertig')}</button></div>
        {deleting && (
          <ConfirmDialog detail={t('Gruppe „{name}“. Ihre Mitglieder verlieren die Rechte, die nur sie ihnen gab.', { name: state.groups.get(deleting) ?? '' })}
            onCancel={() => setDeleting(null)} onConfirm={() => { const g = deleting; setDeleting(null); void act([{ type: 'ungroup', group: g }]) }} />
        )}
      </div>
    </Modal>
  )
}
