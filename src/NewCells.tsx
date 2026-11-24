/** Zellen für Person, Link und Dauer (Zeitstempel sind nur lesbar und stehen wie die Autonummer in der Tabelle). */
import { useEffect, useMemo, useState } from 'react'
import * as Y from 'yjs'
import { Avatar } from './Avatar'
import { DURATION, LINK, PERSON } from './columnTypes'
import { formatDuration, parseDuration } from './duration'
import { openExternal } from './externalLink'
import { getIdentity } from './identity'
import { linkHref } from './link'
import { Modal } from './Modal'
import { personIds, personName, setCell, type ColumnInfo } from './model'
import { getProfile } from './profile'
import { useProfiles } from './useTables'
import { t } from './i18n'

// ---------- Link ----------

export function LinkInput({ doc, table, rowId, col, value }: { doc: Y.Doc; table: string; rowId: string; col: ColumnInfo; value: unknown }) {
  const kind = LINK.config(col).kind
  const text = typeof value === 'string' ? value : ''
  const href = linkHref(kind, text)
  return (
    <div className="c link-cell">
      <input className="cell" type="text" enterKeyHint="next" value={text} placeholder={col.name} spellCheck={false} autoCapitalize="off" autoCorrect="off"
        inputMode={kind === 'email' ? 'email' : kind === 'phone' ? 'tel' : 'url'}
        onChange={(e) => setCell(doc, table, rowId, col.id, e.target.value)} />
      {href && (
        <button type="button" className="link-open" title={kind === 'email' ? t('E-Mail schreiben') : kind === 'phone' ? t('Anrufen') : t('Öffnen')} tabIndex={-1}
          onClick={() => void openExternal(href)}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
        </button>
      )}
    </div>
  )
}

// ---------- Dauer ----------

export function DurationInput({ doc, table, rowId, col, value }: { doc: Y.Doc; table: string; rowId: string; col: ColumnInfo; value: unknown }) {
  const fmt = DURATION.config(col).format
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? (typeof value === 'number' ? formatDuration(value, fmt) : '')
  const parsed = draft === null || draft.trim() === '' ? undefined : parseDuration(draft)
  const invalid = draft !== null && draft.trim() !== '' && parsed === null
  const change = (v: string) => {
    setDraft(v)
    if (v.trim() === '') setCell(doc, table, rowId, col.id, null)
    else { const p = parseDuration(v); if (p !== null) setCell(doc, table, rowId, col.id, p) }
  }
  return (
    <div className="c">
      <input className={`cell${invalid ? ' invalid' : ''}`} type="text" enterKeyHint="next" inputMode="text" value={shown} placeholder={col.name} spellCheck={false}
        title={invalid ? t('Bitte so eingeben: 1:30, 90m oder 1,5 h') : undefined}
        onChange={(e) => change(e.target.value)} onBlur={() => setDraft(null)} />
    </div>
  )
}

// ---------- Person ----------

export interface Person { id: string; name: string; avatar: string }

/** Auswahl: alle Konten mit Profil im Dokument, dazu das eigene Konto (auch in einem Dokument, das nicht in der Cloud liegt). */
export function usePeople(doc: Y.Doc, extra: string[] = []): Person[] {
  const profiles = useProfiles(doc)
  const [me, setMe] = useState('')
  useEffect(() => { void getIdentity().then((i) => setMe(i.id)).catch(() => {}) }, [])
  const extraKey = extra.join(',')
  return useMemo(() => {
    const map = new Map<string, Person>()
    for (const [id, p] of Object.entries(profiles)) map.set(id, { id, name: p.name, avatar: p.avatar })
    if (me) {
      const mine = getProfile()
      const cur = map.get(me)
      map.set(me, { id: me, name: cur?.name || mine.name, avatar: cur?.avatar || mine.avatar })
    }
    for (const id of extra) if (!map.has(id)) map.set(id, { id, name: '', avatar: '' })
    const collator = new Intl.Collator('de', { sensitivity: 'base' })
    return [...map.values()].sort((a, b) => collator.compare(a.name || '￿', b.name || '￿'))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles, me, extraKey])
}

const labelOf = (p: Person, me: string) => p.name || (p.id === me ? t('Ich') : t('Unbekannt'))

