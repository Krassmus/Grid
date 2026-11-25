import * as Y from 'yjs'
import { appendGrid, writeGrid, type GridMeta } from './gridFile'
import { Materializer } from './tableSync'
import { SyncConnection, fetchServerInfo, normalizeServer, onServerKey, pinServer, pinnedKey, type SyncState } from './syncClient'
import { acceptRequest, announceMove, changeGroups, claimDocument, ensureGenesis, fetchMembers, markEncrypted, rejectRequest, removeMember, setRole, type GroupChange, type JoinRequest, type MembersInfo } from './members'
import { fingerprint, getIdentity } from './identity'
import { makeInvite } from './invite'
import { DocKeys } from './docKeys'
import { iapAvailable, syncPurchases } from './iap'
import { publishProfile, tablesOf } from './model'
import { getProfile, onProfileChange } from './profile'
import { applyEntry, buildGroupEntry, replay, type AdminEntry, type AdminState, type Role } from './adminLog'
import { colKeysOf, ringOf } from './colCrypt'
import { reconcileColumns } from './colKeys'
import { judge, RightsTimeline } from './updateGuard'
import { accountIdNow } from './identity'
import { t } from './i18n'

/** Ab so vielen Einträgen im Protokoll ersetzt ein Gesamtzustand die Updates. */
const COMPACT_AT = 200

/**
 * Ein geöffnetes Dokument, das (falls `path` gesetzt) laufend in seine .grid-Datei gespeichert wird.
 * Gespeichert wird inkrementell: neue Yjs-Updates kommen ans Protokoll, geänderte Zeilen in die Datentabellen.
 * Nur beim ersten Speichern einer alten (ZIP-)Datei und nach einem Fehler wird die Datei komplett neu geschrieben.
 */
export class FileSession {
  private timer: ReturnType<typeof setTimeout> | undefined
  private queue: Promise<void> = Promise.resolve()
  private dirty = false
  private pending: Uint8Array[] = []
  private tables: Materializer | null = null
  private logEntries = 0
  private conn: SyncConnection | null = null
  /** Dokumentschlüssel (nur bei verschlüsselten Dokumenten) */
  private keys: DocKeys | null = null
  private attached = false
  private publishProfile: (() => void) | null = null
  /** Zustand der Cloud-Verbindung für die Oberfläche (`null` = nicht verbunden). */
  syncState: SyncState | null = null
  onSyncState: ((s: SyncState | null) => void) | null = null
  /** Mitglieder und offene Beitrittsanfragen (`null` = unbekannt oder nicht verbunden). */
  members: MembersInfo | null = null
  onMembers: ((m: MembersInfo | null) => void) | null = null
  private membersQueue: Promise<void> = Promise.resolve()
  constructor(
    /** Ändert sich nur, wenn ein anderes Dokument geöffnet wird (Neuaufbau der Oberfläche). */
    readonly key: number,
    readonly doc: Y.Doc,
    readonly path: string | null,
    readonly meta: GridMeta,
    private known: Set<string>,
    private onError: (message: string | null) => void,
    /** Die Datei muss beim nächsten Speichern komplett neu geschrieben werden (altes Format). */
    private needsFull = false,
  ) {}

  /** Beginnt, Änderungen zu speichern. Liefert die Abmeldung (speichert dabei noch Ausstehendes). */
  attach(): () => void {
    this.attached = true
    if (this.meta.sync) this.openConn()
    // Zeigt ein Server zum ersten Mal seinen Schlüssel, gehört er in die Datei (so kennt ihn auch jedes andere Gerät)
    const offKey = onServerKey((server, key) => {
      const sync = this.meta.sync
      if (sync && sync.server === server && sync.key !== key) { sync.key = key; this.schedule() }
    })
    // Eigenen Namen und Avatar im Dokument eintragen (so sehen es die anderen Mitglieder), auch nach Änderungen im Konto
    const publish = () => { if (this.meta.sync) void getIdentity().then((me) => { const p = getProfile(); publishProfile(this.doc, me.id, { name: p.name, avatar: p.avatar }) }).catch(() => {}) }
    publish()
    this.publishProfile = publish
    const offProfile = onProfileChange(publish)
    // Schlüssel öffnen und (als Admin) abgleichen, wenn Schlüssel im Dokument ankommen oder Spalten dazukommen
    const colSoon = () => this.colKeysSoon()
    const onTables = (events: Y.YEvent<any>[]) => { if (events.some((e) => e.path.length <= 2)) this.colKeysSoon() }
    colKeysOf(this.doc).observe(colSoon)
    tablesOf(this.doc).observeDeep(onTables)
    this.colKeysSoon()
    const detachSync = () => { offKey(); offProfile(); colKeysOf(this.doc).unobserve(colSoon); tablesOf(this.doc).unobserveDeep(onTables); clearTimeout(this.colTimer); this.publishProfile = null; this.attached = false; this.conn?.close(); this.conn = null }
    if (!this.path) return detachSync
    const onUpdate = (update: Uint8Array) => { this.pending.push(update); this.schedule() }
    this.tables = new Materializer(this.doc)
    this.doc.on('update', onUpdate)
    return () => {
      detachSync()
      this.doc.off('update', onUpdate)
      void this.flush().finally(() => { this.tables?.dispose(); this.tables = null })
    }
  }

