import * as Y from 'yjs'
import { appendGrid, writeGrid, type GridMeta } from './gridFile'
import { Materializer } from './tableSync'
import { SyncConnection, normalizeServer, onServerKey, pinServer, pinnedKey, type SyncState } from './syncClient'
import { acceptRequest, claimDocument, ensureGenesis, fetchMembers, rejectRequest, removeMember, setRole, type JoinRequest, type MembersInfo } from './members'
import { fingerprint, getIdentity } from './identity'
import { makeInvite } from './invite'
import type { Role } from './adminLog'

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
  private attached = false
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
    const detachSync = () => { offKey(); this.attached = false; this.conn?.close(); this.conn = null }
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

  private setSyncState(s: SyncState | null) { this.syncState = s; this.onSyncState?.(s) }

  private openConn() {
    const sync = this.meta.sync
    if (!sync) return
    this.conn?.close()
    if (sync.key) pinServer(sync.server, sync.key) // in der Datei gemerkt: der Server muss diesen Schlüssel beweisen
    else if (pinnedKey(sync.server)) sync.key = pinnedKey(sync.server)!
    this.conn = new SyncConnection(this.doc,
      { server: sync.server, docId: this.meta.docId, name: this.name },
      (s) => this.setSyncState(s), () => void this.refreshMembers(),
      () => claimDocument(sync.server, this.meta.docId, this.meta.adminLog))
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
      } catch { /* (noch) kein Mitglied oder offline: die Verbindung meldet den Grund */ }
    })
    return this.membersQueue
  }

  private async change(run: (server: string, doc: string) => Promise<void>) {
    const server = this.meta.sync?.server
    if (!server) throw new Error('Das Dokument ist nicht mit einem Server verbunden')
    await run(server, this.meta.docId)
    await this.refreshMembers()
  }
  accept = (req: JoinRequest, role: Role = 'member') => this.change((s, d) => acceptRequest(s, d, req, role))
  reject = (account: string) => this.change((s, d) => rejectRequest(s, d, account))
  remove = (account: string) => this.change((s, d) => removeMember(s, d, account))
  changeRole = (account: string, role: Role) => this.change((s, d) => setRole(s, d, account, role))

  /** Einladungstext für dieses Dokument (der Empfänger klopft damit an). */
  async invite(): Promise<string> {
    const server = this.meta.sync?.server
    if (!server) throw new Error('Das Dokument ist nicht mit einem Server verbunden')
    const me = await getIdentity()
    return makeInvite({ server, doc: this.meta.docId, name: this.name, admin: fingerprint(me.publicKey), key: this.meta.sync?.key })
  }

  private get name() { return this.path ? this.path.split(/[\\/]/).pop()!.replace(/\.grid$/i, '') : 'Mein Dokument' }

  /** Dokument mit einem Server verbinden (und die Anbindung in der Datei merken). */
  connect(server: string, key?: string) {
    const url = normalizeServer(server)
    this.meta.sync = key ? { server: url, key } : { server: url }
    this.schedule()
    if (this.attached) this.openConn()
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
        this.onError(`Speichern fehlgeschlagen: ${e}`)
      }
    })
    return this.queue
  }
}
