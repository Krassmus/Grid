/** Zusammenfassungen: je Gruppe (abgeleitete Tabellen), über verknüpfte Zeilen (Rollup) und in der Summenzeile. */
import type { AggFn, ColType } from './model'

export function allowedAggs(type: ColType): AggFn[] {
  if (type === 'number') return ['sum', 'min', 'max', 'concat', 'count', 'hide']
  if (type === 'checkbox') return ['sum', 'hide']
  return ['concat', 'min', 'max', 'count', 'hide']
}

export const defaultAgg = (type: ColType): AggFn => (type === 'number' || type === 'checkbox' ? 'sum' : 'concat')

export function aggLabel(type: ColType, fn: AggFn): string {
  if (fn === 'sum') return type === 'checkbox' ? 'Anzahl angehakt' : 'Summe'
  return { min: 'Minimum', max: 'Maximum', concat: 'Verketten', count: 'Anzahl', hide: 'Nicht anzeigen' }[fn]
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
  if (fn === 'sum') return type === 'checkbox' ? 'Angehakt' : 'Summe'
  if (fn === 'percent') return 'Anteil angehakt'
  if (fn === 'min') return type === 'date' ? 'Früheste' : 'Minimum'
  if (fn === 'max') return type === 'date' ? 'Späteste' : 'Maximum'
  return { avg: 'Durchschnitt', count: 'Gefüllt', empty: 'Leer' }[fn]
}
