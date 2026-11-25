# Grid: Rechte (Gruppen)

Stand: Phase 1 (Modell, Gruppen-Dialog, Anzeige) und Phase 2 (signierte Änderungen, Prüfung beim Empfang) gebaut; Phase 2 ist bisher nur in Einzelteilen und gegen den Server geprüft, noch nicht mit zwei echten Clients. Ergänzt `docs/SYNC.md` (Mitglieder, Admin-Protokoll) und `docs/E2E.md` (Verschlüsselung).

## Entscheidungen

- **Admins** (die Besitzer) dürfen alles. Es gibt einen oder mehrere. Ein Admin bezahlt die Cloud (Abo), wenn das Dokument in der Townwork-Cloud liegt. Das gilt schon heute.
- **Gruppen:** Admins legen Gruppen an, benennen und löschen sie und ordnen Mitglieder zu. Eine Person kann in mehreren Gruppen sein und hat je Tabelle das **höchste** Recht, das eine ihrer Gruppen erlaubt.
- **Rechte gehören immer einer Gruppe**, nie einer einzelnen Person. Je **Tabelle** und je **abgeleitete Tabelle** gibt es drei Stufen: *kein Zugriff*, *lesen*, *schreiben* (schreiben schließt lesen ein). Karten bekommen dieselben Stufen.
- **Keine Rechte an einzelnen Zeilen.** Je Tabelle gibt es außer den drei Stufen die Wahl *spaltenweise*: Dann bekommt die Gruppe je Spalte *kein Zugriff*, *lesen* oder *schreiben* (Abschnitt „Rechte je Spalte“).
- **Relationsspalten** zu einer Tabelle, die man nicht lesen darf, werden **ganz ausgeblendet** (Spalte, Rückverweis, Werte). Formeln und Rollups, die darauf aufbauen, zeigen für diese Person nichts an.
- **Struktur ändern dürfen nur Admins:** Tabellen, Spalten, Relationen, abgeleitete Tabellen, Karten anlegen, umbenennen, ändern, löschen, Spaltenbreiten und Darstellung, Rechte, Gruppen und Aufbewahrung des Änderungsprotokolls. Schreibrecht bedeutet: Zeilen anlegen und löschen, Zellen ändern, Dateien in Zellen ablegen, Verknüpfungen zwischen Zeilen setzen (dafür braucht man Schreibrecht an der Tabelle, die die Relationsspalte enthält, und Leserecht an der Zieltabelle).
- **Ehrlich benannt:** Wegen der Ende-zu-Ende-Verschlüsselung halten alle Mitglieder den Schlüssel für das ganze Dokument. *Lesen* ist deshalb für Spalten ohne Verschlüsselung **Sichtbarkeit in Grid, kein Geheimnisschutz**; vertrauliche Spalten sind dagegen je Spalte verschlüsselt (Abschnitt „Verschlüsselung je Spalte“). Bei den übrigen: Wer einen veränderten Client baut, kann Tabellen sehen, für die er kein Leserecht hat. *Schreiben* dagegen wird wirksam durchgesetzt (siehe unten). Wer echte Vertraulichkeit je Tabelle braucht, bräuchte je Tabelle ein eigenes Dokument mit eigenem Schlüssel; das Rechtemodell hängt deshalb an Tabellen-IDs, damit diese Stufe später aufsetzen kann.

## Offene Punkte (mit Vorschlag)

- **Standard:** Ein neues Dokument hat nur die Admins. Wer zugelassen wird, aber in keiner Gruppe ist, sieht nichts (nur den Hinweis „Noch keine Rechte“). *Vorschlag:* Beim Zulassen fragt Grid, in welche Gruppen die Person soll. Zusätzlich kann ein Admin eine Gruppe „Alle Mitglieder“ anlegen (gewöhnliche Gruppe, der neue Mitglieder automatisch zugeordnet werden).
- **Abgeleitete Tabellen:** Das Leserecht an einer abgeleiteten Tabelle gilt unabhängig von der Quelle; der Admin entscheidet also bewusst, ob die Auswertung sichtbar sein soll, auch wenn die Quelltabelle verborgen bleibt. Zeigt die Gruppe auf eine Quelle ohne Leserecht, weist Grid beim Vergeben darauf hin. **Schreiben** ist möglich, wenn die Sicht dafür taugt (Abschnitt „Schreiben über Sichten“).
- **Admin entfernen/herabstufen:** Wie bisher bleibt mindestens ein Admin. Admins gehören keiner Gruppe an.

