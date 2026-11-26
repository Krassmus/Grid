# Grid: Synchronisation, Konten und Mitglieder

Stand: Phase 1 (Sync), Phase 2 (Konten), Phase 3 (Mitglieder), der Kern von Phase 4 (Abo und Speicher, ohne Zahlungsabwicklung) und Phase 5 (mehrere Server) sind gebaut; offen sind die Zahlungsabwicklung und die Beglaubigung von Konten durch townwork.eu. Dieses Dokument ist die gemeinsame Grundlage; Abweichungen im Code gehören hier nachgetragen.

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

**Lebenszeichen.** Eine Strecke kann abreißen, ohne dass eine Seite davon erfährt (Ruhezustand, Wechsel zwischen WLAN und Mobilfunk, App im Hintergrund); die Verbindung sieht dann offen aus, aber nichts kommt an. Ein Server, der Lebenszeichen beantwortet, meldet das bei der Anmeldung: `{"t":"ok","ping":true}`. Der Client schickt nach 25 Sekunden Stille `{"t":"ping"}`, der Server antwortet `{"t":"pong"}`; kommt binnen 15 Sekunden nichts an (und läuft kein Upload mehr), gibt der Client die Verbindung auf und verbindet neu. Nach dem Ruhezustand, bei der Rückkehr in die App und bei neuem Netz fragt er sofort nach (Frist 5 Sekunden). Gefragt wird erst, wenn der erste Abgleich angekommen ist; bis dahin gilt eine Frist von 30 Sekunden für die Anmeldung und 5 Minuten zwischen zwei Nachrichten. Bei älteren Servern ohne `ping` baut der Client bei neuem Netz oder nach längerer Abwesenheit (2 Minuten) neu auf. Anfragen über HTTP haben eine Frist von 30 Sekunden, Dateien von 10 Minuten. Code: `src/heartbeat.ts`, `src/syncClient.ts`.

Scheitert in einem verschlüsselten Dokument die Verarbeitung eines Eintrags unerwartet, verbindet der Client neu und holt ihn noch einmal; scheitert er wieder, lässt er ihn aus und führt in dieser Sitzung nicht mehr zusammen (der Gesamtzustand wäre unvollständig).

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

#### Konto, Profil und E-Mail-Wiederherstellung (gebaut)

- **Profil** (Name, E-Mail-Adresse, Avatar) gilt für alle Dokumente und liegt nur auf dem Gerät. Der Name geht in Beitrittsanfragen und ins Mitgliederprotokoll ein; man gibt ihn nicht mehr je Dokument an. **Für andere Mitglieder** trägt jeder Client Name und Avatar in das Dokument selbst ein (Yjs-Map `profiles`, Schlüssel = Konto-Kennung); sie reisen also mit den Dokumentdaten und sind bei verschlüsselten Dokumenten für den Server unlesbar. Angezeigt werden nur eingebettete JPEG/PNG-Bilder bis 100 KB, keine fremden Adressen. Jedes Mitglied kann technisch jeden Eintrag überschreiben (wie jede andere Zelle); maßgeblich für Namen und Rollen bleibt das signierte Mitgliederprotokoll. Mac: Menü „Grid → Konto …“; iPad: Knopf rechts in der Kopfzeile über den Blättern (links dort „‹ Dokumente“) und in der Dokumentenliste.
- **Adresse bestätigen:** `POST /me/email {email}` schickt einen sechsstelligen Code (15 Minuten gültig, nur als Hash gespeichert, höchstens 5 Versuche); `POST /me/email/confirm {code}` bestätigt. Die Adresse gehört danach nur diesem Konto; `DELETE /me/email` entfernt sie samt Wiederherstellungsdaten. Höchstens 5 Codes je Konto und Adresse und Stunde.
- **Wiederherstellung einrichten:** `PUT /me/recovery` legt den **mit einem Passwort verschlüsselten** Kontotext ab (derselbe wie „Sichern oder übertragen“, PBKDF2 + AES-GCM; Passwort mindestens 10 Zeichen). Der Server kennt das Passwort nie.
- **Auf einem neuen Gerät:** `POST /recover/start {email}` (immer `204`, verrät nicht, ob es die Adresse gibt) schickt einen Code; `POST /recover/finish {email, code}` liefert `{id, account}` (der Code gilt einmal). Grid entschlüsselt den Text mit dem Passwort lokal; bei Tippfehler versucht es derselbe Text erneut.
- **Grenze:** Wer das Postfach lesen kann, bekommt den verschlüsselten Text und kann das Passwort durchprobieren. Darum Mindestlänge, Begrenzung der Codes und der Hinweis, ein langes Passwort zu nehmen. Die E-Mail verleiht keinen Zugang zu Dokumenten: die Daten sind Ende-zu-Ende verschlüsselt, der Schlüssel steckt im Konto.
- **Server einrichten:** `GRID_MAIL_FROM` (Absender, schaltet das Ganze ein) und optional `GRID_MAIL_COMMAND` (Programm, das die Nachricht samt Kopfzeilen von der Standardeingabe liest; Standard `/usr/sbin/sendmail -t -i`). Ohne `GRID_MAIL_FROM` sind die Endpunkte abgeschaltet (`404`).

