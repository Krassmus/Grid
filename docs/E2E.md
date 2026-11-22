# Grid: Ende-zu-Ende-Verschlüsselung (E2E)

Stand: Phase 1 (Server), Phase 2 (Client-Kern) und Phase 3 (Verteilung, Oberfläche) sind gebaut und im Zusammenspiel geprüft (Anlegen, Beitritt mit Schlüsselverteilung, Bearbeiten in beide Richtungen, Zusammenführen bei über 200 Einträgen, späte Teilnehmer, Entfernen mit neuer Epoche). Noch nicht geprüft: Dateien/Bilder im Zusammenspiel mit dem Server (Verfahren per Test abgedeckt). Ergänzt `docs/SYNC.md`. Ziel: Der Server speichert und verteilt nur noch verschlüsselte Bytes. Er kann weder Zellen noch Dateien lesen.

## Entscheidungen

- **Pro Dokument, beim Verbinden festgelegt.** Neue Cloud-Dokumente sind standardmäßig verschlüsselt (Häkchen im Dialog). Die Wahl lässt sich später nicht ändern; ein unverschlüsseltes Dokument wird durch „in ein neues, verschlüsseltes Dokument kopieren“ umgestellt. Das Merkmal steht in der Dokumentdatei (`meta.sync.enc`) und in Einladungen, **nicht** nur auf dem Server: Ein Client, der ein verschlüsseltes Dokument kennt, verweigert den Klartext-Weg. So kann ein Server ihn nicht zum Klartext zwingen.
- **Was verschlüsselt ist:** Zellen, Spalten, Tabellen, Sichten, Karten (alles im Yjs-Dokument), Dateien und Vorschaubilder.
- **Was der Server weiter sieht:** Dokument-ID, Dokumentname, Größe und Zeitpunkt der Änderungen, Zahl der Dateien und deren Größe, Mitglieder (Konto-Kennungen, Namen, Rollen im Admin-Protokoll). Das Admin-Protokoll bleibt lesbar, damit der Server Zugriffe prüfen kann.
- **Schlüsselverlust:** Die Wiederherstellung des Kontos über „Sichern oder übertragen“ ist zugleich die Schlüssel-Sicherung. Ein anderes Mitglied kann Zugang neu verteilen. Ohne Konto-Sicherung und ohne anderes Mitglied sind die Daten des Servers unlesbar. Das ist der Preis.
- **Nicht unterstützt (zunächst):** Serverumzug (`/import`) eines verschlüsselten Dokuments, serverseitige Auswertung jeder Art.

## Schlüssel

- Jedes Dokument hat Schlüssel pro **Epoche** (1, 2, …), je 32 zufällige Bytes (AES-256-GCM). Neue Daten werden mit der höchsten Epoche verschlüsselt. Wer Mitglied ist, bekommt **alle** Epochen (damit die Vorgeschichte lesbar bleibt).
- **Verteilung:** Ein Admin verpackt jeden Epochenschlüssel für jedes Mitglied einzeln („Schlüsselkiste“): X25519 zwischen dem Konto-Schlüssel des Admins und dem des Mitglieds (aus den Ed25519-Schlüsseln abgeleitet), HKDF-SHA-256, AES-GCM; zugeordnete Daten: `grid-key-v1|doc|epoche|absender|empfänger`. Wegen des festen Schlüsselpaars bestätigt die Kiste zugleich den Absender. Der Empfänger nimmt nur Kisten von Admins aus dem **geprüften** Admin-Protokoll an.
- **Neues Mitglied:** Beim Zulassen (nach der Prüfnummer) legt der Admin die Kisten aller Epochen an. Fehlen sie später (Admin war offline), holt ein Admin-Client das beim Verbinden nach (der Server meldet, wem Kisten fehlen).
- **Mitglied entfernt:** Ein Admin erzeugt die nächste Epoche und verpackt sie für alle Verbliebenen. Alte Daten bleiben für das entfernte Mitglied mit den alten Schlüsseln lesbar (was es schon hatte, lässt sich nicht zurückholen); neue nicht.