## Datenmodell (Admin-Protokoll)

Das Protokoll (`src/adminLog.ts`, `server/src/adminlog.rs`) bleibt die einzige Quelle der Wahrheit, signiert und verkettet. Neue Eintragstypen, nur von Admins:

| Typ | Wirkung |
|---|---|
| `group` | Gruppe anlegen oder umbenennen (`subject` = Gruppen-ID, `name` = Name) |
| `ungroup` | Gruppe löschen (entfernt auch ihre Zuordnungen und Rechte) |
| `join-group` / `leave-group` | Mitglied (`subject` = Konto) in eine Gruppe aufnehmen oder entfernen (Gruppen-ID in einem eigenen Feld) |
| `grant` | Recht einer Gruppe an einem Objekt setzen (Tabellen-, Sicht- oder Karten-ID, Stufe `none`/`read`/`write`) |

Daraus berechnet jeder Client dieselben **wirksamen Rechte** (`rightsOf(konto, objekt)`): Admin → schreiben; sonst das Maximum der Stufen aller Gruppen der Person; ohne Eintrag → kein Zugriff. Server und Client prüfen die neuen Typen mit denselben Regeln wie bisher; das Format der Einträge wird um die nötigen Felder erweitert, ein gemeinsamer Testvektor deckt sie ab.

## Durchsetzen

**Anzeige (Phase 1):** Tabellen ohne Leserecht verschwinden aus den Reitern; Relationsspalten auf unlesbare Tabellen werden ausgeblendet; bei *lesen* sind Zellen, „+ Zeile“, Löschen, Dateien und Relationen gesperrt; Strukturbefehle (Spalten, Tabellen, Relationen, Karten, Aufbewahrung, Rechte) gibt es nur für Admins. Das Änderungsprotokoll und die Zeitreise zeigen nur Einträge lesbarer Tabellen.

**Schreiben wirksam durchsetzen (Phase 2):**
- Jede Änderung geht signiert hinaus: Im verschlüsselten Eintrag steht zusätzlich *Konto-Kennung des Autors* und eine Ed25519-Signatur über Dokument, Epoche und Hash des Updates. Der Server sieht davon nichts.
- Jeder Client prüft jedes eingehende Update: Signatur gültig, Autor im geprüften Protokoll Mitglied, und die Änderung betrifft nur Tabellen, an denen er mindestens *schreiben* darf (Admins: alles). Nur dann wird das Update angewendet. Sonst verwirft es der Client und meldet es im Änderungsprotokoll als abgelehnt.
- Wie das Update den betroffenen Objekten zugeordnet wird, ist der heikle Teil und wird zuerst als Versuch gebaut: das Update auf einer Kopie des Dokuments anwenden und die geänderten Tabellen aus den Beobachtern lesen. Das kostet bei großen Dokumenten; Ziel ist, nur Updates von Nicht-Admins so zu prüfen und die Kosten zu messen (100.000 Zeilen).
- Folgen: Spätere Updates, die auf einem verworfenen aufbauen, bleiben in Yjs „wartend“. Das trifft praktisch nur den Autor des unerlaubten Updates; Änderungen anderer Mitglieder hängen nur an ihm, wenn sie dieselben Zeilen weiterbearbeiten.
- Zusätzlich verwirft Grid beim **Öffnen einer Datei** oder beim Nachladen des Gesamtzustands (Zusammenführen, Compaction) nichts rückwirkend: Der Gesamtzustand wird von einem Client hochgeladen, der ihn selbst geprüft hat; Grid vertraut also darauf, dass die Compaction nur von Clients kommt, die nach dem Protokoll dazu berechtigt sind (Admins). *Entscheidung nötig:* Compaction nur durch Admins, damit kein Nicht-Admin unerlaubte Änderungen in einen Gesamtzustand hineinschreiben kann.

## Phase 1 (gebaut): Umsetzung und Festlegungen