  private setSyncState(s: SyncState | null) {
    const wasOnline = this.syncState?.status === 'online'
    this.syncState = s; this.onSyncState?.(s)
    if (s?.status === 'online' && !wasOnline) this.colKeysSoon()
  }

  // ----- Vertrauliche Spalten (docs/RIGHTS.md): Schlüssel öffnen, als Admin Schlüssel verteilen und Zellen verschlüsseln -----
  private colTimer: ReturnType<typeof setTimeout> | undefined
  private colBusy: Promise<void> = Promise.resolve()
  private colKeysSoon() {
    clearTimeout(this.colTimer)
    this.colTimer = setTimeout(() => { this.colBusy = this.colBusy.then(() => this.colKeysNow()).catch(() => {}) }, 500)
  }
  private async colKeysNow(state: AdminState | null = this.adminState) {
    if (!state || !this.meta.sync) return
    const me = await getIdentity()
    await ringOf(this.doc).openBoxes(this.meta.docId, me, state)
    if (this.syncState?.status === 'online') await reconcileColumns(this.doc, this.meta.docId, me, state)
  }
  /** Der Stand des Admin-Protokolls, wie er nach `changes` wäre (für den Abgleich vor dem Eintragen). */
  private async stateAfter(changes: GroupChange[]): Promise<AdminState | null> {
    let s = this.adminState
    if (!s) return null
    const me = await getIdentity()
    try {
      for (const c of changes) {
        let e
        if (c.type === 'join-group' || c.type === 'leave-group') {
          const m = s.members.get(c.account)
          if (!m) continue
          e = buildGroupEntry(me, s, this.meta.docId, { ...c, pub: m.pub })
        } else e = buildGroupEntry(me, s, this.meta.docId, c as Exclude<GroupChange, { type: 'join-group' | 'leave-group' }>)
        s = applyEntry(s, this.meta.docId, e)
      }
    } catch { return null }
    return s
  }

  private openConn() {
    const sync = this.meta.sync
    if (!sync) return
    this.conn?.close()
    this.membersTried = false
    if (sync.key) pinServer(sync.server, sync.key) // in der Datei gemerkt: der Server muss diesen Schlüssel beweisen
    else if (pinnedKey(sync.server)) sync.key = pinnedKey(sync.server)!
    this.keys = sync.enc ? new DocKeys(sync.server, this.meta.docId) : null
    // iPad: Verlängerungen und Käufe auf anderen Geräten dem Server melden (er prüft Apples Signatur selbst)
    if (iapAvailable) void syncPurchases(sync.server).catch(() => {})
    this.conn = new SyncConnection(this.doc,
      { server: sync.server, docId: this.meta.docId, name: this.name, keys: this.keys ?? undefined, rights: this.rightsHooks() },
      (s) => this.setSyncState(s), () => void this.refreshMembers(),
      () => claimDocument(sync.server, this.meta.docId, this.meta.adminLog, !!sync.enc))
  }

  resync() { this.conn?.resync() }

  // ----- Rechte (docs/RIGHTS.md): eingehende Änderungen werden nach dem Admin-Protokoll bewertet -----
  /** Abgelehnte Änderungen seit dem Öffnen und der letzte Grund */
  rejected = 0
  lastRejection = ''
  /** Die letzten abgelehnten Änderungen (Nummer im Datenstrom und Grund), für die Fehlersuche */
  rejections: { seq: number; reason: string }[] = []
  onRejected: (() => void) | null = null
  private membersTried = false // pro Verbindung höchstens ein Nachholversuch
  private timeline: { entries: readonly AdminEntry[]; tl: RightsTimeline | null } | null = null
  private timelineNow(): RightsTimeline | null {
    const entries: readonly AdminEntry[] = this.members?.entries ?? this.meta.adminLog ?? []
    if (this.timeline?.entries !== entries) this.timeline = { entries, tl: entries.length ? new RightsTimeline(this.meta.docId, entries) : null }
    return this.timeline.tl
  }
  private rightsHooks() {
    return {
      // Ohne bekanntes Protokoll (neues Mitglied, frische Datei) erst die Mitglieder holen: sonst käme Ungeprüftes ins Dokument
      settled: async () => { await this.membersQueue; if (!this.timelineNow() && !this.membersTried) { this.membersTried = true; await this.refreshMembers() } },
      judge: (live: Y.Doc, seq: number, plain: Uint8Array) => judge(this.timelineNow(), this.meta.docId, live, seq, plain),
      mode: () => {
        const st = this.timelineNow()?.latest
        return { active: !!st && st.groups.size > 0, admin: st?.members.get(accountIdNow())?.role === 'admin', sign: !!st?.members.get(accountIdNow()) }
      },
      onRejected: (seq: number, reason: string) => { this.rejected++; this.lastRejection = reason; this.rejections = [...this.rejections.slice(-49), { seq, reason }]; this.onRejected?.() },
    }
  }

