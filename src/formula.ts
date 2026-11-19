/**
 * Formelsprache der Formel-Spalten (angelehnt an Excel): Parser und statische Typbestimmung.
 * Die Auswertung steht in cells.ts, weil sie auf Spalten-Zellwerte zugreift.
 *
 * Beispiele:  [Führer] + [Unterführer] + [Helfer]      SUMME(Gruppen.Führer)      WENN([Helfer] > 10; "viele"; "wenige")
 * Spalten ohne Leerzeichen dürfen ohne Klammern stehen, sonst `[Name der Spalte]`.
 * `Relation.Spalte` greift auf die verknüpften Zeilen zu (nur innerhalb von SUMME, MITTELWERT, MIN, MAX, ANZAHL, TEXTVERBINDEN).
 */
import type { ColType } from './model'

export type Node =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'ref'; parts: string[] }
  | { t: 'un'; op: '-' | '+'; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'call'; fn: string; name: string; args: Node[] }

export class FormulaSyntaxError extends Error {
  constructor(message: string, readonly pos: number) { super(message) }
}

/** Funktionsnamen (englisch und deutsch) → interner Name. */
const ALIASES: Record<string, string> = {
  SUM: 'SUM', SUMME: 'SUM', AVG: 'AVG', AVERAGE: 'AVG', MITTELWERT: 'AVG', MIN: 'MIN', MAX: 'MAX',
  COUNT: 'COUNT', ANZAHL: 'COUNT', JOIN: 'JOIN', TEXTVERBINDEN: 'JOIN',
  IF: 'IF', WENN: 'IF', AND: 'AND', UND: 'AND', OR: 'OR', ODER: 'OR', NOT: 'NOT', NICHT: 'NOT',
  ROUND: 'ROUND', RUNDEN: 'ROUND', ABS: 'ABS', ISEMPTY: 'ISEMPTY', ISTLEER: 'ISEMPTY',
}
export const FUNCTIONS = ['SUMME', 'MITTELWERT', 'MIN', 'MAX', 'ANZAHL', 'TEXTVERBINDEN', 'WENN', 'UND', 'ODER', 'NICHT', 'RUNDEN', 'ABS', 'ISTLEER']
export const canonicalFn = (name: string): string | undefined => ALIASES[name.toUpperCase()]
export const AGGREGATES = new Set(['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'JOIN'])

// ---------- Tokens ----------

interface Tok { k: 'num' | 'str' | 'id' | 'br' | 'op' | 'end'; v: string; pos: number }

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (/\s/.test(ch)) { i++; continue }
    if (/\d/.test(ch)) {
      const m = /^\d+(\.\d+)?/.exec(src.slice(i))!
      out.push({ k: 'num', v: m[0], pos: i }); i += m[0].length; continue
    }
    if (ch === '"') {
      let j = i + 1, s = ''
      for (;;) {
        if (j >= src.length) throw new FormulaSyntaxError('Text ist nicht mit " abgeschlossen', i)
        if (src[j] === '"') { if (src[j + 1] === '"') { s += '"'; j += 2; continue } break }
        s += src[j++]
      }
      out.push({ k: 'str', v: s, pos: i }); i = j + 1; continue
    }
    if (ch === '[') {
      const j = src.indexOf(']', i)
      if (j < 0) throw new FormulaSyntaxError('Spaltenname ist nicht mit ] abgeschlossen', i)
      out.push({ k: 'br', v: src.slice(i + 1, j).trim(), pos: i }); i = j + 1; continue
    }
    const id = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(src.slice(i))
    if (id) { out.push({ k: 'id', v: id[0], pos: i }); i += id[0].length; continue }
    const two = src.slice(i, i + 2)
    if (['<>', '<=', '>='].includes(two)) { out.push({ k: 'op', v: two, pos: i }); i += 2; continue }
    if ('+-*/^&=<>().;,'.includes(ch)) { out.push({ k: 'op', v: ch, pos: i }); i++; continue }
    throw new FormulaSyntaxError(`Unerwartetes Zeichen „${ch}“`, i)
  }
  out.push({ k: 'end', v: '', pos: src.length })
  return out
}

// ---------- Parser ----------

const PREC: Record<string, number> = { '=': 1, '<>': 1, '<': 1, '<=': 1, '>': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 }