- **Protokoll:** `src/adminLog.ts` und `server/src/adminlog.rs` kennen die Typen `group`, `ungroup`, `join-group`, `leave-group`, `grant`. Der Server prüft Unterzeichner (Admin) und Format; die Gruppen wertet nur der Client aus. Unstimmiges (unbekannte Gruppe, Konto ohne Mitgliedschaft) bewirkt nichts, damit eine Kette nie unlesbar wird. Feldbelegung: `group` (`subject` = Gruppen-ID, `name` = Name, `role` = `member`, `subjectPub` = 64 Nullen), `join-group`/`leave-group` (`subject` = Konto, `name` = Gruppen-ID), `grant` (`subject` = Gruppen-ID, `name` = `<Objekt-ID>|none|read|write`).
- **Rechteberechnung:** `src/rights.ts` (`rightsFor`). **Rechteverwaltung beginnt mit der ersten Gruppe:** Bis dahin gilt wie bisher alles für alle Mitglieder (bestehende Dokumente bleiben nutzbar). Mit der ersten Gruppe dürfen Nicht-Admins nur noch, was ihre Gruppen erlauben; wer in keiner Gruppe ist, sieht nichts. Löscht ein Admin die letzte Gruppe, gilt wieder alles für alle.
- **Offline:** Das Admin-Protokoll liegt auch in der Datei (`meta.adminLog`); die Rechte gelten damit ohne Verbindung.
- **Oberfläche:** Dialog „Gruppen und Rechte“ (Mitglieder → „Gruppen und Rechte …“, nur Admins). Ohne Leserecht fehlen Tabelle, Sicht oder Karte in den Reitern. Relationsspalten auf unlesbare Tabellen, Rollups darüber und Formeln oder Texte mit Platzhaltern, die darauf zugreifen, sind ausgeblendet (`src/rightsView.ts`). Bei *lesen* sind Zellen, Relationen, Dateien, „+ Zeile“ und Löschen gesperrt (`<fieldset disabled>` um die Zeilen); auf Karten sind Zeichnen und Ziehen von Markern nur mit Schreibrecht an der Karte bzw. der Tabelle möglich. Struktur (Spalten, Tabellen, Relationen, Sichten, Karten anlegen und ändern, Reihenfolge, Spaltenbreite, Auswertung der Summenzeile) bleibt Admins vorbehalten.
- **Änderungsprotokoll und Zeitreise** nennen Tabellen und Werte; bei aktiver Rechteverwaltung sind sie nur für Admins zugänglich (Menü „Logs“).
- **Noch nicht durchgesetzt:** Das ist reine Oberfläche. Ein veränderter Client kann weiterhin lesen und schreiben; das Schreiben wird erst in Phase 2 geprüft.

## Phase 2 (gebaut): Schreiben wird beim Empfang geprüft

Gilt nur für **verschlüsselte** Dokumente (alle neuen Cloud-Dokumente). In unverschlüsselten Dokumenten bleibt es bei der Oberfläche.

