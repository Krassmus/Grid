import { useEffect, useRef, useState } from 'react'
import { Modal } from './Modal'
import { exportAccount, fingerprint, getIdentity, importAccount, onIdentityChanged, type Identity } from './identity'
import { AuthError, fetchAccountInfo, fetchServerInfo, listCloudDocs, normalizeServer, type AccountInfo, type CloudDoc, type ServerInfo, type SyncState } from './syncClient'
import { MembersDialog, type MembersControl } from './MembersDialog'
import { openExternal } from './externalLink'
import { MOCK_SERVER, buy, iapAvailable, loadProducts, syncPurchases, type StoreProduct } from './iap'

const LAST = 'grid-sync-last-server'
export const lastServer = () => { try { return localStorage.getItem(LAST) ?? MOCK_SERVER } catch { return MOCK_SERVER } }
export const rememberServer = (s: string) => { try { localStorage.setItem(LAST, s) } catch { /* egal */ } }

/** Was die Oberfläche über die Cloud-Anbindung des Dokuments wissen und tun darf. */
export interface SyncControl extends MembersControl {
  state: SyncState | null
  server: string | null
  /** Dokument ist Ende-zu-Ende-verschlüsselt (steht fest, solange es besteht) */
  enc: boolean
  connect: (server: string, enc?: boolean) => void
  /** Als Admin ein unverschlüsseltes Dokument verschlüsseln (siehe docs/E2E.md) */
  encryptDocument: () => Promise<void>
  disconnect: () => void
  /** Dem Schlüssel vertrauen, den der Server jetzt zeigt (nach einer Warnung) */
  trustServer: () => void
  /** Dokument auf einen anderen Server umziehen (kündigt es den Mitgliedern an) */
  moveTo: (server: string) => Promise<void>
  /** Ein Admin hat einen Umzug angekündigt, dem dieses Gerät noch nicht gefolgt ist */
  moved: { server: string; key: string } | null
  followMove: () => void
  /** Zustand mit dem Server neu abgleichen */
  resync: () => void
}

export const syncLabel = (c: SyncControl) => {
  if (!c.server) return 'Nicht synchronisiert'
  switch (c.state?.status) {
    case 'online': return c.state.readonly ? 'Nur lesen' : 'Synchronisiert'
    case 'offline': return 'Offline – wird später abgeglichen'
    case 'pending': return c.state.kind === 'keys' ? 'Wartet auf den Dokumentschlüssel' : c.state.kind === 'join' ? 'Wartet auf Zustimmung eines Admins' : c.state.kind === 'claim' ? 'Dokument ist hier noch nicht angelegt' : 'Wartet auf Freigabe des Kontos'
    case 'denied': return c.state.kind === 'untrusted' ? 'Server hat einen anderen Schlüssel' : `Abgelehnt: ${c.state.reason ?? 'kein Zugriff'}`
    default: return 'Verbinde …'
  }
}

/** Das Konto dieses Geräts (wird beim ersten Mal angelegt). */
function useAccount(): Identity | null {
  const [me, setMe] = useState<Identity | null>(null)
  useEffect(() => {
    let alive = true
    const load = () => void getIdentity().then((i) => alive && setMe(i)).catch(() => {})
    load()
    const off = onIdentityChanged(load)
    return () => { alive = false; off() }
  }, [])
  return me
}

const GB = 1e9
const fmtSize = (b: number) => (b >= GB ? `${(b / GB).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.round(b / 1e3)} KB`).replace('.', ',')

/** Angaben des Servers (Name, Schlüssel) für die Anzeige; `null`, solange sie fehlen. */
function useServerInfo(server: string | null): ServerInfo | null {
  const [info, setInfo] = useState<ServerInfo | null>(null)
  useEffect(() => {
    if (!server) { setInfo(null); return }
    let alive = true
    fetchServerInfo(server).then((i) => alive && setInfo(i)).catch(() => alive && setInfo(null))
    return () => { alive = false }
  }, [server])
  return info
}

const hostOf = (url: string) => { try { return new URL(url).host } catch { return url } }