export function parseFormula(src: string): Node {
  const toks = tokenize(src)
  let p = 0
  const peek = () => toks[p]
  const isOp = (v: string) => toks[p].k === 'op' && toks[p].v === v
  const fail = (msg: string, t = peek()): never => { throw new FormulaSyntaxError(msg, t.pos) }
  const describe = (t: Tok) => (t.k === 'end' ? 'das Ende der Formel' : `„${t.k === 'str' ? `"${t.v}"` : t.k === 'br' ? `[${t.v}]` : t.v}“`)

  function binary(minPrec: number): Node {
    let left = unary()
    for (;;) {
      const t = peek()
      const prec = t.k === 'op' ? PREC[t.v] : undefined
      if (prec === undefined || prec < minPrec) return left
      p++
      const right = binary(t.v === '^' ? prec : prec + 1) // ^ rechtsassoziativ
      left = { t: 'bin', op: t.v, a: left, b: right }
    }
  }
  function unary(): Node {
    if (isOp('-') || isOp('+')) {
      const op = peek().v as '-' | '+'
      p++
      return { t: 'un', op, a: binary(5) } // −2^2 = −(2^2)
    }
    return primary()
  }
  function part(): string {
    const t = peek()
    if (t.k === 'id' || t.k === 'br') { p++; return t.v }
    return fail(`Nach dem Punkt fehlt ein Spaltenname, gefunden: ${describe(t)}`)
  }
  function primary(): Node {
    const t = peek()
    if (t.k === 'num') { p++; return { t: 'num', v: Number(t.v) } }
    if (t.k === 'str') { p++; return { t: 'str', v: t.v } }
    if (isOp('(')) {
      p++
      const e = binary(1)
      if (!isOp(')')) fail(`Hier fehlt eine schließende Klammer, gefunden: ${describe(peek())}`)
      p++
      return e
    }
    if (t.k === 'id' && toks[p + 1].k === 'op' && toks[p + 1].v === '(') {
      p += 2
      const args: Node[] = []
      if (!isOp(')')) {
        for (;;) {
          args.push(binary(1))
          if (isOp(';') || isOp(',')) { p++; continue }
          break
        }
      }
      if (!isOp(')')) fail(`Hier fehlt eine schließende Klammer, gefunden: ${describe(peek())}`)
      p++
      return { t: 'call', fn: canonicalFn(t.v) ?? '', name: t.v, args }
    }
    if (t.k === 'id' || t.k === 'br') {
      if (t.k === 'id' && /^(true|wahr)$/i.test(t.v)) { p++; return { t: 'bool', v: true } }
      if (t.k === 'id' && /^(false|falsch)$/i.test(t.v)) { p++; return { t: 'bool', v: false } }
      const parts = [part()]
      while (isOp('.')) { p++; parts.push(part()) }
      return { t: 'ref', parts }
    }
    return fail(t.k === 'end' ? 'Die Formel ist unvollständig' : `Unerwartet: ${describe(t)}`)
  }

  if (toks.length === 1) fail('Die Formel ist leer')
  const tree = binary(1)
  if (peek().k !== 'end') fail(`Unerwartet: ${describe(peek())}${peek().v === ',' ? ' (Dezimalzahlen mit Punkt schreiben)' : ''}`)
  return tree
}

// ---------- Typbestimmung ----------

/** Typ der Formel, ohne sie auszuwerten. `typeOfRef` liefert den (effektiven) Typ einer Spalte bzw. eines Pfads. */
export function inferType(n: Node, typeOfRef: (parts: string[]) => ColType | undefined): ColType {
  const asResult = (t: ColType | undefined): ColType => (t === 'number' || t === 'checkbox' ? t : 'text')
  switch (n.t) {
    case 'num': return 'number'
    case 'str': return 'text'
    case 'bool': return 'checkbox'
    case 'ref': return asResult(typeOfRef(n.parts))
    case 'un': return 'number'
    case 'bin':
      if (n.op === '&') return 'text'
      return n.op in PREC && PREC[n.op] === 1 ? 'checkbox' : 'number'
    case 'call':
      switch (n.fn) {
        case 'IF': {
          const a = n.args[1] ? inferType(n.args[1], typeOfRef) : 'text'
          const b = n.args[2] ? inferType(n.args[2], typeOfRef) : a
          return a === b ? a : 'text'
        }
        case 'AND': case 'OR': case 'NOT': case 'ISEMPTY': return 'checkbox'
        case 'JOIN': return 'text'
        default: return 'number' // SUM, AVG, MIN, MAX, COUNT, ROUND, ABS
      }
  }
}
