/**
 * Konto per E-Mail wiederherstellen (Server: server/src/recovery.rs, Hintergrund docs/SYNC.md).
 * Der Server verwahrt nur den mit einem Passwort verschlüsselten Kontotext und gibt ihn erst nach einem E-Mail-Code heraus.
 */
import { exportAccount, importAccount, type Identity } from './identity'
import { authedFetch, normalizeServer } from './syncClient'
import { t } from './i18n'

const fail = async (r: Response, what: string) => {
  const text = (await r.text().catch(() => '')).trim()
  return new Error(text || t('{what}: Server antwortet mit {status}', { what, status: r.status }))
}
const json = { 'Content-Type': 'application/json' }

/** Mindestlänge des Passworts für die Wiederherstellung (wer die E-Mails liest, kann den Text sonst durchprobieren). */
export const MIN_RECOVERY_PASSWORD = 10

/** Schickt einen Code an die Adresse, um sie dem Konto auf diesem Server zuzuordnen. */
export async function requestEmailCode(server: string, email: string): Promise<void> {
  const r = await authedFetch(server, '/me/email', { method: 'POST', headers: json, body: JSON.stringify({ email }) })
  if (!r.ok) throw await fail(r, 'E-Mail')
}

export async function confirmEmailCode(server: string, code: string): Promise<void> {
  const r = await authedFetch(server, '/me/email/confirm', { method: 'POST', headers: json, body: JSON.stringify({ code }) })
  if (!r.ok) throw await fail(r, t('Bestätigung'))
}

export async function removeEmail(server: string): Promise<void> {
  const r = await authedFetch(server, '/me/email', { method: 'DELETE' })
  if (!r.ok) throw await fail(r, t('Entfernen'))
}

/** Legt das Konto, mit diesem Passwort verschlüsselt, beim Server zur Wiederherstellung ab (Adresse muss bestätigt sein). */
export async function storeRecovery(server: string, password: string): Promise<void> {
  if (password.length < MIN_RECOVERY_PASSWORD) throw new Error(t('Das Passwort braucht mindestens {n} Zeichen', { n: MIN_RECOVERY_PASSWORD }))
  const r = await authedFetch(server, '/me/recovery', { method: 'PUT', body: await exportAccount(password) })
  if (!r.ok) throw await fail(r, t('Wiederherstellung'))
}

/** Neues Gerät, Schritt 1: Code an die Adresse schicken lassen (der Server verrät nicht, ob es sie gibt). */
export async function startRecovery(server: string, email: string): Promise<void> {
  const r = await fetch(`${normalizeServer(server)}/recover/start`, { method: 'POST', headers: json, body: JSON.stringify({ email }) })
  if (!r.ok) throw await fail(r, t('Wiederherstellung'))
}

/**
 * Neues Gerät, Schritt 2: Code einlösen. Liefert den verschlüsselten Kontotext. Der Code gilt nur einmal; wer sich bei
 * dem Passwort vertippt, probiert es mit demselben Text noch einmal (`importAccount`), ohne neuen Code.
 */
export async function fetchRecoveryText(server: string, email: string, code: string): Promise<string> {
  const r = await fetch(`${normalizeServer(server)}/recover/finish`, { method: 'POST', headers: json, body: JSON.stringify({ email, code }) })
  if (!r.ok) throw await fail(r, t('Wiederherstellung'))
  return (await r.json()).account
}

/** Schritt 2 und 3 zusammen: Code und Passwort → das Konto ist auf diesem Gerät wieder da. */
export async function finishRecovery(server: string, email: string, code: string, password: string): Promise<Identity> {
  return importAccount(await fetchRecoveryText(server, email, code), password) // wirft bei falschem Passwort
}
