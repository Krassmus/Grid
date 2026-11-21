# Grid: Synchronisation, Konten und Mitglieder

Stand: Phase 1 (Sync), Phase 2 (Konten) und Phase 3 (Mitglieder) sind gebaut; Phase 4 und 5 sind Entwurf. Dieses Dokument ist die gemeinsame Grundlage; Abweichungen im Code gehören hier nachgetragen.

## Ziele

- Ein Dokument ist lokal (Datei) und kann zusätzlich mit einem Server abgeglichen werden. Die lokale Datei bleibt immer vollständig und offline benutzbar.
- Grid ist kostenlos und quelloffen. Der Server ist es auch. Bezahlt wird nur die Cloud auf townwork.eu (Speicher, Betrieb).
- Derselbe Server läuft bei townwork.eu und im Intranet einer Firma. Ein Dokument weiß, zu welchem Server es gehört.
- Ein Konto soll plattformübergreifend zählen (Mac, Windows, Tablet, Store-Käufe).

## Bausteine

### 1. Sync-Protokoll (Phase 1)

WebSocket `wss://<server>/ws/<docId>`, binäre Nachrichten, erstes Byte = Typ (angelehnt an y-protocol):

| Typ | Bedeutung | Nutzlast |
|---|---|---|
| `0` | Sync Schritt 1 | Yjs-Zustandsvektor des Absenders |
| `1` | Update | Yjs-Update (Antwort auf Schritt 1 oder laufende Änderung) |

Vor der ersten binären Nachricht schickt der Client eine Text-Nachricht `{"t":"hello","token":"<Sitzungsschlüssel>","name":"Dateiname"}`; der Server antwortet `{"t":"ok"}` oder `{"t":"denied","code":"expired|forbidden|error","reason":"…"}` und schließt. Bei `expired` meldet sich der Client neu an und versucht es noch einmal.
Danach schickt jede Seite Typ 0, die andere antwortet mit Typ 1 (Differenz). Jede lokale Änderung geht als Typ 1 an den Server, der sie speichert und an die anderen Clients des Dokuments verteilt.

Der Server hält je Dokument ein Update-Protokoll (SQLite, wie `ydoc_log` in der Datei) und fasst es ab 200 Einträgen zu einem Gesamtzustand zusammen.

**Dateien/Bilder** (Assets) liegen inhaltsadressiert (SHA-256) neben dem Protokoll:
`GET|PUT /blob/<docId>/<key>` und `GET /blobs/<docId>` (Liste). Schlüssel: `<hash>` oder `<hash>.thumb`. Der Server prüft bei Originalen, dass die Bytes zum Hash passen.

`GET /docs` listet die Dokumente (ID, Name, Änderungszeit), damit ein zweites Gerät ein Dokument aus der Cloud laden kann.

Der Zugriff auf Dokumente richtet sich nach dem Konto (Abschnitt 2): Ein Dokument gehört zunächst dem Konto, das es als erstes braucht (Tabelle `members`, Rolle `admin`); andere Konten bekommen `403`, bis Phase 3 das Einladen ermöglicht. `GET /docs` zeigt nur Dokumente, in denen das Konto Mitglied ist.

### 2. Identität (Phase 2, gebaut)

- Konto = Kennung (UUID) plus Ed25519-Schlüsselpaar. Es entsteht beim ersten Bedarf auf dem Gerät, ohne Internet. Der geheime Schlüssel liegt im Schlüsselbund des Betriebssystems (macOS, Windows), sonst in einer Datei im Konfigurationsordner (nur für den Benutzer lesbar); im Browser (Entwicklung) im lokalen Speicher.
- Anmeldung statt Passwort:
  1. `GET /challenge` liefert ein Rätsel `{"nonce":"<Zeit>.<Beglaubigung>"}` (60 Sekunden gültig, zustandslos mit dem Server-Geheimnis beglaubigt).
  2. `POST /login {id, pub, nonce, sig}`; `sig` = Ed25519-Signatur über `grid-login-v1\n<id>\n<nonce>`.
  3. Antwort bei freigegebenem Konto: `{"status":"ok","token":"…","exp":…}` (Sitzungsschlüssel, 1 Stunde, `Authorization: Bearer …` bzw. `hello`). Unbekannte Konten werden als **wartend** vermerkt (`403`, `status: pending`); gleiche Kennung mit anderem Schlüssel wird abgelehnt.
- Freigabe: Der Betreiber gibt Konten auf dem Server frei: `grid-server accounts list|approve <Kennung>|remove <Kennung>`. Mit `--open-registration` (oder `GRID_OPEN_REGISTRATION=1`) werden neue Konten sofort freigegeben (eigenes Netz, Tests). Später übernimmt das townwork.eu mit Registrierung und Abo.
- Zweites Gerät: „Sichern oder übertragen“ erzeugt das Konto als Text, mit einem Passwort verschlüsselt (PBKDF2-SHA-256, AES-GCM); auf dem anderen Gerät wird er eingefügt. Gerätschlüssel mit Zertifikaten (verlorene Geräte sperren) kommen später; das Format ist dafür offen.
- townwork.eu beglaubigt später öffentliche Schlüssel (E-Mail bestätigt, Abo-Status). Intranet-Server dürfen dem vertrauen oder eigene Freigabe nutzen.