## Server-Protokoll (verschlüsselte Dokumente)

Der Server hält keinen Yjs-Zustand mehr, sondern ein nummeriertes Protokoll undurchsichtiger Einträge.

- Eintrag: `epoche (1 Byte) | Nonce (12) | AES-GCM(Yjs-Update)`, zugeordnete Daten `grid-e2e-v1|doc|epoche`.
- WebSocket `hello` bekommt `since` (letzte bekannte Nummer). Server → Client: alle Einträge danach als Binärnachricht Typ `5` (`seq` 8 Byte big-endian, Eintrag), danach Text `{"t":"synced","last":N,"count":C,"epoch":E}`.
- Client → Server: Typ `4` (Eintrag). Der Server vergibt die Nummer, speichert und schickt Typ `5` an **alle** Clients, auch an den Absender (so erfährt er die Nummer).
- Zusammenführen (Compaction) machen die Clients: Meldet `synced` mehr als 200 Einträge, lädt ein Client einen Gesamtzustand hoch (Typ `6`: `upto` 8 Byte + Eintrag). Der Server ersetzt alle Einträge bis `upto` durch diesen einen (mit Nummer `upto`).
- Der Client hält einen Schatten-Zustand (nur, was der Server schon kennt). Daraus bildet er nach dem Verbinden die Differenz zu seinem lokalen Stand und schickt sie als Typ `4`. So gehen Änderungen aus der Offline-Zeit nicht verloren, ohne dass der Server Zustandsvektoren versteht.
- Dateien: `PUT /blob/<doc>/<key>` mit `epoche | Nonce | AES-GCM(Bytes)`; der Server prüft den Hash nicht mehr (der Client prüft nach dem Entschlüsseln, dass SHA-256 stimmt).

## Endpunkte

| Aufruf | Zweck |
|---|---|
| `GET /docs/<doc>/keys` | Kisten für den Aufrufer (alle Epochen); für Admins zusätzlich `missing`: Mitglieder ohne Kiste für die neueste Epoche |
| `PUT /docs/<doc>/keys` | Admin legt Kisten ab: `[{epoch, account, from, box}]` |

## Umsetzung

- Server: `server/src/lib.rs` (`session_enc`, `/docs/<doc>/keys`), Tabelle `keys`, Spalte `docs.enc`; Test `encrypted_documents_store_opaque_entries_and_keys`.
- Client: `src/e2e.ts` (Bausteine, `e2e.test.ts`), `src/docKeys.ts` (Schlüssel holen, verteilen, erneuern), `src/syncClient.ts` (verschlüsselter Modus mit Schatten-Zustand), `src/fileSession.ts` (Anlegen, Verteilen beim Zulassen, Erneuern beim Entfernen), Dialog „Cloud-Synchronisation“ (Häkchen, Schloss).
- Das Merkmal `enc` wird beim Anlegen mit dem Kopf `X-Grid-Enc: 1` am Gründungseintrag gesetzt; Datei, Einladung und Server müssen übereinstimmen, sonst verbindet Grid nicht.
- Der Schatten-Zustand lebt nur im Speicher: nach einem Neustart lädt der Client das (zusammengeführte) Protokoll einmal komplett nach.
- Schlüsselkisten dürfen nur von Admins stammen (Absender aus dem geprüften Protokoll); der Server überschreibt vorhandene Kisten nicht.

## Phasen

1. **Server:** `enc`-Merkmal, Protokoll Typ 4/5/6, Kisten-Endpunkte, verschlüsselte Blobs; Tests.
2. **Client-Kern:** `src/e2e.ts` (Schlüssel, Kisten, Einträge, Dateien), Sync-Verbindung im verschlüsselten Modus; Tests.
3. **Verteilung und Oberfläche:** Dokument verschlüsselt anlegen, Zulassen/Entfernen mit Schlüsselverteilung, Einladung mit Merkmal, Anzeige (Schloss), Hinweis bei fehlenden Schlüsseln.
4. **Später:** Umzug, Umstellen bestehender Dokumente, Gerätezertifikate.
