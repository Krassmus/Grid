# Grid: Synchronisation, Konten und Mitglieder

Stand: Entwurf, Phase 1 wird gebaut. Dieses Dokument ist die gemeinsame Grundlage; Abweichungen im Code gehören hier nachgetragen.

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

Vor der ersten binären Nachricht schickt der Client eine Text-Nachricht `{"t":"hello","token":"…","name":"Dateiname"}`; der Server antwortet `{"t":"ok"}` oder `{"t":"denied","reason":"…"}` und schließt.
Danach schickt jede Seite Typ 0, die andere antwortet mit Typ 1 (Differenz). Jede lokale Änderung geht als Typ 1 an den Server, der sie speichert und an die anderen Clients des Dokuments verteilt.

Der Server hält je Dokument ein Update-Protokoll (SQLite, wie `ydoc_log` in der Datei) und fasst es ab 200 Einträgen zu einem Gesamtzustand zusammen.

**Dateien/Bilder** (Assets) liegen inhaltsadressiert (SHA-256) neben dem Protokoll:
`GET|PUT /blob/<docId>/<key>` und `GET /blobs/<docId>` (Liste). Schlüssel: `<hash>` oder `<hash>.thumb`. Der Server prüft bei Originalen, dass die Bytes zum Hash passen.

`GET /docs` listet die Dokumente (ID, Name, Änderungszeit), damit ein zweites Gerät ein Dokument aus der Cloud laden kann.

Authentifizierung in Phase 1: ein gemeinsames Token (`Authorization: Bearer …` bzw. `hello`). Das ist ausdrücklich ein Zwischenstand und wird in Phase 2 durch Signaturen ersetzt, ohne dass sich das Sync-Protokoll ändert.

### 2. Identität (Phase 2)

- Konto = Ed25519-Schlüsselpaar plus UUID. Offline anlegbar. Privatschlüssel im Schlüsselbund des Betriebssystems.
- Anmeldung am Server per Challenge-Antwort (Signatur) statt Passwort.
- Mehrere Geräte: jedes Gerät hat einen eigenen Schlüssel, vom Konto-Schlüssel zertifiziert; Kopplung per QR/Kurzcode; verlorene Geräte lassen sich sperren. Sicherung des Konto-Schlüssels als verschlüsselte Datei bzw. Wiederherstellungsphrase.
- townwork.eu beglaubigt öffentliche Schlüssel (E-Mail bestätigt, Abo-Status). Intranet-Server dürfen dem vertrauen oder eigene Beglaubigung nutzen.

### 3. Besitz und Mitglieder (Phase 3)

- Rollen und Mitglieder stehen **nicht** im Yjs-Dokument (jeder Schreibende könnte sie ändern), sondern in einem **Admin-Protokoll**: Kette signierter Einträge. Eintrag 0 gründet das Dokument (Schlüssel des Erstellers = erster Admin), danach „Mitglied hinzu/entfernt“, „Admin hinzu/entfernt“ – jeweils von einem Admin signiert. Server und Clients prüfen die Kette.
- Das Dokument trägt im Kopf: `docId` (UUID), Server-Adresse, Fingerabdruck des Server-Schlüssels.
- Einladen online: per Konto. Im Intranet: Link mit Dokument, Server und Admin-Fingerabdruck; die Person „klopft an“ mit ihrem öffentlichen Schlüssel, der Admin sieht einen Prüfcode (wenige Wörter) zum Abgleich im Gespräch und lässt zu (= signierter Eintrag).
- Feinere Rechte (Lesen/Schreiben, Gruppen, mehrere Admins) kommen später als weitere Eintragstypen.

### 4. Cloud townwork.eu (Phase 4)

- Server-Modul für Konten, Abo und Speicherkontingent: Zugriff nur, wenn mindestens ein Admin des Dokuments ein bezahltes Zusatzkonto hat und das Kontingent nicht überschritten ist.
- Bezahlen: In-App-Kauf über die Stores (Apple/Google); Belege prüft der Server. Ein Konto kann zusätzlich über das Web aktiviert werden, damit niemand doppelt zahlt.

### 5. Betrieb

- Ein Server-Programm (Rust, `server/`), eine Datei, eine SQLite-Datenbank pro Dokument bzw. ein Datenverzeichnis.
- Hinter Apache per Reverse Proxy: siehe `server/README.md`.

## Später

Ende-zu-Ende-Verschlüsselung (dann kann der Server nicht mehr lesen; Schlüsselformate werden vorher so gewählt, dass das möglich bleibt), feinere Rechte, Store-Anbindung für iOS/Android.
