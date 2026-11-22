/**
 * Dokumentschlüssel eines verschlüsselten Dokuments: holen (Kisten vom Server öffnen), als Admin verteilen und erneuern.
 * Hintergrund: docs/E2E.md
 */
import type { AdminState } from './adminLog'
import { newDocKey, openKeyBox, sealKeyBox } from './e2e'
import { getIdentity } from './identity'
import { fetchMembers, type MembersInfo } from './members'
import { authedFetch } from './syncClient'

interface KeysReply { enc: boolean; epoch: number; missing: string[]; boxes: { epoch: number; from: string; box: string }[] }
type Put = { epoch: number; account: string; box: string }

export class DocKeys {
  private keys = new Map<number, Uint8Array>()
  /** neueste Epoche, die der Server kennt */
  serverEpoch = 0

  constructor(private server: string, private doc: string) {}

  /** Neueste Epoche, für die dieses Gerät den Schlüssel hat (0 = noch keiner). */
  get top() { return Math.max(0, ...this.keys.keys()) }
  key(epoch: number) { return this.keys.get(epoch) }
  has(epoch: number) { return this.keys.has(epoch) }

  private async fetch(): Promise<KeysReply> {
    const r = await authedFetch(this.server, `/docs/${this.doc}/keys`)
    if (!r.ok) throw new Error(`Schlüssel: Server antwortet mit ${r.status}`)
    return r.json()
  }

  private async put(list: Put[]) {
    if (!list.length) return
    const r = await authedFetch(this.server, `/docs/${this.doc}/keys`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(list) })
    if (!r.ok) throw new Error((await r.text().catch(() => '')) || `Schlüssel ablegen: Server antwortet mit ${r.status}`)
  }

  /** Nimmt Kisten an: nur von Admins aus dem geprüften Protokoll. */
  private async absorb(boxes: KeysReply['boxes'], state: AdminState | null) {
    const me = await getIdentity()
    for (const b of boxes) {
      if (this.keys.has(b.epoch)) continue
      const sender = state?.members.get(b.from)
      if (!sender || sender.role !== 'admin') continue
      try { this.keys.set(b.epoch, await openKeyBox(me, { id: b.from, pub: sender.pub }, this.doc, b.epoch, b.box)) } catch { /* nicht für uns oder verfälscht */ }
    }
  }

  /** Kisten vom Server holen und öffnen. Gibt `true` zurück, wenn der neueste Schlüssel da ist. */
  async load(): Promise<boolean> {
    const [reply, info] = await Promise.all([this.fetch(), fetchMembers(this.server, this.doc)])
    this.serverEpoch = reply.epoch
    await this.absorb(reply.boxes, info.state)
    return reply.epoch > 0 && this.keys.has(reply.epoch)
  }

  /** Als Ersteller den ersten Schlüssel anlegen (kein Schlüssel da, und dieses Konto ist Admin). */
  async createFirst(info: MembersInfo): Promise<boolean> {
    const me = await getIdentity()
    if (info.state?.members.get(me.id)?.role !== 'admin') return false
    if ((await this.fetch()).epoch > 0) return false
    const key = newDocKey()
    await this.put(await this.boxesFor(info.state, 1, key))
    // Haben zwei Admins gleichzeitig angelegt, gilt, was der Server behalten hat: noch einmal von dort lesen
    this.keys.clear()
    if (!(await this.load())) this.keys.set(1, key)
    this.serverEpoch = 1
    return true
  }

  private async boxesFor(state: AdminState, epoch: number, key: Uint8Array): Promise<Put[]> {
    const me = await getIdentity()
    const out: Put[] = []
    for (const [id, m] of state.members) out.push({ epoch, account: id, box: await sealKeyBox(me, { id, pub: m.pub }, this.doc, epoch, key) })
    return out
  }

  /**
   * Als Admin: fehlende Kisten nachliefern (neue Mitglieder bekommen alle Epochen, die dieses Gerät kennt).
   * Gibt es noch gar keinen Schlüssel, entsteht der erste.
   */
  async provision(info: MembersInfo): Promise<void> {
    const me = await getIdentity()
    const st = info.state
    if (!st || st.members.get(me.id)?.role !== 'admin') return
    const reply = await this.fetch()
    this.serverEpoch = reply.epoch
    await this.absorb(reply.boxes, st)
    if (reply.epoch === 0) { await this.createFirst(info); return }
    const out: Put[] = []
    for (const acct of reply.missing) {
      const m = st.members.get(acct)
      if (!m) continue
      for (const [epoch, key] of this.keys) out.push({ epoch, account: acct, box: await sealKeyBox(me, { id: acct, pub: m.pub }, this.doc, epoch, key) })
    }
    await this.put(out)
  }

  /** Nach dem Entfernen eines Mitglieds: neue Epoche für alle Verbliebenen (das entfernte Mitglied bekommt sie nicht). */
  async rotate(): Promise<void> {
    const info = await fetchMembers(this.server, this.doc)
    if (!info.state) return
    const reply = await this.fetch()
    await this.absorb(reply.boxes, info.state)
    const epoch = reply.epoch + 1
    if (epoch > 255) throw new Error('Zu viele Schlüsselwechsel')
    const key = newDocKey()
    await this.put(await this.boxesFor(info.state, epoch, key))
    this.keys.set(epoch, key)
    this.serverEpoch = epoch
  }

  /** Schlüssel für eine Epoche; fehlt er, wird einmal nachgeladen. */
  async keyFor(epoch: number): Promise<Uint8Array | undefined> {
    if (!this.keys.has(epoch)) { try { await this.load() } catch { /* offline */ } }
    return this.keys.get(epoch)
  }
}