  private setMembers(m: MembersInfo | null) { this.members = m; this.onMembers?.(m) }

  /** Mitglieder neu laden; legt dabei (als Ersteller) das Admin-Protokoll an, falls es noch fehlt. */
  refreshMembers(): Promise<void> {
    const server = this.meta.sync?.server
    if (!server) return Promise.resolve()
    this.membersQueue = this.membersQueue.then(async () => {
      try {
        let info = await fetchMembers(server, this.meta.docId)
        if (await ensureGenesis(server, this.meta.docId, info)) info = await fetchMembers(server, this.meta.docId)
        if (info.entries.length !== (this.meta.adminLog?.length ?? 0)) { this.meta.adminLog = info.entries; this.schedule() }
        this.setMembers(info)
        // Ein Admin hat das Dokument verschlüsselt (signierter Eintrag): diese Datei folgt, ohne dass jemand etwas tun muss
        if (info.state?.enc && this.meta.sync && !this.meta.sync.enc) {
          this.meta.sync.enc = true
          this.schedule()
          this.openConn()
          return
        }
        // Verschlüsselung muss auf beiden Seiten gleich sein; sonst würde Klartext dort landen, wo er nicht hingehört
        if (info.entries.length > 0 && !!this.meta.sync?.enc !== info.enc) {
          this.conn?.close(); this.conn = null
          this.setSyncState({ status: 'denied', reason: info.enc ? t('Das Dokument ist auf dem Server verschlüsselt, diese Datei kennt es unverschlüsselt.') : t('Diese Datei erwartet ein verschlüsseltes Dokument, der Server hat es unverschlüsselt.') })
          return
        }
        if (this.keys) await this.keys.provision(info) // als Admin: Schlüssel an neue Mitglieder verteilen
        this.colKeysSoon()
      } catch { /* (noch) kein Mitglied oder offline: die Verbindung meldet den Grund */ }
    })
    return this.membersQueue
  }

  private async change(run: (server: string, doc: string) => Promise<void>) {
    const server = this.meta.sync?.server
    if (!server) throw new Error(t('Das Dokument ist nicht mit einem Server verbunden'))
    await run(server, this.meta.docId)
    await this.refreshMembers()
  }
  accept = (req: JoinRequest, role: Role = 'member') => this.change((s, d) => acceptRequest(s, d, req, role))
  reject = (account: string) => this.change((s, d) => rejectRequest(s, d, account))
  /** Mitglied entfernen oder (eigenes Konto) das Dokument verlassen: dann löst sich dieses Gerät vom Server, die Datei bleibt. */
  remove = async (account: string) => {
    const me = await getIdentity()
    await this.change(async (s, d) => {
      await removeMember(s, d, account)
      if (account !== me.id) await this.keys?.rotate() // neuer Schlüssel: das entfernte Mitglied bekommt ihn nicht (beim Verlassen erneuert ihn ein Admin)
    })
    if (account === me.id) this.disconnect()
  }
  /** Als Admin ein unverschlüsseltes Dokument auf Ende-zu-Ende-Verschlüsselung umstellen (der Server löscht dabei den Klartext). */
  encryptDocument = () => this.change((s, d) => markEncrypted(s, d))
  changeRole = (account: string, role: Role) => this.change((s, d) => setRole(s, d, account, role))
  /** Gruppen und Rechte ändern (als Admin) */
  changeGroups = async (changes: GroupChange[]) => {
    // Erst verschlüsseln und Schlüssel wechseln, wie es nach den Änderungen nötig wäre: so steht nie Klartext in einer Spalte, die jemand nicht mehr lesen darf
    try { const next = await this.stateAfter(changes); if (next) await this.colBusy.then(() => this.colKeysNow(next)) } catch { /* der Abgleich läuft danach noch einmal */ }
    await this.change((s, d) => changeGroups(s, d, changes))
  }
  /** Stand des Admin-Protokolls für die Rechte: vom Server, sonst aus der Datei (damit sie auch offline gelten) */
  get adminState(): AdminState | null {
    if (this.members?.state) return this.members.state
    if (!this.meta.adminLog?.length) return null
    try { return replay(this.meta.docId, this.meta.adminLog) } catch { return null }
  }

