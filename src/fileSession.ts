import * as Y from 'yjs'
import { writeGrid, type GridMeta } from './gridFile'

/** Ein geöffnetes Dokument, das (falls `path` gesetzt) laufend in seine .grid-Datei gespeichert wird. */
export class FileSession {
  private timer: ReturnType<typeof setTimeout> | undefined
  private queue: Promise<void> = Promise.resolve()
  private dirty = false
  constructor(
    /** Ändert sich nur, wenn ein anderes Dokument geöffnet wird (Neuaufbau der Oberfläche). */
    readonly key: number,
    readonly doc: Y.Doc,
    readonly path: string | null,
    readonly meta: GridMeta,
    private known: Set<string>,
    private onError: (message: string | null) => void,
  ) {}

  /** Beginnt, Änderungen zu speichern. Liefert die Abmeldung (speichert dabei noch Ausstehendes). */
  attach(): () => void {
    if (!this.path) return () => {}
    const onUpdate = () => this.schedule()
    this.doc.on('update', onUpdate)
    return () => { this.doc.off('update', onUpdate); void this.flush() }
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
      try {
        this.known = await writeGrid(this.path, this.doc, this.meta, this.known)
        this.onError(null)
      } catch (e) {
        this.dirty = true
        this.onError(`Speichern fehlgeschlagen: ${e}`)
      }
    })
    return this.queue
  }
}
