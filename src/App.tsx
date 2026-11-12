import { useEffect, useMemo, useState } from 'react'
import * as Y from 'yjs'
import { FakeHub } from './sync'
import { ClientPane } from './ClientPane'
import { setWindowTitle } from './windowTitle'

/** Normalfall: ein Dokument, ein Client. Mit ?sim in der URL: zwei simulierte Clients zum Testen von Merges. */
const SIM = new URLSearchParams(location.search).has('sim')

const DOC_NAME = 'Mein Dokument' // später: umbenennbar, aus dem Dokument gelesen

function Single() {
  const doc = useMemo(() => new Y.Doc(), [])
  useEffect(() => { setWindowTitle(DOC_NAME) }, [])
  return <ClientPane title={DOC_NAME} doc={doc} />
}

function Simulation() {
  const { hub, a, b } = useMemo(() => {
    const hub = new FakeHub()
    const a = new Y.Doc(), b = new Y.Doc()
    hub.join('Client A', a); hub.join('Client B', b)
    return { hub, a, b }
  }, [])
  const [, force] = useState(0)
  const toggle = (id: string) => { hub.setOnline(id, !hub.isOnline(id)); force((n) => n + 1) }
  return (
    <div className="panes">
      {(['Client A', 'Client B'] as const).map((id) => (
        <ClientPane key={id} title={id} doc={id === 'Client A' ? a : b}
          online={hub.isOnline(id)} onToggle={() => toggle(id)} />
      ))}
    </div>
  )
}

export function App() {
  return (
    <main>
      {SIM && <h1>Grid – Simulation</h1>}
      {SIM && <p className="hint">Simulationsmodus: zwei Clients am selben Dokument. Einen offline schalten, beide bearbeiten, wieder online schalten.</p>}
      {SIM ? <Simulation /> : <Single />}
    </main>
  )
}
