import type { ReactNode } from 'react'
import { t } from './i18n'

/** Symbole für die Reiter: Linienzeichnungen auf 24×24, die Farbe kommt vom Text (currentColor). */
const ICONS: Record<string, { label: string; draw: ReactNode }> = {
  table: { label: 'Tabelle', draw: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M3 15h18M9 4v16" /></> },
  filter: { label: 'Filter', draw: <path d="M3 5h18l-7 8v6l-4-2v-4z" /> },
  map: { label: 'Karte', draw: <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2zM9 4v14M15 6v14" /> },
  pin: { label: 'Ort', draw: <><path d="M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11z" /><circle cx="12" cy="10" r="2.5" /></> },
  users: { label: 'Personen', draw: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.5 3-6 6.5-6s6.5 2.5 6.5 6M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.3c2 .7 3.5 2.6 3.5 5.7" /></> },
  truck: { label: 'Fahrzeug', draw: <><path d="M2 6h11v10H2zM13 9h4l4 4v3h-8" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="18" r="2" /></> },
  warning: { label: 'Warnung', draw: <path d="M12 3 2 20h20zM12 10v5M12 17.5v.5" /> },
  check: { label: 'Aufgabe', draw: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="m8 12 3 3 5-6" /></> },
  doc: { label: 'Dokument', draw: <path d="M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6" /> },
  chart: { label: 'Diagramm', draw: <><rect x="3" y="11" width="4" height="9" /><rect x="10" y="4" width="4" height="16" /><rect x="17" y="8" width="4" height="12" /></> },
  list: { label: 'Liste', draw: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /> },
  home: { label: 'Gebäude', draw: <path d="M3 11 12 3l9 8M5 10v10h5v-6h4v6h5V10" /> },
  flag: { label: 'Flagge', draw: <path d="M5 21V4M5 4h12l-2 4 2 4H5" /> },
  calendar: { label: 'Kalender', draw: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></> },
  clock: { label: 'Zeit', draw: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></> },
  box: { label: 'Material', draw: <path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5zM3 7.5l9 4.5 9-4.5M12 12v9" /> },
  phone: { label: 'Telefon', draw: <path d="M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2C10 21 3 14 3 5a2 2 0 0 1 2-2z" /> },
  mail: { label: 'Post', draw: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></> },
  camera: { label: 'Foto', draw: <><path d="M3 8h4l2-3h6l2 3h4v12H3z" /><circle cx="12" cy="13" r="3.5" /></> },
  book: { label: 'Buch', draw: <path d="M12 6c-2-1.5-5-2-8-2v14c3 0 6 .5 8 2 2-1.5 5-2 8-2V4c-3 0-6 .5-8 2zM12 6v14" /> },
  shield: { label: 'Schutz', draw: <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" /> },
  flame: { label: 'Feuer', draw: <path d="M12 3c1 4 5 6 5 11a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-4-1-6 1-10z" /> },
  heart: { label: 'Herz', draw: <path d="M12 20s-8-5-8-11a4.5 4.5 0 0 1 8-2.5A4.5 4.5 0 0 1 20 9c0 6-8 11-8 11z" /> },
  star: { label: 'Stern', draw: <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" /> },
}
export const ICON_KEYS = Object.keys(ICONS)
const DEFAULT_ICON = { table: 'table', view: 'filter', map: 'map' } as const

const Svg = ({ name }: { name: string }) => (
  <svg className="sheet-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[name].draw}</svg>
)

/** Symbol eines Blatts: eingebautes Symbol (Schlüssel), sonst Emoji/Text, sonst das Standardsymbol der Art. */
export function SheetIcon({ icon, kind }: { icon?: string; kind: 'table' | 'view' | 'map' }) {
  if (icon && ICONS[icon]) return <Svg name={icon} />
  if (icon) return <span className="sheet-icon emoji" aria-hidden="true">{icon}</span>
  return <Svg name={DEFAULT_ICON[kind]} />
}

/** Auswahl: eingebaute Symbole, dazu ein eigenes Zeichen (z. B. Emoji); leer = Standard der Art. */
export function IconPicker(props: { value: string; kind: 'table' | 'view' | 'map'; onChange: (icon: string) => void }) {
  const custom = props.value && !ICONS[props.value] ? props.value : ''
  return (
    <div className="icon-picker">
      <span className="icon-picker-label">{t('Symbol')}</span>
      <div className="icon-grid" role="radiogroup" aria-label={t('Symbol')}>
        <button type="button" role="radio" aria-checked={!props.value} className={!props.value ? 'on' : ''} title={t('Standard')} onClick={() => props.onChange('')}>
          <SheetIcon kind={props.kind} />
        </button>
        {ICON_KEYS.filter((k) => k !== DEFAULT_ICON[props.kind]).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={props.value === k} className={props.value === k ? 'on' : ''} title={t(ICONS[k].label)} onClick={() => props.onChange(k)}>
            <Svg name={k} />
          </button>
        ))}
        <input className={custom ? 'on' : ''} value={custom} placeholder="🚒" maxLength={4} aria-label={t('Eigenes Zeichen oder Emoji')} title={t('Eigenes Zeichen oder Emoji')}
          onChange={(e) => props.onChange([...e.target.value.trim()].slice(0, 2).join(''))} />
      </div>
    </div>
  )
}
