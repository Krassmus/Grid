/** Zusammenfassungen: je Gruppe (abgeleitete Tabellen), über verknüpfte Zeilen (Rollup) und in der Summenzeile. */
import type { AggFn, ColType } from './model'
import { t } from './i18n'

export function allowedAggs(type: ColType): AggFn[] {
  if (type === 'number') return ['sum', 'min', 'max', 'concat', 'count', 'hide']
  if (type === 'checkbox') return ['sum', 'hide']
  return ['concat', 'min', 'max', 'count', 'hide']
}

export const defaultAgg = (type: ColType): AggFn => (type === 'number' || type === 'checkbox' ? 'sum' : 'concat')

export function aggLabel(type: ColType, fn: AggFn): string {
  if (fn === 'sum') return type === 'checkbox' ? t('Anzahl angehakt') : t('Summe')
  return { min: t('Minimum'), max: t('Maximum'), concat: t('Verketten'), count: t('Anzahl'), hide: t('Nicht anzeigen') }[fn]
}

/** Auswertungen der Summenzeile unter einer Tabelle. */
export type FooterFn = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'empty' | 'percent'

export function allowedFooters(type: ColType): FooterFn[] {
  if (type === 'number') return ['sum', 'avg', 'min', 'max', 'count', 'empty']
  if (type === 'checkbox') return ['sum', 'percent']
  if (type === 'date') return ['min', 'max', 'count', 'empty']
  return ['count', 'empty']
}

export function footerLabel(type: ColType, fn: FooterFn): string {
  if (fn === 'sum') return type === 'checkbox' ? t('Angehakt') : t('Summe')
  if (fn === 'percent') return t('Anteil angehakt')
  if (fn === 'min') return type === 'date' ? t('Früheste') : t('Minimum')
  if (fn === 'max') return type === 'date' ? t('Späteste') : t('Maximum')
  return { avg: t('Durchschnitt'), count: t('Gefüllt'), empty: t('Leer') }[fn]
}