- **Zuordnung (`src/updateScope.ts`):** Ein Update wird nicht angewendet, sondern gelesen: jede neue oder gelöschte Stelle wird über ihre Eltern bis zur Wurzel verfolgt. Ergebnis: geänderte Tabellen (Zeilen, Verknüpfungen, Dateien), geänderte Karten (Objekte), *Struktur* (Tabellen, Spalten, Sichten, Reihenfolge, Einstellungen, Karten selbst), *unbekannt* (Eltern fehlen). Änderungsprotokoll und Profile sind frei. Bereits Bekanntes zählt nicht, deshalb stört ein erneut hochgeladener Gesamtzustand nicht. Kosten gemessen: etwa 0,25 ms je Update bei 20.000 Zeilen, einschließlich Erzeugen und Anwenden.
- **Signierte Hüllen (`src/signedUpdate.ts`):** Sobald es Gruppen gibt, steht im verschlüsselten Eintrag vor dem Update die Kennung des Autors und seine Ed25519-Unterschrift (Art: Änderung oder Gesamtzustand). Ohne Gruppen bleibt der Klartext das bloße Update, damit alte Clients lesefähig bleiben.
- **Der Stand zum richtigen Zeitpunkt:** Jeder Eintrag im Admin-Protokoll trägt vom Server die Stromnummer `at` (nicht unterschrieben): die Nummer des letzten Datenstrom-Eintrags, als er angenommen wurde. Ein Strom-Eintrag Nummer *s* wird nach dem Protokollstand bewertet, dessen `at` < *s* ist (der Eintrag `at` selbst kam noch vor dem Protokolleintrag) (`RightsTimeline` in `src/updateGuard.ts`). So urteilen alle Clients über dieselbe Änderung gleich, auch spät hinzugekommene: Was ein Autor vor einem Entzug schrieb, bleibt gültig, was danach kommt, wird abgelehnt. Beim Umzug auf einen anderen Server bekommen alle Einträge `at` = 0.
- **Prüfung (`judge`):** Ohne Gruppen am Stand von *s* gilt alles. Mit Gruppen muss die Änderung unterschrieben sein, vom Mitglied stammen, die Unterschrift muss stimmen, und die Änderung darf nur Tabellen und Karten betreffen, an denen der Autor schreiben darf. Struktur und Unbekanntes dürfen nur Admins. Gesamtzustände müssen von einem Admin unterschrieben sein. Abgelehntes kommt weder ins Dokument noch in den Schatten-Zustand, also auch nie in einen Gesamtzustand; die Oberfläche zählt die abgelehnten Änderungen im Cloud-Dialog.
- **Zusammenführen:** Mit Gruppen führen nur Admins zusammen (Client und Server). Der Gesamtzustand ist aus dem Schatten-Zustand gebildet, der nur Geprüftes enthält, und vom Admin unterschrieben. Ein Admin, der sich verbindet, führt bei Bedarf zusammen.
- **Mitgliederliste aktuell:** Eingehende Änderungen warten, bis die Mitgliederliste geladen ist (neues Mitglied: erst abholen), sonst käme Ungeprüftes ins Dokument.
- **Folgen und Grenzen:** Spätere Änderungen anderer, die auf einer abgelehnten aufbauen, bleiben in Yjs wartend. Der Autor einer abgelehnten Änderung sieht sie bei sich weiter. Lesen bleibt Sichtbarkeit. Ältere Clients ohne diese Version werden ab dem ersten Gruppeneintrag nicht mehr verstanden und ihre Änderungen abgelehnt. Der Server muss in der neuen Version laufen (er vergibt `at` und beschränkt das Zusammenführen).

## Phasen

1. **Modell und Anzeige:** neue Eintragstypen (Client und Server), `rightsOf`, Dialog „Gruppen und Rechte“ für Admins (Gruppen, Mitglieder, Matrix Gruppe × Tabelle), Ausblenden und Sperren in der Oberfläche, Tests (Rechteberechnung, Protokollregeln, Ansicht je Rolle).
2. **Signierte Updates und Prüfung:** Versuch zur Zuordnung von Updates zu Tabellen mit Messung, dann Signatur, Prüfung, Verwerfen, Hinweis; Compaction nur durch Admins; Test mit zwei Clients, davon einer bösartig.
3. **Feinheiten:** Beitritt mit Gruppenwahl, Hinweise bei verwaisten Rechten (gelöschte Tabelle), Rechte in der Zeitreise.

## Grenzen

- Lesen ist Sichtbarkeit, nicht Geheimnis (siehe oben).
- Unverschlüsselte Dokumente (Firmenserver mit `--allow-plaintext`) könnten später zusätzlich vom Server geprüft werden; das ist nicht Teil dieses Entwurfs.
- Rechte wirken nur, wenn alle Clients die neue Grid-Version nutzen. Ältere Clients kennen das Protokoll nicht und werden von neuen Clients zurückgewiesen, sobald ein Dokument Gruppen hat.

## Schreiben über Sichten

Eine Gruppe kann an einer abgeleiteten Tabelle *Schreiben* bekommen, ohne an der Quelltabelle etwas zu dürfen. Dann darf sie genau die Zeilen der Quelltabelle ändern, anlegen und löschen, die den Bedingungen der Sicht genügen.

