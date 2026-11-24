# Grid: Rechte (Gruppen)

Stand: Phase 1 gebaut (Modell, Gruppen-Dialog, Anzeige); Phase 2 (signierte Updates und Prüfung) offen. Ergänzt `docs/SYNC.md` (Mitglieder, Admin-Protokoll) und `docs/E2E.md` (Verschlüsselung).

## Entscheidungen

- **Admins** (die Besitzer) dürfen alles. Es gibt einen oder mehrere. Ein Admin bezahlt die Cloud (Abo), wenn das Dokument in der Townwork-Cloud liegt. Das gilt schon heute.
- **Gruppen:** Admins legen Gruppen an, benennen und löschen sie und ordnen Mitglieder zu. Eine Person kann in mehreren Gruppen sein und hat je Tabelle das **höchste** Recht, das eine ihrer Gruppen erlaubt.
- **Rechte gehören immer einer Gruppe**, nie einer einzelnen Person. Je **Tabelle** und je **abgeleitete Tabelle** gibt es drei Stufen: *kein Zugriff*, *lesen*, *schreiben* (schreiben schließt lesen ein). Karten bekommen dieselben Stufen.
- **Keine Rechte an einzelnen Zeilen** oder Spalten. Eine Tabelle ist ganz lesbar oder gar nicht.
- **Relationsspalten** zu einer Tabelle, die man nicht lesen darf, werden **ganz ausgeblendet** (Spalte, Rückverweis, Werte). Formeln und Rollups, die darauf aufbauen, zeigen für diese Person nichts an.
- **Struktur ändern dürfen nur Admins:** Tabellen, Spalten, Relationen, abgeleitete Tabellen, Karten anlegen, umbenennen, ändern, löschen, Spaltenbreiten und Darstellung, Rechte, Gruppen und Aufbewahrung des Änderungsprotokolls. Schreibrecht bedeutet: Zeilen anlegen und löschen, Zellen ändern, Dateien in Zellen ablegen, Verknüpfungen zwischen Zeilen setzen (dafür braucht man Schreibrecht an der Tabelle, die die Relationsspalte enthält, und Leserecht an der Zieltabelle).
- **Ehrlich benannt:** Wegen der Ende-zu-Ende-Verschlüsselung halten alle Mitglieder den Schlüssel für das ganze Dokument. *Lesen* ist deshalb **Sichtbarkeit in Grid, kein Geheimnisschutz**: Wer einen veränderten Client baut, kann Tabellen sehen, für die er kein Leserecht hat. *Schreiben* dagegen wird wirksam durchgesetzt (siehe unten). Wer echte Vertraulichkeit je Tabelle braucht, bräuchte je Tabelle ein eigenes Dokument mit eigenem Schlüssel; das Rechtemodell hängt deshalb an Tabellen-IDs, damit diese Stufe später aufsetzen kann.

## Offene Punkte (mit Vorschlag)

- **Standard:** Ein neues Dokument hat nur die Admins. Wer zugelassen wird, aber in keiner Gruppe ist, sieht nichts (nur den Hinweis „Noch keine Rechte“). *Vorschlag:* Beim Zulassen fragt Grid, in welche Gruppen die Person soll. Zusätzlich kann ein Admin eine Gruppe „Alle Mitglieder“ anlegen (gewöhnliche Gruppe, der neue Mitglieder automatisch zugeordnet werden).
- **Abgeleitete Tabellen:** Sie sind immer nur lesbar. Das Leserecht an einer abgeleiteten Tabelle gilt unabhängig von der Quelle; der Admin entscheidet also bewusst, ob die Auswertung sichtbar sein soll, auch wenn die Quelltabelle verborgen bleibt. Zeigt die Gruppe auf eine Quelle ohne Leserecht, weist Grid beim Vergeben darauf hin.
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

## Phasen

1. **Modell und Anzeige:** neue Eintragstypen (Client und Server), `rightsOf`, Dialog „Gruppen und Rechte“ für Admins (Gruppen, Mitglieder, Matrix Gruppe × Tabelle), Ausblenden und Sperren in der Oberfläche, Tests (Rechteberechnung, Protokollregeln, Ansicht je Rolle).
2. **Signierte Updates und Prüfung:** Versuch zur Zuordnung von Updates zu Tabellen mit Messung, dann Signatur, Prüfung, Verwerfen, Hinweis; Compaction nur durch Admins; Test mit zwei Clients, davon einer bösartig.
3. **Feinheiten:** Beitritt mit Gruppenwahl, Hinweise bei verwaisten Rechten (gelöschte Tabelle), Rechte in der Zeitreise.

## Grenzen

- Lesen ist Sichtbarkeit, nicht Geheimnis (siehe oben).
- Unverschlüsselte Dokumente (Firmenserver mit `--allow-plaintext`) könnten später zusätzlich vom Server geprüft werden; das ist nicht Teil dieses Entwurfs.
- Rechte wirken nur, wenn alle Clients die neue Grid-Version nutzen. Ältere Clients kennen das Protokoll nicht und werden von neuen Clients zurückgewiesen, sobald ein Dokument Gruppen hat.