  /** Einladungstext für dieses Dokument (der Empfänger klopft damit an). */
  async invite(): Promise<string> {
    const server = this.meta.sync?.server
    if (!server) throw new Error(t('Das Dokument ist nicht mit einem Server verbunden'))
    const me = await getIdentity()
    return makeInvite({ server, doc: this.meta.docId, name: this.name, admin: fingerprint(me.publicKey), key: this.meta.sync?.key, ...(this.meta.sync?.enc ? { enc: true } : {}) })
  }

  private get name() { return this.path ? this.path.split(/[\\/]/).pop()!.replace(/\.grid$/i, '') : t('Mein Dokument') }

  /** Dokument mit einem Server verbinden (und die Anbindung in der Datei merken). */
  connect(server: string, key?: string, enc = false) {
    const url = normalizeServer(server)
    this.meta.sync = { server: url, ...(key ? { key } : {}), ...(enc ? { enc: true } : {}) }
    this.schedule()
    if (this.attached) this.openConn()
    this.publishProfile?.()
  }

  /**
   * Das Dokument auf einen anderen Server umziehen: Umzug im Admin-Protokoll ankündigen (damit die Mitglieder ihn sehen),
   * dann verbinden; der neue Server übernimmt dabei das Protokoll mit allen Mitgliedern.
   */
  async moveTo(newServer: string) {
    const url = normalizeServer(newServer)
    const info = await fetchServerInfo(url).catch(() => { throw new Error(t('Der neue Server ist nicht erreichbar')) })
    if (this.meta.sync && this.members?.role === 'admin') {
      try { await this.change((s, d) => announceMove(s, d, url, info.pub)) } catch { /* alter Server nicht erreichbar: trotzdem umziehen */ }
    }
    this.connect(url, info.pub, !!this.meta.sync?.enc)
  }

  /** Umzug, den ein Admin angekündigt hat und dem dieses Gerät noch nicht gefolgt ist. */
  get movedTo(): { server: string; key: string } | null {
    const m = this.members?.state?.moved
    const cur = this.meta.sync?.server
    return m && cur && normalizeServer(m.server) !== cur ? m : null
  }

  /** Dem Schlüssel, den der Server jetzt zeigt, vertrauen (nach einer Warnung, z. B. weil der Server neu installiert wurde). */
  trustServer() {
    const sync = this.meta.sync
    if (!sync) return
    pinServer(sync.server, null)
    delete sync.key
    this.schedule()
    this.openConn()
  }

  /** Anbindung lösen; das Dokument bleibt lokal vollständig erhalten. */
  disconnect() {
    delete this.meta.sync
    this.conn?.close()
    this.conn = null
    this.keys = null
    this.setSyncState(null)
    this.setMembers(null)
    this.schedule()
  }

  schedule() {
    this.dirty = true
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), 400)
  }

  /** Speichert sofort, falls Änderungen ausstehen, und wartet, bis alles geschrieben ist. */
  flush(): Promise<void> {
    clearTimeout(this.timer)
    this.queue = this.queue.then(async () => {
      if (!this.dirty || !this.path) return
      this.dirty = false
      const updates = this.pending
      this.pending = []
      try {
        if (this.needsFull || !this.tables) {
          this.tables?.clear() // die neue Datei enthält schon alles
          this.known = await writeGrid(this.path, this.doc, this.meta)
          this.needsFull = false
          this.logEntries = 1
        } else {
          const ops = this.tables.collect()
          const compact = this.logEntries >= COMPACT_AT
          const merged = compact ? [Y.encodeStateAsUpdate(this.doc)] : updates.length ? [Y.mergeUpdates(updates)] : []
          const r = await appendGrid(this.path, this.doc, this.meta, this.known, { updates: merged, compact, ops: ops ?? undefined })
          this.known = r.keys
          this.logEntries = r.logEntries
        }
        this.onError(null)
      } catch (e) {
        this.dirty = true
        this.needsFull = true // nach einem Fehler sicherheitshalber alles neu schreiben
        this.onError(t('Speichern fehlgeschlagen: {e}', { e: String(e) }))
      }
    })
    return this.queue
  }
}