### 3. Besitz und Mitglieder (Phase 3, gebaut)

**Admin-Protokoll.** Mitglieder und Admins stehen **nicht** im Yjs-Dokument (jeder Schreibende könnte sie ändern), sondern in einer Kette signierter Einträge, je Dokument. Ein Eintrag:
`{v, doc, seq, prev, type, actor, subject, subjectPub, role, name, time, sig}`

- `type`: `genesis` (Gründung: Ersteller = erster Admin, `actor == subject`), `set` (Mitglied hinzufügen oder Rolle/Namen ändern), `remove`, `move` (Umzug auf einen anderen Server ankündigen: `name` = neue Server-Adresse, `subjectPub` = Schlüssel des neuen Servers, `subject` = `actor`; ändert keine Mitglieder).
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

### 4. Cloud townwork.eu (Phase 4: Abo und Speicher gebaut, Zahlung offen)

**Grundsatz:** Lesen geht immer, Schreiben braucht ein Abo. Nie werden Daten als Geisel gehalten.

- Der Server hat zwei Betriebsarten: ohne `--billing` (eigenes Netz, Intranet) ist alles frei; mit `--billing` (Cloud) gilt das Folgende.
- Jedes Konto hat ein **Abo**: `free` oder `paid` mit Ablaufzeit (`paid_until`, leer = unbefristet) und **Speicher** (`quota`, Bytes). Kostenlose Konten dürfen Mitglied in Dokumenten anderer sein, besitzen aber selbst keinen Speicher.
- Jedes Dokument hat einen **Besitzer** (der Ersteller, aus dem Anfang des Admin-Protokolls abgeleitet) und einen **Zahler**: der Besitzer, solange sein Abo läuft, sonst der erste Admin mit laufendem Abo. Gibt es keinen, ist das Dokument für alle nur lesbar.
- Speicher = Update-Protokoll plus Dateien. Der Verbrauch aller Dokumente eines Besitzers zählt gegen dessen Speicher; die Grenze ist weich (der Schreibvorgang, der sie überschreitet, geht noch durch).
- Schreiben wird abgelehnt, wenn kein Zahler da ist oder der Speicher voll ist: WebSocket-Updates werden nicht übernommen (der Server meldet `{"t":"readonly","code":"no-plan|quota","reason":"…"}`), Datei-Uploads bekommen `402`. Der Client behält alle Änderungen lokal und gleicht ab, sobald es wieder geht (`{"t":"writable"}`; der Abgleich passiert beim nächsten Schreiben, beim Neuverbinden und alle 60 Sekunden).
- `GET /me`: Abo, Ablauf, Speicher, Verbrauch, Abrechnung an/aus, Link „Abo verwalten“ (`GRID_MANAGE_URL`). Grid zeigt das im Dialog „Cloud-Synchronisation“.
- Abo setzen (bis die Zahlungsabwicklung steht): `grid-server accounts plan <Kennung> paid --until 2027-12-31 --quota 5GB` bzw. `free`. Für einen Webshop oder Zahlungsabwickler gibt es dieselbe Funktion per HTTP: `PUT /admin/accounts/<Kennung>/plan {"plan":"paid","paidUntil":<Unix-Sekunden>,"quota":<Bytes>}` und `GET /admin/accounts`, geschützt durch `Authorization: Bearer <GRID_ADMIN_KEY>` (ohne diese Umgebungsvariable ist die Schnittstelle abgeschaltet).