- **Wann taugt eine Sicht dafür** (`src/viewWrite.ts`, `writeBlocker`): keine Gruppierung, und alle wirksamen Bedingungen beziehen sich auf Spalten der Quelltabelle, deren Wert in der Zeile selbst steht (Text, Zahl, Datum, Auswahl, Kontrollkästchen). Bedingungen auf Relationen, Rollups, Formeln oder Vorlagen hängen von anderen Zeilen ab und lassen sich nicht verlässlich prüfen. Der Dialog „Gruppen und Rechte“ bietet *Schreiben* nur für taugliche Sichten an und nennt sonst den Grund.
- **Regeln beim Empfang** (`src/viewJudge.ts`, aufgerufen aus `judge`): Für jede geänderte Zeile einer Tabelle ohne Schreibrecht muss eine schreibbare Sicht des Autors existieren, bei der die Zeile
  - *geändert* wird: vorher **und** nachher den Bedingungen genügt (fremde Zeilen lassen sich weder ändern noch hereinholen, eine Zeile kann die Sicht nicht verlassen; Bedingungsspalten dürfen geändert werden, solange der neue Wert passt);
  - *angelegt* wird: nachher genügt (die Zeile muss in einer einzigen Änderung mit ihren Werten entstehen; eine leere Zeile genügt „Typ ist X“ nicht);
  - *gelöscht* wird: vorher genügte.
  Ausgeblendete Spalten (Tabelleneinstellung „ausgeblendet“) bleiben unverändert, die Reihenfolge der übrigen Zeilen auch. Verknüpfungen und Dateien an der Tabelle sowie alles andere (Struktur, Karten) verlangen weiterhin das Recht an der Tabelle bzw. Admins. Zeitmarken und Autonummern schreibt Grid selbst und werden nicht geprüft.
- **Wie der Zustand „nachher“ entsteht:** Das Update wird zur Probe auf ein Arbeitsabbild des Dokuments angewendet (`probeDoc`), das mit einem Differenz-Update auf dem Stand des echten gehalten wird; wird abgelehnt oder hat es Angenommenes, das das echte nicht hat, wird es neu aufgebaut. Alle Clients bewerten in Strom-Reihenfolge, sehen also denselben Zustand; auch ein spät Beigetretener kommt zum selben Ergebnis (Ende-zu-Ende-Test).
- **Oberfläche:** Zellen einer nicht gruppierten Sicht sehen aus wie in der Tabelle und sind direkt bearbeitbar, wenn man an der Tabelle oder Spalte schreiben darf, oder wenn man an der Sicht schreibt und die Spalte eine sichtbare Wertspalte ist, auf die sich keine Bedingung bezieht (so kann die Eingabe die Zeile nie aus der Sicht schieben). Während getippt wird, bleiben Zeilen und Reihenfolge stehen. Eine schreibbare Sicht zeigt außerdem „+ Zeile“ und ein Löschkreuz; ein Klick auf eine nicht direkt bearbeitbare Zelle öffnet das Formular nur mit den Wertspalten, die die Sicht zeigt – dort ändert man auch Bedingungsspalten. Auswahlspalten bieten nur Werte an, die die Bedingungen auf diese Spalte zulassen (`allowedOptions`); bei „ist gleich“ unter „alle Bedingungen“ ist der Wert vorbelegt (`presetValues`); beim Speichern prüft `rowMatches` dieselben Regeln wie später der Empfang und meldet, wenn die Zeile nicht passen würde. Bei „enthält“, Zahl- oder Datumsgrenzen gibt es keine Auswahl, nur diese Meldung.
- **Grenzen:** Lesen bleibt Sichtbarkeit. Eine Sicht, deren Definition ein Admin nachträglich unschreibbar macht, gewährt kein Schreiben mehr (die Prüfung beim Empfang prüft die Definition zum Zeitpunkt der Änderung). Rich-Text-Felder im Formular sind nur bedingt gesperrt.

## Rechte je Spalte

