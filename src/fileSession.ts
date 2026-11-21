import * as Y from 'yjs'
import { appendGrid, writeGrid, type GridMeta } from './gridFile'
import { Materializer } from './tableSync'
import { SyncConnection, normalizeServer, rememberToken, tokenFor, type SyncState } from './syncClient'

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
    if (this.meta.sync && tokenFor(this.meta.sync.server)) this.openConn()
    const detachSync = () => { this.attached = false; this.conn?.close(); this.conn = null }
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
    this.conn = new SyncConnection(this.doc,
      { server: sync.server, token: tokenFor(sync.server), docId: this.meta.docId, name: this.name },
      (s) => this.setSyncState(s))
  }

  private get name() { return this.path ? this.path.split(/[\\/]/).pop()!.replace(/\.grid$/i, '') : 'Mein Dokument' }

  /** Dokument mit einem Server verbinden (und die Anbindung in der Datei merken). */
  connect(server: string, token: string) {
    const url = normalizeServer(server)
    rememberToken(url, token)
    this.meta.sync = { server: url }
    this.schedule()
    if (this.attached) this.openConn()
  }

  /** Anbindung lösen; das Dokument bleibt lokal vollständig erhalten. */
  disconnect() {
    delete this.meta.sync
    this.conn?.close()
    this.conn = null
    this.setSyncState(null)
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