**Noch offen (braucht eigene Konten bei den Anbietern und die rechtliche Klärung):**
- **Web-Zahlung über Stripe (gebaut, braucht noch dein Stripe-Konto):** In Stripe legst du ein Abo-Produkt mit einem *Payment Link* an. Grid zeigt unter „Abo abschließen …“ diesen Link mit angehängter `client_reference_id=<Kontokennung>` (Server: `GRID_CHECKOUT_URL`); die Kundenverwaltung von Stripe (*Customer Portal*) steht unter „Abo verwalten …“ (`GRID_MANAGE_URL`). Stripe meldet Zahlungen an `POST /billing/stripe` (Server: `GRID_STRIPE_WEBHOOK_SECRET`, Signatur `Stripe-Signature` wird geprüft, Zeitstempel höchstens 5 Minuten alt). Ereignisse: `checkout.session.completed` (Konto ↔ Kunde zuordnen, Abo vorläufig 7 Tage), `invoice.paid` (Abo bis Ende des bezahlten Zeitraums plus 3 Tage Nachfrist), `customer.subscription.deleted` (wieder kostenlos). Speicher: `GRID_STRIPE_QUOTA` (Standard 5 GB). Grid prüft nach dem Kauf alle 10 Sekunden nach und lädt aufgelaufene Änderungen hoch, sobald das Abo aktiv ist.
- **In-App-Kauf** (Apple/Google): die App kauft über den Store, schickt den Beleg an den Server, der ihn beim Store prüft und dann dasselbe Abo setzt. Ein Konto, egal über welchen Weg bezahlt wurde; die Store-Gebühr trägt der Preis.
- **E-Mail zum Konto** (Wiederherstellung bei Geräteverlust, Beglaubigung des öffentlichen Schlüssels durch townwork.eu) und eine Einstellung „Konto auf diesem Server nur mit Abo anlegen“ gehören ebenfalls hierher.

#### In-App-Kauf über den App Store (gebaut, Stripe ist optional)

- **Kein Zwischenschritt am Server:** Mit `--open-registration --billing` legt sich jedes Konto selbst an (ohne Abo kann es Mitglied in fremden Dokumenten sein, aber keinen Speicher besitzen). Ein Kauf schaltet das Abo sofort frei; niemand muss etwas bestätigen.
- **Ablauf (iPad/iPhone):** Das Plugin `src-tauri/plugins/tauri-plugin-iap` (Swift, StoreKit 2) kauft mit `appAccountToken = Kontokennung` (die UUID des Grid-Kontos steht so in Apples Beleg). Die App schickt den von Apple **signierten Beleg (JWS)** an `POST /billing/apple/transaction`. Der Server prüft die Signatur (ES256) und die Zertifikatskette bis zum fest eingebauten *Apple Root CA – G3* samt Apples Kennzeichen an den Zertifikaten (`server/src/apple.rs`), ohne bei Apple nachzufragen und ohne Zugangsdaten. Außerdem: richtige App (`bundleId`), bekanntes Produkt, Kontokennung im Beleg = angemeldetes Konto, Beleg nicht erstattet, Abo nicht abgelaufen, Transaktion gehört genau einem Konto.
- **Verlängerungen:** Bei jedem Verbinden meldet die App alle gerade gültigen Käufe des Apple-Kontos (`Transaction.currentEntitlements`), also auch Käufe von einem anderen Gerät. Optional hält Apple den Server über *App Store Server Notifications V2* (`POST /billing/apple/notify`, in App Store Connect als Adresse eintragen) auf dem Laufenden: Verlängerung, Ablauf, Erstattung.
- **Abo und Quelle:** Das Abo gilt bis Ende des bezahlten Zeitraums plus 3 Tage Nachfrist. Jedes Abo merkt seine Quelle: `apple` (Kauf) oder `manual` (Betreiber). Ein Ablauf oder eine Erstattung beendet nur `apple`-Abos; ein von Hand gesetztes bleibt.
- **Zugang ohne Kauf (Freunde, Apple-Prüfung):** `grid-server accounts plan <Kennung> paid --quota 2GB [--until 2027-12-31]` (die Kennung zeigt `grid-server accounts list`; Grid zeigt sie im Dialog „Konto“). Damit braucht es keinen Kauf, und ein gekauftes Abo überschreibt es nicht.
- **Konfiguration:** `GRID_APPLE_BUNDLE_ID` (z. B. `eu.townwork.grid`), `GRID_APPLE_PRODUCTS="eu.townwork.grid.cloud.monthly=2GB,eu.townwork.grid.cloud.yearly=2GB"` (Produkt = Speicher), `GRID_APPLE_SANDBOX=1` (auch Test-Belege annehmen: nötig für TestFlight und die Prüfung durch Apple), `GRID_TERMS_URL` und `GRID_PRIVACY_URL` (Apple verlangt beide in der Kaufansicht).
- **Mac:** Ein Abo gehört zum Grid-Konto, nicht zum Gerät: wer auf dem iPad kauft, hat es auch auf dem Mac. Direkt auf dem Mac kaufen geht erst, wenn Grid dort über den Mac App Store ausgeliefert wird (dieselbe StoreKit-Anbindung).

