/**
 * In-App-Kauf über den App Store (nur iPad/iPhone; Plugin src-tauri/plugins/tauri-plugin-iap, Swift/StoreKit 2).
 * Apple signiert jede Transaktion; Grid reicht den Beleg unverändert an den Server, der die Signatur selbst prüft.
 * Hintergrund: docs/SYNC.md, Abschnitt „In-App-Kauf“.
 */
import { invoke } from '@tauri-apps/api/core'
import { getIdentity } from './identity'
import { isIOS } from './platform'
import { authedFetch } from './syncClient'
import { t } from './i18n'

export interface StoreProduct { id: string; name: string; description: string; price: string; period: string }
export type PurchaseResult = 'success' | 'pending' | 'cancelled'

// Nur für Bildschirmfotos im Simulator (z. B. für Apples Prüfung): `VITE_MOCK_IAP=1 tauri ios build …` zeigt Beispielangebote.
// In der ausgelieferten App ist der Schalter nicht gesetzt und dieser Code wird beim Bauen entfernt.
const MOCK = import.meta.env.VITE_MOCK_IAP === '1'
const MOCK_PRODUCTS: Record<string, Omit<StoreProduct, 'id'>> = {
  'eu.townwork.grid.cloud.monthly': { name: 'Grid Cloud – monatlich', description: '', price: '2,99 €', period: 'P1M' },
  'eu.townwork.grid.cloud.yearly': { name: 'Grid Cloud – jährlich', description: '', price: '24,99 €', period: 'P1Y' },
}

/** Nur für Bildschirmfotos: Server, der im Cloud-Dialog vorausgefüllt wird (sonst leer). */
export const MOCK_SERVER = MOCK ? 'http://localhost:8794' : ''

/** Gibt es hier einen App Store zum Kaufen? */
export const iapAvailable = isIOS || MOCK

export async function loadProducts(ids: string[]): Promise<StoreProduct[]> {
  if (!iapAvailable || !ids.length) return []
  if (MOCK) return ids.filter((id) => MOCK_PRODUCTS[id]).map((id) => ({ id, ...MOCK_PRODUCTS[id] }))
  const r = await invoke<{ products: StoreProduct[] }>('plugin:iap|products', { payload: { ids } })
  return r.products
}

/** Meldet dem Server einen von Apple signierten Beleg. Wirft mit der Begründung des Servers, falls er ihn nicht annimmt. */
async function submit(server: string, jws: string): Promise<void> {
  const r = await authedFetch(server, '/billing/apple/transaction', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jws }) })
  if (!r.ok) throw new Error((await r.text().catch(() => '')).trim() || t('Server antwortet mit {status}', { status: r.status }))
}

/** Kauft ein Produkt für das Grid-Konto dieses Geräts und meldet es dem Server. */
export async function buy(server: string, productId: string): Promise<PurchaseResult> {
  const me = await getIdentity()
  const r = await invoke<{ status: PurchaseResult; jws?: string }>('plugin:iap|purchase', { payload: { productId, accountToken: me.id } })
  if (r.status === 'success' && r.jws) await submit(server, r.jws)
  return r.status
}

/**
 * Meldet dem Server alle gerade gültigen Käufe dieses Apple-Kontos (Verlängerungen, Käufe auf einem anderen Gerät).
 * Mit `restore` fragt es vorher beim App Store nach („Käufe wiederherstellen“). Gibt zurück, wie viele der Server angenommen hat.
 */
export async function syncPurchases(server: string, restore = false): Promise<number> {
  if (!iapAvailable) return 0
  const r = await invoke<{ transactions: string[] }>(restore ? 'plugin:iap|restore' : 'plugin:iap|current')
  let accepted = 0
  for (const jws of r.transactions) {
    try { await submit(server, jws); accepted++ } catch { /* gehört zu einem anderen Konto oder Produkt: überspringen */ }
  }
  return accepted
}