const PERIOD: Record<string, string> = { P1W: 'pro Woche', P1M: 'pro Monat', P3M: 'alle 3 Monate', P6M: 'alle 6 Monate', P1Y: 'pro Jahr' }

/** Abo und Speicher des Kontos (nur auf Servern mit Abo-Pflicht). Auf dem iPad kauft man direkt im App Store. */
function PlanLine(props: { server: string; refresh: unknown; onActive: () => void }) {
  const [info, setInfo] = useState<AccountInfo | null>(null)
  const [products, setProducts] = useState<StoreProduct[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const wasActive = useRef<boolean | null>(null)
  const load = () => fetchAccountInfo(props.server).then((i) => {
    if (wasActive.current === false && i.active) props.onActive() // Abo ist gerade aktiv geworden: aufgelaufene Änderungen hochladen
    wasActive.current = i.active
    setInfo(i)
    return i
  })
  useEffect(() => {
    let alive = true
    const go = () => load().catch(() => alive && setInfo(null))
    void go()
    // Ohne Abo gelegentlich nachsehen (Kauf auf einem anderen Weg, Freischaltung durch den Betreiber)
    const timer = setInterval(() => { if (wasActive.current === false) void go() }, 10_000)
    return () => { alive = false; clearInterval(timer) }
  }, [props.server, props.refresh])
  const appStore = iapAvailable && !!info?.iap
  const ids = info?.iap?.products.map((p) => p.id).join(',') ?? ''
  useEffect(() => {
    if (!appStore || info?.active) return
    let alive = true
    loadProducts(ids.split(',')).then((p) => alive && setProducts(p), () => alive && setProducts([]))
    return () => { alive = false }
  }, [appStore, ids, info?.active])
  if (!info?.billing) return null
  const until = info.paidUntil ? new Date(info.paidUntil * 1000).toLocaleDateString('de-DE') : null
  const share = info.quota > 0 ? Math.min(100, Math.round((info.used / info.quota) * 100)) : 0
  const run = (key: string, f: () => Promise<string | null>) => {
    setBusy(key); setMessage(null)
    f().then((t) => t && setMessage({ ok: true, text: t }), (e: Error) => setMessage({ ok: false, text: e.message })).finally(() => setBusy(null))
  }
  const buyNow = (id: string) => run(id, async () => {
    const r = await buy(props.server, id)
    if (r === 'cancelled') return null
    if (r === 'pending') return 'Der Kauf wartet auf Genehmigung (z. B. durch die Familienfreigabe). Danach schaltet Grid das Abo von selbst frei.'
    await load()
    return 'Danke! Dein Abo ist aktiv.'
  })
  const restore = () => run('restore', async () => {
    const n = await syncPurchases(props.server, true)
    await load()
    return n > 0 ? 'Dein Abo wurde wiederhergestellt.' : 'Zu diesem Apple-Konto gibt es keinen Kauf, den dieses Grid-Konto nutzen kann.'
  })
  const manage = info.planSource === 'apple' && appStore ? () => void openExternal('https://apps.apple.com/account/subscriptions') : info.manageUrl ? () => void openExternal(info.manageUrl!) : null
  return (
    <>
      <section className={`cloud-card plan ${info.active ? 'ok' : 'warn'}`}>
        <div className="cloud-card-main">
          <strong>{info.active ? 'Abo aktiv' : 'Kein Abo'}</strong>
          <small>{info.active
            ? `${info.planSource === 'manual' ? 'Vom Betreiber freigeschaltet · ' : ''}${until ? `bis ${until} · ` : ''}${fmtSize(info.used)} von ${fmtSize(info.quota)}`
            : 'Dokumente, die dir gehören, sind nur lesbar.'}</small>
          {info.active && <span className="meter" aria-hidden><i style={{ width: `${share}%` }} /></span>}
        </div>
        <span className="plan-actions">
          {!appStore && !info.active && info.checkoutUrl && <button type="button" className="primary" onClick={() => void openExternal(info.checkoutUrl!)}>Abo abschließen</button>}
          {manage && <button type="button" className="linklike" onClick={manage}>Verwalten</button>}
        </span>
      </section>
      {appStore && !info.active && (
        <section className="paywall">
          {products === null && <p className="cloud-note">Angebote werden geladen …</p>}
          {products?.length === 0 && <p className="cloud-note warn">Der App Store zeigt gerade keine Angebote. Bitte später noch einmal versuchen.</p>}
          {products?.map((p) => {
            const quota = info.iap!.products.find((x) => x.id === p.id)?.quota
            return (
              <div key={p.id} className="product-row">
                <div className="member-who"><strong>{p.name}</strong><small>{p.price}{PERIOD[p.period] ? ` ${PERIOD[p.period]}` : ''}{quota ? ` · ${fmtSize(quota)} Speicher` : ''}</small></div>
                <button type="button" className="primary" disabled={!!busy} onClick={() => buyNow(p.id)}>{busy === p.id ? '…' : 'Abonnieren'}</button>
              </div>
            )
          })}
          <p className="paywall-terms">Das Abo verlängert sich automatisch, bis du es in den Einstellungen deines Apple-Kontos kündigst. Die Zahlung läuft über dein Apple-Konto.
            {info.iap!.termsUrl && <> <button type="button" className="linklike" onClick={() => void openExternal(info.iap!.termsUrl!)}>Nutzungsbedingungen</button></>}
            {info.iap!.privacyUrl && <> · <button type="button" className="linklike" onClick={() => void openExternal(info.iap!.privacyUrl!)}>Datenschutz</button></>}</p>
          <div className="actions"><button type="button" className="linklike" disabled={!!busy} onClick={restore}>{busy === 'restore' ? 'Wird geprüft …' : 'Käufe wiederherstellen'}</button></div>
        </section>
      )}
      {message && <p className={`cloud-note ${message.ok ? '' : 'bad'}`} role={message.ok ? 'status' : 'alert'}>{message.text}</p>}
    </>
  )
}

export function Field(props: { label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string; autoFocus?: boolean }) {
  return (
    <label className="sync-field">
      <span>{props.label}</span>
      <input type={props.type ?? 'text'} value={props.value} placeholder={props.placeholder} autoFocus={props.autoFocus}
        autoCapitalize="off" autoCorrect="off" spellCheck={false}
        onFocus={(e) => e.target.select()}
        onChange={(e) => props.onChange(e.target.value)} />
    </label>
  )
}

/** Dokument mit der Cloud verbinden oder die Verbindung verwalten. */
export function SyncDialog(props: { control: SyncControl; onClose: () => void }) {
  const c = props.control
  const me = useAccount()
  const info = useServerInfo(c.server)
  const [server, setServer] = useState(c.server ?? (lastServer() || MOCK_SERVER))
  const [membersOpen, setMembersOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [target, setTarget] = useState('')
  const [moveError, setMoveError] = useState<string | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)
  const [encrypting, setEncrypting] = useState(false)
  const [encError, setEncError] = useState<string | null>(null)
  const requests = c.members?.requests.length ?? 0
  const connected = !!c.server
  const submit = () => {
    const url = normalizeServer(server)
    if (!url) return
    rememberServer(url)
    c.connect(url, true) // neue Cloud-Dokumente sind immer verschlüsselt
  }
  if (membersOpen) return <MembersDialog control={c} onClose={() => setMembersOpen(false)} />

  const st = c.state
  const tone = st?.status === 'online' ? (st.readonly ? 'warn' : 'ok') : st?.status === 'denied' ? 'bad' : 'warn'
  const mine = me ? fingerprint(me.publicKey) : ''
  // Eine Erklärung, nur wenn etwas zu tun oder zu wissen ist
  const note = st?.readonly ? `${st.readonly.reason} Änderungen bleiben hier gespeichert und werden hochgeladen, sobald es wieder geht.`
    : st?.status === 'pending' && st.kind === 'join' ? `Ein Admin muss dich zulassen. Nenne ihm deine Prüfnummer ${mine}; danach verbindet sich Grid von selbst.`
    : st?.status === 'pending' && st.kind === 'account' ? `Der Betreiber des Servers muss dein Konto freigeben. Kennung ${me?.id.slice(0, 8) ?? ''} (${mine}).`
    : st?.status === 'pending' ? st.reason ?? null
    : st?.status === 'denied' ? st.reason ?? null
    : null

  return (
    <Modal onClose={props.onClose}>
      <form className="dialog sync-dialog cloud-dialog" onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (!connected) submit() }}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>Cloud</h3>
        {connected ? (
          <>
            <section className={`cloud-card ${tone}`}>
              <span className="dot" aria-hidden />
              <div className="cloud-card-main">
                <strong>{syncLabel(c)}</strong>
                <small>{info?.name ?? hostOf(c.server!)}</small>
                <span className={`chip ${c.enc ? 'lock' : 'open'}`}>{c.enc ? '🔒 Ende-zu-Ende verschlüsselt' : 'Nicht verschlüsselt'}</span>
              </div>
            </section>
            {note && <p className={`cloud-note ${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>{note}</p>}
            {st?.status === 'denied' && st.kind === 'untrusted' && (
              <div className="actions"><button type="button" className="danger-outline" onClick={() => c.trustServer()}>Dem neuen Schlüssel vertrauen</button></div>
            )}

            {c.moved && (
              <section className="cloud-card moved">
                <div className="cloud-card-main"><strong>Dieses Dokument ist umgezogen</strong><small>{hostOf(c.moved.server)} · von einem Admin angekündigt</small></div>
                <button type="button" className="primary" onClick={() => c.followMove()}>Wechseln</button>
              </section>
            )}

            {!c.enc && st?.status === 'online' && (
              <section className="cloud-card warn">
                <div className="cloud-card-main"><strong>Der Server kann dieses Dokument lesen</strong>
                  <small>{c.members?.role === 'admin' ? 'Verschlüssele es, damit nur Mitglieder es lesen können.' : 'Ein Admin kann es verschlüsseln.'}</small></div>
                {c.members?.role === 'admin' && !encrypting && <button type="button" onClick={() => { setEncrypting(true); setEncError(null) }}>Verschlüsseln …</button>}
              </section>
            )}
            {encrypting && (
              <div className="cloud-confirm">
                <p>Der Server löscht den lesbaren Stand und die Dateien, und alle Mitglieder laden ihren Stand verschlüsselt neu hoch. Ein Admin muss dafür online sein, bis alle ihren Schlüssel haben. Alte Sicherungen des Servers enthalten den Klartext weiter. Das lässt sich nicht rückgängig machen.</p>
                <div className="actions">
                  <button type="button" onClick={() => setEncrypting(false)}>Abbrechen</button>
                  <button type="button" className="primary" onClick={() => c.encryptDocument().then(() => setEncrypting(false), (e: Error) => setEncError(e.message))}>Jetzt verschlüsseln</button>
                </div>
                {encError && <p className="sync-error" role="alert">{encError}</p>}
              </div>
            )}

            {c.server && st?.status === 'online' && <PlanLine server={c.server} refresh={st.readonly?.code ?? ''} onActive={() => c.resync()} />}

            {st?.status === 'online' && (
              <button type="button" className="cloud-row" onClick={() => setMembersOpen(true)}>
                <span><strong>Mitglieder</strong><small>{c.members?.state ? `${c.members.state.members.size} im Dokument · ` : ''}Einladen und verwalten</small></span>
                <span className="cloud-row-end">{requests > 0 && <span className="badge">{requests}</span>}<span className="chev" aria-hidden>›</span></span>
              </button>
            )}

            <details className="cloud-adv">
              <summary>Erweitert</summary>
              <dl>
                <dt>Server</dt><dd>{c.server}</dd>
                {info && <><dt>Server-Schlüssel</dt><dd><code>{fingerprint(info.pub)}</code></dd></>}
                {mine && <><dt>Deine Prüfnummer</dt><dd><code>{mine}</code></dd></>}
              </dl>
              {!switching
                ? <button type="button" className="linklike" onClick={() => { setSwitching(true); setTarget('') }}>Auf einen anderen Server umziehen …</button>
                : (
                  <div className="cloud-confirm">
                    <Field label="Neuer Server" value={target} onChange={setTarget} placeholder="https://firma.example/grid" autoFocus />
                    <p>Das Dokument wird mit allen Mitgliedern auf den neuen Server kopiert. Sie brauchen dort ein Konto und verbinden sich selbst mit dem neuen Server. Der alte Server behält seine Kopie.</p>
                    <div className="actions">
                      <button type="button" onClick={() => setSwitching(false)}>Abbrechen</button>
                      <button type="button" className="primary" disabled={!normalizeServer(target)} onClick={() => {
                        const u = normalizeServer(target)
                        setMoveError(null)
                        c.moveTo(u).then(() => { rememberServer(u); setSwitching(false) }, (e: Error) => setMoveError(e.message))
                      }}>Umziehen</button>
                    </div>
                    {moveError && <p className="sync-error" role="alert">{moveError}</p>}
                  </div>
                )}
            </details>

            {disconnecting
              ? (
                <div className="cloud-confirm">
                  <p><strong>Wirklich die Synchronisation zu diesem Server trennen?</strong><br />Das Dokument bleibt auf diesem Gerät vollständig erhalten, wird aber nicht mehr abgeglichen. Auf dem Server und bei den anderen Mitgliedern bleibt es bestehen.</p>
                  <div className="actions">
                    <button type="button" onClick={() => setDisconnecting(false)}>Abbrechen</button>
                    <button type="button" className="danger" onClick={() => { c.disconnect(); props.onClose() }}>Trennen</button>
                  </div>
                </div>
              )
              : (
                <div className="actions split">
                  <button type="button" className="danger-outline" onClick={() => setDisconnecting(true)}>Verbindung lösen</button>
                  <button type="button" className="primary" onClick={props.onClose}>Fertig</button>
                </div>
              )}
          </>
        ) : (
          <>
            <p className="cloud-lead">Synchronisiere dieses Dokument mit anderen Geräten und Personen. Es wird Ende-zu-Ende verschlüsselt: der Server speichert nur unlesbare Daten, und lokal bleibt alles vollständig erhalten.</p>
            <Field label="Server" value={server} onChange={setServer} placeholder="https://townwork.eu/grid" autoFocus />
            <div className="actions">
              <button type="button" onClick={props.onClose}>Abbrechen</button>
              <button type="submit" className="primary" disabled={!server.trim()}>Verbinden</button>
            </div>
          </>
        )}
      </form>
    </Modal>
  )
}

/** Konto sichern, auf ein anderes Gerät übertragen oder von dort übernehmen. */
export function AccountDialog(props: { onClose: () => void }) {
  const me = useAccount()
  const [pass, setPass] = useState('')
  const [exported, setExported] = useState('')
  const [incoming, setIncoming] = useState('')
  const [pass2, setPass2] = useState('')
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const make = async () => {
    try { setExported(await exportAccount(pass)); setMessage(null) } catch (e) { setMessage({ ok: false, text: String((e as Error).message ?? e) }) }
  }
  const [confirming, setConfirming] = useState(false)
  const take = async () => {
    setConfirming(false)
    try {
      await importAccount(incoming, pass2)
      setIncoming(''); setPass2('')
      setMessage({ ok: true, text: 'Konto übernommen.' })
    } catch (e) { setMessage({ ok: false, text: String((e as Error).message ?? e) }) }
  }
  return (
    <Modal onClose={props.onClose}>
      <div className="dialog sync-dialog account-dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>Grid-Konto</h3>
        <p className="sync-account"><span>Fingerabdruck <code>{me ? fingerprint(me.publicKey) : '…'}</code></span></p>
        <p className="hint">Das Konto liegt auf diesem Gerät im Schlüsselbund. Mit einem zweiten Gerät teilst du es über einen verschlüsselten Text. Wer ihn und das Passwort hat, kann sich als du anmelden.</p>

        <h4>Auf ein anderes Gerät übertragen</h4>
        <Field label="Passwort für den Text" value={pass} onChange={(v) => { setPass(v); setExported('') }} type="password" />
        {exported
          ? <>
              <textarea readOnly rows={3} value={exported} onFocus={(e) => e.target.select()} aria-label="Verschlüsseltes Konto" />
              <div className="actions"><button type="button" onClick={() => { void navigator.clipboard?.writeText(exported); setCopied(true) }}>{copied ? 'Kopiert' : 'Kopieren'}</button></div>
            </>
          : <div className="actions"><button type="button" disabled={pass.length < 6} onClick={() => void make()}>Text erzeugen</button></div>}

        <h4>Konto von einem anderen Gerät übernehmen</h4>
        <textarea rows={3} placeholder="grid-account:1:…" value={incoming} onChange={(e) => setIncoming(e.target.value)} aria-label="Übertragenes Konto" />
        <Field label="Passwort" value={pass2} onChange={setPass2} type="password" />
        {confirming
          ? <>
              <p className="sync-error">Das Konto dieses Geräts wird ersetzt. Sichere es vorher, falls du es noch brauchst.</p>
              <div className="actions"><button type="button" onClick={() => setConfirming(false)}>Abbrechen</button><button type="button" className="danger" onClick={() => void take()}>Konto ersetzen</button></div>
            </>
          : <div className="actions"><button type="button" disabled={!incoming.trim() || !pass2} onClick={() => setConfirming(true)}>Übernehmen</button></div>}

        {message && <p className={message.ok ? 'sync-ok' : 'sync-error'} role="status">{message.text}</p>}
        <div className="actions"><button type="button" className="primary" onClick={props.onClose}>Fertig</button></div>
      </div>
    </Modal>
  )
}

/** Dokument aus der Cloud wählen (Menü „Aus Cloud öffnen …“). */
export function CloudOpenDialog(props: { onOpen: (doc: CloudDoc, server: string) => void; onClose: () => void }) {
  const me = useAccount()
  const [server, setServer] = useState(lastServer())
  const [docs, setDocs] = useState<CloudDoc[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [busy, setBusy] = useState(false)
  const load = async () => {
    const url = normalizeServer(server)
    if (!url) return
    setBusy(true); setError(null); setPending(false)
    try {
      setDocs(await listCloudDocs(url))
      rememberServer(url)
    } catch (e) {
      setDocs(null)
      if (e instanceof AuthError && e.kind === 'pending') setPending(true)
      else setError(String((e as Error).message ?? e))
    } finally { setBusy(false) }
  }
  return (
    <Modal onClose={props.onClose}>
      <form className="dialog sync-dialog" onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); void load() }}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h3>Aus Cloud öffnen</h3>
        <Field label="Server" value={server} onChange={(v) => { setServer(v); setDocs(null); setPending(false) }} placeholder="https://townwork.eu/grid" autoFocus={!server} />
        {pending && <p className="hint">Dein Konto ist auf diesem Server noch nicht freigegeben. Nenne dem Betreiber die Kennung <code>{me?.id.slice(0, 8)}</code>.</p>}
        {error && <p className="sync-error" role="alert">{error}</p>}
        {docs && (docs.length === 0
          ? <p className="hint">Für dein Konto liegen auf diesem Server noch keine Dokumente.</p>
          : <ul className="cloud-docs">
              {docs.map((d) => (
                <li key={d.id}>
                  <button type="button" onClick={() => props.onOpen(d, normalizeServer(server))}>
                    <strong>{d.name || 'Ohne Namen'}</strong>
                    <small>{new Date(d.updated * 1000).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}</small>
                  </button>
                </li>
              ))}
            </ul>)}
        <div className="actions">
          <button type="button" onClick={props.onClose}>Schließen</button>
          <button type="submit" className="primary" disabled={busy || !server.trim()}>{docs ? 'Aktualisieren' : 'Dokumente anzeigen'}</button>
        </div>
      </form>
    </Modal>
  )
}