#### Freier Speicherplatz auf dem Server

- `GRID_MIN_FREE` (Standard 5GB): Fällt der freie Platz auf dem Datenträger darunter, nimmt der Server nichts Neues an (Änderungen und Dateien; Meldung „zu wenig freien Speicherplatz“, Code `disk`). Lesen geht weiter, die Clients behalten ihre Änderungen und laden sie später hoch. `0` schaltet die Prüfung ab.
- `grid-server status` zeigt freien Platz, Zahl der Konten, vergebenen und belegten Speicher und warnt, wenn der offene Rest der vergebenen Kontingente größer ist als der freie Platz. Das Kontingent ist ein Höchstwert; mehr zu vergeben als frei ist, geht, solange nicht alle ihn ausnutzen.

### 5. Mehrere Server (Phase 5, gebaut)

- **Ein Dokument weiß, wohin es gehört:** `meta.sync` in der Datei hält die Server-Adresse und den Schlüssel des Servers. Jedes Dokument kann zu einem anderen Server gehören (townwork.eu, Firmenserver, …); dasselbe Konto gilt überall, braucht aber auf jedem Server eine Freigabe.
- **Identität des Servers:** Jeder Server erzeugt beim ersten Start ein Ed25519-Schlüsselpaar (in seiner Datenbank). `GET /server` liefert Name und öffentlichen Schlüssel; `GET /challenge` enthält zusätzlich eine Signatur des Servers über `grid-server-v1\n<nonce>`. Grid merkt sich den Schlüssel beim ersten Verbinden (Dokumentdatei, lokaler Speicher, Einladung) und verlangt ihn bei jeder Anmeldung. Bei Abweichung bricht Grid ab und bietet „Dem neuen Schlüssel vertrauen“ an. So fällt ein untergeschobener oder neu installierter Server auf, auch wenn das TLS-Zertifikat stimmt. Einladungen tragen den Server-Schlüssel mit.
- **Dokumente werden angelegt, nicht „beansprucht“:** Wer als Erster auf eine unbekannte Dokument-ID zugreift, bekommt nichts mehr automatisch (`denied` mit `code: "unclaimed"`). Der Client legt das Dokument mit seinem Admin-Protokoll an (Gründungseintrag) und verbindet danach erneut.
- **Umzug auf einen anderen Server:** Das Admin-Protokoll liegt auch in der Dokumentdatei (`meta.adminLog`). Beim Verbinden mit einem neuen Server kopiert ein Admin es mit `POST /docs/<doc>/import {entries}` komplett hinüber; der Server prüft die ganze Kette, nimmt sie nur für ein hier unbekanntes Dokument und nur von einem Admin des Protokolls. Mitglieder und Rollen bleiben erhalten; Mitglieder verbinden sich auf dem neuen Server selbst (solange kein Admin umgezogen ist, bekommen sie „Dokument ist hier noch nicht angelegt“). Der alte Server behält seine Kopie.
- **Umzug mitteilen:** Vor dem Umzug trägt der Admin einen `move`-Eintrag in das Protokoll des alten Servers ein (unterschrieben, mit dem Schlüssel des neuen Servers). Die Mitglieder sehen ihn beim nächsten Laden der Mitglieder, Grid zeigt „Dieses Dokument ist umgezogen“ (Pfeil an der Wolke) und bietet „Zum neuen Server wechseln“ an, wobei der Schlüssel des neuen Servers gleich mitgemerkt wird. Der Eintrag wandert mit dem Protokoll auf den neuen Server; dort zeigt er auf sich selbst und löst nichts mehr aus.
- **Intranet-Paket:** `server/Dockerfile` und `deploy/` (Docker Compose mit Caddy als HTTPS-Vorsatz, Anleitung für Zertifikate, Konten, Sicherung).

**Noch offen:** Beglaubigung von Konten durch townwork.eu (E-Mail bestätigt), damit Server solche Konten ohne manuelle Freigabe annehmen können.

### 6. Betrieb

- Ein Server-Programm (Rust, `server/`), eine Datei, eine SQLite-Datenbank pro Server.
- Hinter Apache per Reverse Proxy: siehe `server/README.md`. Firmennetz: `deploy/README.md`.

## Später

Ende-zu-Ende-Verschlüsselung ist gebaut: siehe `docs/E2E.md`. Weiter später: feinere Rechte, Store-Anbindung für iOS/Android.