export function PersonCell({ doc, table, rowId, col, value }: { doc: Y.Doc; table: string; rowId: string; col: ColumnInfo; value: unknown }) {
  const multi = PERSON.config(col).multi
  const ids = personIds(value)
  const people = usePeople(doc, ids)
  const [open, setOpen] = useState(false)
  const chosen = ids.map((id) => people.find((p) => p.id === id)!).filter(Boolean)
  const set = (next: string[]) => setCell(doc, table, rowId, col.id, next.length ? next.join(',') : null)
  const toggle = (id: string) => {
    if (!multi) { set(ids[0] === id ? [] : [id]); setOpen(false); return }
    set(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])
  }
  return (
    <div className="c person-cell">
      <button type="button" className="person-btn" title={col.name} onClick={() => setOpen(true)}>
        {chosen.length === 0
          ? <span className="select-empty">{t('Person wählen …')}</span>
          : chosen.map((p) => (
              <span key={p.id} className="person-chip"><Avatar name={p.name || '?'} avatar={p.avatar} size={20} /><span>{labelOf(p, '')}</span></span>
            ))}
      </button>
      {open && (
        <Modal onClose={() => setOpen(false)}>
          <div className="dialog picker person-picker" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
            <h3>{col.name}</h3>
            <p className="hint">{multi ? t('Eine oder mehrere Personen wählen.') : t('Eine Person wählen.')}</p>
            <div className="picker-list" role={multi ? 'group' : 'radiogroup'}>
              {people.map((p) => (
                <button key={p.id} type="button" className={`person-row${ids.includes(p.id) ? ' on' : ''}`} role={multi ? 'checkbox' : 'radio'} aria-checked={ids.includes(p.id)} onClick={() => toggle(p.id)}>
                  <Avatar name={p.name || '?'} avatar={p.avatar} size={28} />
                  <span>{labelOf(p, '')}</span>
                  <i className={`pick-mark${ids.includes(p.id) ? ' on' : ''}`} aria-hidden />
                </button>
              ))}
              {people.length === 0 && <p className="hint">{t('Noch keine Personen. Sobald jemand das Dokument öffnet, erscheint sie oder er hier.')}</p>}
            </div>
            <div className="actions split">
              {ids.length > 0 ? <button type="button" onClick={() => { set([]); setOpen(false) }}>{t('Niemand')}</button> : <span />}
              <button type="button" className="primary" onClick={() => setOpen(false)}>{t('Fertig')}</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

/** Kurzer Text für die Anzeige in Formularen o. Ä. */
export const peopleText = (doc: Y.Doc, v: unknown) => personIds(v).map((id) => personName(doc, id) || t('Unbekannt')).join(', ')

/** Dauer im Formular: Eingabetext, solange getippt wird; gespeichert wird die gelesene Dauer in Sekunden. */
export function DurationField(props: { value: unknown; format: 'hm' | 'hms'; autoFocus?: boolean; onChange: (seconds: number | null) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? (typeof props.value === 'number' ? formatDuration(props.value, props.format) : '')
  const invalid = draft !== null && draft.trim() !== '' && parseDuration(draft) === null
  return (
    <>
      <input autoFocus={props.autoFocus} className={invalid ? 'invalid' : undefined} type="text" value={shown} spellCheck={false} placeholder={t('z. B. 1:30')}
        onChange={(e) => { const v = e.target.value; setDraft(v); props.onChange(v.trim() === '' ? null : parseDuration(v)) }}
        onBlur={() => setDraft(null)} />
      {invalid && <small className="rf-error">{t('Bitte so eingeben: 1:30, 90m oder 1,5 h')}</small>}
    </>
  )
}

/** Personen im Formular: Auswahlfeld (eine Person) oder Liste mit Häkchen (mehrere). */
export function PersonField(props: { doc: Y.Doc; multi: boolean; ids: string[]; onChange: (ids: string[]) => void }) {
  const people = usePeople(props.doc, props.ids)
  if (!props.multi) {
    return (
      <select value={props.ids[0] ?? ''} onChange={(e) => props.onChange(e.target.value ? [e.target.value] : [])}>
        <option value="">–</option>
        {people.map((p) => <option key={p.id} value={p.id}>{p.name || t('Unbekannt')}</option>)}
      </select>
    )
  }
  return (
    <div className="person-checks">
      {people.map((p) => (
        <label key={p.id} className="cfg-check">
          <input type="checkbox" checked={props.ids.includes(p.id)} onChange={(e) => props.onChange(e.target.checked ? [...props.ids, p.id] : props.ids.filter((x) => x !== p.id))} />
          <span>{p.name || t('Unbekannt')}</span>
        </label>
      ))}
    </div>
  )
}