Bei einer Tabelle wählt der Admin statt *lesen* oder *schreiben* die Stufe *spaltenweise* und legt je Spalte fest, ob die Gruppe sie nicht sieht, lesen oder schreiben darf. Spalten sind Objekte mit eigener ID; das Recht steht im selben Eintrag (`grant`, `<Spalten-ID>|<Stufe>`), das Protokollformat und der Server bleiben unverändert. „Spaltenweise“ heißt: kein Recht an der Tabelle selbst, aber Rechte an Spalten. Gilt beides, zählt je Spalte die höhere Stufe (`rights.colAccess`); so geht auch „Tabelle lesen, Spalte X schreiben“.

- **Sichtbarkeit:** Eine Tabelle ist sichtbar, wenn die Gruppe sie lesen darf oder an mindestens einer ihrer Spalten ein Recht hat. Spalten ohne Leserecht fehlen in Tabelle, Formular, Rückverweisen und Suche der Auswahl. Mit ihnen verschwindet, was auf ihnen aufbaut: Formeln und Texte mit Platzhaltern darauf und Rollups über sie (`hiddenByRights`). Die Darstellung (Titel, Untertitel, Avatar) einer Tabelle richtet sich weiter nach den Einstellungen des Admins und kann eine Spalte zeigen, die die Gruppe sonst nicht sieht.
- **Schreiben (Durchsetzen beim Empfang, `columnReason` in `src/viewJudge.ts`):** Jede geänderte Zelle, Verknüpfung oder Datei muss in einer Spalte liegen, für die der Autor Schreibrecht hat (`updateScope` liefert dafür je Zeile die berührten Spalten und die Spalten der Verknüpfungen). Zeitmarken und Autonummern schreibt Grid selbst und werden nicht geprüft.
  - *Zeile anlegen* geht, wenn alle gefüllten Spalten beschreibbar sind. Der Anlegen-Knopf erscheint, sobald mindestens eine Spalte beschreibbar ist; gesperrte Felder bleiben leer.
  - *Zeile löschen* und *Zeilen umsortieren* verlangen das Schreibrecht an der ganzen Tabelle, weil sie auch die fremden Spalten betreffen.
  - Eine Verknüpfung setzt, wer an der Relationsspalte schreiben darf; ein Rückverweis gehört der Relationsspalte der anderen Tabelle.
  - Wer an einer Tabelle weder ganz noch spaltenweise schreiben darf, kann weiter über eine schreibbare abgeleitete Tabelle schreiben. Das Recht an einer Sicht gilt für deren Spalten wie bisher; die Spaltenrechte der Quelltabelle gelten nur für den direkten Zugriff.
  - Änderungen, die teils über Spalten und teils über eine Sicht erlaubt wären, werden abgelehnt: jede Tabelle einer Änderung wird als Ganzes auf einem der Wege geprüft.
- **Grenzen:** Ohne Verschlüsselung bliebe Lesen Sichtbarkeit; echten Schutz geben die vertraulichen Spalten (nächster Abschnitt). Änderungsprotokoll und Zeitreise bleiben bei aktiver Rechteverwaltung Admins vorbehalten.

## Verschlüsselung je Spalte (vertrauliche Spalten)

Damit *Lesen* echten Schutz bedeutet, verschlüsselt Grid die Zellen jeder Spalte, die nicht jedes Mitglied lesen darf. Es gibt dafür keinen Schalter und im Gruppen-Dialog keine neue Einstellung; die Rechte bestimmen es (`planColumns` in `src/colKeys.ts`).