### 3. Besitz und Mitglieder (Phase 3, gebaut)

**Admin-Protokoll.** Mitglieder und Admins stehen **nicht** im Yjs-Dokument (jeder Schreibende könnte sie ändern), sondern in einer Kette signierter Einträge, je Dokument. Ein Eintrag:
`{v, doc, seq, prev, type, actor, subject, subjectPub, role, name, time, sig}`

- `type`: `genesis` (Gründung: Ersteller = erster Admin, `actor == subject`), `set` (Mitglied hinzufügen oder Rolle/Namen ändern), `remove`.
- `role`: `admin` oder `member`. Beide lesen und schreiben; verwalten dürfen nur Admins. Feinere Rechte kommen später als weitere Eintragstypen.
- Unterschrieben wird (Ed25519 über UTF-8) der Text `grid-admin-v1\n<doc>\n<seq>\n<prev>\n<type>\n<actor>\n<subject>\n<subjectPub>\n<role>\n<name>\n<time>`; `prev` ist der Hash (SHA-256, hex) von Text, Zeilenumbruch und Signatur des vorigen Eintrags (leer beim ersten).
- Regeln: Nummern lückenlos, Verkettung stimmt, Unterschrift vom Schlüssel, der für `actor` in der Kette steht (bei `genesis` der eigene); `actor` ist Admin; der Schlüssel eines Mitglieds lässt sich nicht austauschen; es bleibt mindestens ein Admin.
- Server (`server/src/adminlog.rs`) und Client (`src/adminLog.ts`) prüfen mit denselben Regeln; ein gemeinsamer Testvektor stellt sicher, dass beide dieselbe Signatur und denselben Hash erzeugen.
- Der Server lässt nur Mitglieder an Inhalte (WebSocket, Dateien) und trennt entfernte Mitglieder sofort. Dokumente aus der Zeit vor dem Protokoll gehören dem ersten Konto; dessen Client legt beim nächsten Verbinden automatisch den Anfang der Kette an.

**Endpunkte** (alle mit Sitzungsschlüssel):

| Aufruf | Zweck |
|---|---|
| `GET /docs/<doc>/members` | Rolle des Aufrufers, Protokoll, für Admins die offenen Beitrittsanfragen |
| `POST /docs/<doc>/admin` | neuer Protokolleintrag (`409`, wenn zwischendurch jemand anderes etwas eingetragen hat) |
| `POST /docs/<doc>/join` `{name}` | „Anklopfen“: Beitrittsanfrage (`202`) |
| `DELETE /docs/<doc>/join/<Konto>` | Admin lehnt eine Anfrage ab |

Über die WebSocket-Verbindung kommt `{"t":"members"}`, wenn sich Mitglieder oder Anfragen geändert haben. Ein angeklopftes, noch nicht zugelassenes Konto bekommt `denied` mit `code: "requested"` und versucht es alle 10 Sekunden erneut.

**Einladen.** Ein Admin erzeugt in Grid einen Einladungstext `grid-invite:1:<base64url(JSON)>` mit Server, Dokument-ID, Name und seinem Fingerabdruck (kein Geheimnis darin). Die Person fügt ihn unter „Ablage → Einladung annehmen …“ ein, gibt ihren Namen an und klopft an. Der Admin sieht die Anfrage (Name und **Prüfnummer** = Fingerabdruck des Schlüssels, in der Wolke mit Zähler) und vergleicht die Prüfnummer mit der, die die Person in ihrem Dialog sieht (z. B. am Telefon). Erst dann „Zulassen“, was einen signierten `set`-Eintrag erzeugt. Weil die Person ihre Prüfnummer lokal aus ihrem eigenen Schlüssel ableitet, fällt auch ein untergeschobener Schlüssel auf.

Voraussetzung: Das Konto der Person ist auf dem Server freigegeben (bei offener Registrierung automatisch). Name und Prüfnummer-Wörter statt Hex sind denkbare Verbesserungen.

### 4. Cloud townwork.eu (Phase 4)

- Server-Modul für Konten, Abo und Speicherkontingent: Zugriff nur, wenn mindestens ein Admin des Dokuments ein bezahltes Zusatzkonto hat und das Kontingent nicht überschritten ist.
- Bezahlen: In-App-Kauf über die Stores (Apple/Google); Belege prüft der Server. Ein Konto kann zusätzlich über das Web aktiviert werden, damit niemand doppelt zahlt.

### 5. Betrieb

- Ein Server-Programm (Rust, `server/`), eine Datei, eine SQLite-Datenbank pro Dokument bzw. ein Datenverzeichnis.
- Hinter Apache per Reverse Proxy: siehe `server/README.md`.

## Später

Ende-zu-Ende-Verschlüsselung (dann kann der Server nicht mehr lesen; Schlüsselformate werden vorher so gewählt, dass das möglich bleibt), feinere Rechte, Store-Anbindung für iOS/Android.
