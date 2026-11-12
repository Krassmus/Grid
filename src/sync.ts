import * as Y from 'yjs'

const REMOTE = Symbol('remote')

/**
 * Simuliert einen Server zwischen mehreren Clients im selben Fenster.
 * Ein Client, der offline ist, sammelt Änderungen nur lokal;
 * beim Wiedereintritt werden fehlende Updates in beide Richtungen ausgetauscht.
 */
export class FakeHub {
  private clients = new Map<string, { doc: Y.Doc; online: boolean }>()

  join(id: string, doc: Y.Doc, online = true) {
    this.clients.set(id, { doc, online })
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE || !this.clients.get(id)!.online) return
      this.broadcast(id, update)
    })
  }

  isOnline(id: string) { return this.clients.get(id)!.online }

  setOnline(id: string, online: boolean) {
    const me = this.clients.get(id)!
    me.online = online
    if (!online) return
    for (const [otherId, other] of this.clients) {
      if (otherId === id || !other.online) continue
      Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(me.doc, Y.encodeStateVector(other.doc)), REMOTE)
      Y.applyUpdate(me.doc, Y.encodeStateAsUpdate(other.doc, Y.encodeStateVector(me.doc)), REMOTE)
    }
  }

  private broadcast(fromId: string, update: Uint8Array) {
    for (const [id, c] of this.clients) {
      if (id !== fromId && c.online) Y.applyUpdate(c.doc, update, REMOTE)
    }
  }
}