- **Regel:** Eine Wertspalte (Text, Zahl, Datum, Auswahl, Kontrollkästchen, Link, Dauer, Person, Koordinaten) ist *vertraulich*, sobald es Gruppen gibt und mindestens ein Mitglied sie nicht lesen darf. Mitglieder ohne Gruppe zählen mit: Das Dokument ist also ab der ersten Gruppe fast ganz verschlüsselt. Leser sind Admins, Gruppen mit Recht an der Spalte oder an der ganzen Tabelle und Gruppen mit Recht an einer abgeleiteten Tabelle, die die Spalte zeigt, filtert, gruppiert oder summiert. Verknüpfungen und Dateien bleiben unverschlüsselt.
- **Sticky:** Eine einmal vertrauliche Spalte bleibt es, auch wenn später alle lesen dürfen (die Schlüssel gehen dann an alle).
- **Format** (`src/colCrypt.ts`): Zellwert `gce1:<kid>:<base64(Nonce 24 | XChaCha20-Poly1305(JSON des Werts))>`; zugeordnete Daten `grid-col-v1|<Spalte>|<kid>`. Die Schlüssel stehen in `colkeys` im Dokument: `<Spalte>|<kid>` → `{n}` (der mit größtem `n`, bei Gleichstand kleinstem `kid`, ist der neueste) und `<Spalte>|<kid>|<Konto>` → `{from, box}`, die Schlüsselkiste (wie beim Dokumentschlüssel: X25519 zwischen den Konto-Schlüsseln, HKDF, AES-GCM) von Admin `from`. Nur Admins schreiben `colkeys` (für alle anderen ist es Struktur); Kisten gelten nur von Admins aus dem geprüften Protokoll. Der Server ändert sich nicht.
- **Abgleich** (`reconcileColumns`, auf Admin-Geräten, wenn Rechte, Mitglieder oder Spalten sich ändern und nach dem Verbinden): legt Schlüssel an, verpackt sie für neue Leser, verschlüsselt vorhandenen Klartext und ältere Schlüssel neu. Kennt jemand den neuesten Schlüssel, ohne Leser zu sein (Recht entzogen, Mitglied entfernt), gibt es einen neuen Schlüssel nur für die übrigen Leser, und alle Zellen werden neu verschlüsselt. Mehrere Admins gleichzeitig sind unkritisch: es gewinnt der Schlüssel mit dem kleinsten `kid`, der nächste Abgleich schlüsselt um. Beim Ändern von Rechten im Gruppen-Dialog läuft der Abgleich vorher mit dem Stand *nach* der Änderung (`changeGroups`), damit nie Klartext in einer Spalte stehen bleibt, die jemand nicht mehr lesen darf.
- **Lesen und Schreiben:** Zellen werden an einer Stelle ent- und verschlüsselt (`plainOf`, `sealCell`); wer den Schlüssel nicht hat, sieht in der Spalte ein Schloss, kann dort nicht schreiben und bekommt von Formeln, Sortierung und Suche nichts. Schreibrecht ohne Schlüssel (der Admin hat ihn noch nicht gesendet) wirkt wie Lesen.
- **Beim Empfang** (`ciphertextReason`): Was ein Nicht-Admin in eine vertrauliche Spalte schreibt, muss mit einem Schlüssel der Spalte verschlüsselt (oder leer) sein, sonst wird die Änderung abgelehnt. Ein Wert, der gerade beim Schützen der Spalte als Klartext unterwegs ist, wird dadurch verworfen.
- **Abgeleitete Tabellen:** Eine Sicht mit Bedingung auf eine vertrauliche Spalte ist nicht schreibbar (`writeBlocker`), denn jedes Mitglied prüft beim Empfang die Bedingungen und müsste den Wert lesen können. Bedingungsspalten einer schreibbaren Sicht werden deshalb nicht neu geschützt; der Dialog nennt sie beim Vergeben.
- **Änderungsprotokoll:** Werte vertraulicher Spalten stehen nicht im Protokolltext. Die Schritte zum Rückgängigmachen (Zeitreise) enthalten den gespeicherten, also verschlüsselten Wert; Admins mit Schlüssel sehen frühere Stände entschlüsselt.
- **Grenzen:** Was schon vor der Verschlüsselung im Dokument stand, bleibt in früheren Ständen, bis ein Admin verdichtet (Klartext im Änderungsprotokoll, in Zeitreise-Schritten und in älteren Gesamtzuständen auf dem Server). Wer eine Spalte einmal gelesen hat, behält, was er gesehen hat. Spaltennamen, Auswahloptionen, Zeilenanzahl, Zeitpunkte und die ungefähre Länge der Werte bleiben sichtbar. Die Datentabellen in der .grid-Datei (`d_<id>`) enthalten den Chiffretext. Gleichzeitig mit dem Schützen einer Spalte geschriebene Klartextwerte werden abgelehnt (selten, der Wert muss neu eingegeben werden). Echte Vertraulichkeit gilt nur, solange Kisten und Protokoll echt sind; ein Server kann keine Kisten fälschen, weil sie von Admin-Schlüsseln aus dem geprüften Protokoll stammen müssen.
