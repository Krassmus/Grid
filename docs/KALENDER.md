# Kalender

Stand: **Phase 1 und 2 sind gebaut**, aus Phase 3 das Verschieben und Verlängern. Offen ist nur die Suche nach freien Objekten (siehe „Phasen“). Abschnitte, die erst spätere Phasen betreffen, sind mit „(Phase 2)“ oder „(Phase 3)“ markiert.

Ein Kalender ist ein Reiter, der die Zeilen einer Tabelle auf einer **Zeitleiste** zeigt: links die Dinge, die belegt werden (Zelte, Räume, Fahrzeuge), nach rechts die Zeit, jede Belegung als Balken. Er ist eine Ansicht wie die Karte: Die Daten bleiben in den Tabellen. Der Kalender ist nicht auf Ausleihe zugeschnitten; er taugt ebenso für Dienstpläne, Urlaub oder Projektphasen.

```
                      Di 1.12.   Mi 2.12.   Do 3.12.   Fr 4.12.   Sa 5.12.   So 6.12.
▾ Zelte (3)
  Jurte               ░░░░░░░░░░░░░░░░░░░░                       ███ Kim ████████████
  Kohte 1                        ████ Alex ██████████████████
  Kohte 2
▾ Technik (2)
  Beamer              ██ Sam ███            ┃██ Kim ███┃
                                            ┃    ███ Alex ███┃    ← Überschneidung (rot)
  Leinwand                                  ███ Kim ████
```

## Anlegen

Man braucht nur eine Tabelle mit dem, was gebucht wird (etwa „Zelte“ oder „Räume“). **+ → „Neuer Kalender …“** legt die Tabelle für die Buchungen gleich mit an (`addBookingCalendar`, ein einziger Rückgängig-Schritt). Der Dialog fragt:

| Frage | Auswahl |
|---|---|
| Was wird gebucht? | eine Tabelle |
| Wer bucht? | Auswahl aus einer Tabelle (etwa „Personen“), Name als Text, oder ohne Angabe („nur belegt“) |
| Zeitraum | ganze Tage oder mit Uhrzeit |
| Name der neuen Tabelle | Vorschlag „Buchungen“ |

Eine Tabelle für die Personen ist also freiwillig. Die neue Tabelle bekommt:

| Wer bucht | Spalten | Beschriftung der Balken |
|---|---|---|
| Auswahl aus einer Tabelle | Objekt, Person (Relationen), Von, Bis, Notiz | die Person |
| Name als Text | Objekt, Name, Von, Bis | der Name |
| ohne Angabe | Objekt, Von, Bis, Notiz | die Notiz |

Die Relationsspalten heißen wie ihre Zieltabelle. „Zieldatensatz darf mehrfach verknüpft werden“ ist an, der Rückverweis aus; je Buchung gibt es höchstens eine Person, aber beliebig viele Objekte. Ist die Beschriftung leer, steht auf einem belegenden Balken „Belegt“. Weitere Spalten (etwa „Status“ für Farbe und „Belegt nicht“) ergänzt man in der Tabelle und stellt sie dann im Kalender ein.

Die neue Tabelle hat **keinen eigenen Reiter**: Sie steht im Menü des Kalenders, so wie abgeleitete Tabellen im Menü ihrer Quelle stehen, und ihre abgeleiteten Tabellen mit ihr. Das merkt sich der Kalender (`ownTable`); in seinen Einstellungen lässt es sich ab- und für eine andere Quelltabelle einschalten. Wird der Kalender gelöscht oder darf jemand ihn nicht sehen, bekommt die Tabelle wieder einen eigenen Reiter. Die Daten bleiben immer erhalten.

Statt eine Tabelle anlegen zu lassen, kann man auch eine **vorhandene** verwenden (mit Datums- und Relationsspalte). Dafür gelten die folgenden Einstellungen; auch bei einem so angelegten Kalender lassen sie sich später ändern.

## Einstellungen eines Kalenders

| Einstellung | Pflicht | Bedeutung |
|---|---|---|
| Name, Symbol | ja | wie bei Karten |
| Tabelle | ja | liefert die Balken (hier „Buchungen“) |
| Beginn | ja | Datumsspalte |
| Ende | nein | Datumsspalte; ohne sie dauert jeder Eintrag so lange wie sein Beginn (ein Tag bzw. ein Zeitpunkt) |
| Zeilen | ja | Relationsspalte; jede Zeile der Zieltabelle wird eine Zeile der Zeitleiste |
| Zeilen gruppieren nach | nein | Auswahlspalte der Zieltabelle (hier „Kategorie“), Gruppen einklappbar |
| Zeilen filtern nach | nein | Auswahl- und Kontrollkästchen-Spalten der Zieltabelle, die als Filter über dem Kalender erscheinen |
| Beschriftung | nein | Spalte auf dem Balken (hier „Person“); ohne Angabe der Titel der Zeile |
| Farbe | nein | Auswahlspalte (hier „Status“); die Farben der Optionen gelten |
| Belegt nicht | nein | Optionen der Farbspalte oder ein Kontrollkästchen, die nicht belegen (etwa „storniert“) |

Beschriftung und Zeilentitel nutzen die Darstellung der Datensätze (`repr.ts`), also auch Avatare.

## Verhalten

### Zeilen

- Alle Zeilen der Zieltabelle erscheinen, **auch die freien**, in der Standardsortierung dieser Tabelle (auch „Manuell“).
- Eine Buchung mit mehreren Objekten erscheint in jeder dieser Zeilen.
- Einträge ohne Objekt stehen unten in „Ohne Zuordnung“; die Zeile gibt es nur bei Bedarf.
- Überlappen sich Balken in einer Zeile, wird die Zeile höher, die Balken stehen untereinander.

### Zeit

- **Nur Datum:** Das Ende zählt mit. Von 3. bis 5. sind drei Tage.
- **Mit Uhrzeit:** Das Ende zählt nicht mit. 14–16 Uhr und 16–18 Uhr überschneiden sich nicht.
- **Gemischt:** Ein Wert ohne Uhrzeit meint den ganzen Tag.
- Ohne Ende gilt der Beginn als Ende. Mit Uhrzeit ergibt das eine schmale Marke, die nichts belegt.
- Ohne Beginn erscheint der Eintrag nicht. Über der Zeitleiste steht dann etwa „3 Einträge ohne Zeitraum“, anklickbar.
- Liegt das Ende vor dem Beginn, erscheint am Beginn eine Marke mit Warnzeichen.
- Zeiten haben keine Zeitzone: Grid zeigt sie so, wie sie eingetragen wurden.

Maßstäbe: **Tag** (Stunden), **Woche**, **Monat**, **Quartal**. Am Anfang gilt Woche, wenn eine der Datumsspalten Uhrzeiten hat, sonst Monat. Dazu Knöpfe für zurück, vor und „Heute“, ein Datumsfeld zum Springen und eine senkrechte Linie für jetzt. Waagerecht kann man auch scrollen. Die Spalte mit den Objekten und die Zeitachse bleiben dabei stehen.

### Suche und Filter

Unten steht dieselbe Fußleiste wie unter einer Tabelle: **„+ Eintrag“** und **„Suchen …“**. Lostippen ohne Fokus landet in der Suche, Escape leert sie.

- **Suche:** findet Zeilen (Titel und Untertitel) und Einträge (Beschriftung). Eine Zeile bleibt, wenn die Suche sie selbst oder einen ihrer Einträge findet; daneben steht „2 von 6“. Ist die Zeile selbst gefunden, erscheinen alle ihre Einträge normal, sonst nur die gefundenen.
- **Zeilen filtern** (oben, welche Objekte?): Auswahlknöpfe für die eingestellten Spalten. Nicht Passendes verschwindet.
- **Balken filtern** (oben, welche Buchungen?): Auswahlknöpfe für die Farbspalte.

Für Einträge gilt bei Suche und Farbfilter:

- Einträge, die **belegen**, werden in einer gezeigten Zeile nur **abgeblasst**. Sonst sähe ein belegtes Objekt frei aus.
- Einträge, die **nicht belegen**, lassen sich ausblenden. Sie sind anfangs ausgeblendet.

Gibt es nichts zu filtern, fehlt die Filterzeile oben.

Filter, Maßstab und eingeklappte Gruppen sind **persönlich** und werden nur auf dem Gerät gespeichert. So kann jedes Mitglied filtern, ohne das Dokument zu ändern. Das angesehene Datum und die Suche werden nicht dauerhaft gemerkt: Beim nächsten Start zeigt der Kalender wieder heute und alle Zeilen. Auf schmalen Bildschirmen (Telefon) stecken die Filter hinter einem Knopf.

### Bedienen

| Aktion | Maus | Finger |
|---|---|---|
| Eintrag öffnen | Klick auf den Balken | Tippen |
| Neuer Eintrag | über eine freie Stelle ziehen (nach rechts oder links), oder „+ Eintrag“ | kurz liegen lassen, dann ziehen, oder „+ Eintrag“; langes Drücken ohne Ziehen wählt ein Rasterfeld |
| Eintrag verschieben | Balken ziehen, auch in eine andere Zeile | kurz liegen lassen, dann ziehen |
| Beginn oder Ende ändern | am linken oder rechten Rand des Balkens ziehen | am Rand kurz liegen lassen, dann ziehen |
| Eintrag löschen | Rechtsklick auf den Balken, oder „Löschen …“ im Formular | lange auf den Balken drücken und ohne Ziehen loslassen, oder im Formular |
| Objekt öffnen | Klick auf den Namen links | Tippen |

- Beides öffnet das gewohnte Formular. Beim Ziehen sind Beginn, Ende und das Objekt der Zeile ausgefüllt (in „Ohne Zuordnung“ nur die Zeiten). „+ Eintrag“ öffnet das leere Formular.
- Während des Ziehens zeigt die Auswahl ihren Zeitraum. Escape bricht ab. Ein bloßer Klick bewirkt nichts. Am Rand rückt die Zeitleiste in Zugrichtung nach.
- Beim Ziehen rasten die Zeiten ein: auf ganze Tage (jeder berührte Tag zählt). Geben Beginn und Ende Uhrzeiten an, rastet es im Tagesmaßstab auf 15 Minuten, im Wochenmaßstab auf volle Stunden (dort wären Viertelstunden nur wenige Pixel breit).
- Ziehen geht nur, wenn man in der Tabelle anlegen und Beginn, Ende und Objekt schreiben darf.
- Darf das Objekt laut Relationsspalte nur einmal verknüpft werden und ist es schon vergeben, bleibt das Feld leer; ein Hinweis erklärt die Einstellung.
- Gelöscht wird erst nach einer Rückfrage; belegt der Eintrag mehrere Zeilen, sagt sie das. Wie in der Tabelle braucht Löschen das Schreibrecht an der ganzen Buchungstabelle. Rückgängig holt den Eintrag zurück. Im Formular eines Objekts (Klick auf den Namen links) gibt es kein Löschen.
- Auf iPad und iPhone bleibt Wischen immer Scrollen. Erst langes Drücken beginnt eine Auswahl.
- **Verschieben** behält die Dauer. Gerastet wird die zurückgelegte Strecke, nicht der Zeitpunkt: Uhrzeiten bleiben erhalten (14:10 wird etwa 14:55). Reine Datumsangaben wandern um ganze Tage; Uhrzeiten im Tagesmaßstab in Viertelstunden, in der Woche in Stunden, sonst um ganze Tage.
- **Ziehen am Rand** lässt mindestens einen Tag bzw. ein Raster übrig. Zieht man den Anfang eines Eintrags ohne Ende, wird sein bisheriger Tag zum Ende. Marken und verdrehte Zeiträume lassen sich nur verschieben; ohne Ende-Spalte gibt es keinen rechten Rand.
- **Zeile wechseln** ersetzt die Verknüpfung der Zeile, aus der gezogen wurde. Weitere Zeilen eines Eintrags bleiben; die Zeiten gelten für alle. Nach „Ohne Zuordnung“ gezogen, wird die Verknüpfung entfernt. Ein Ziel, das nur einmal verknüpft werden darf und schon vergeben ist, nimmt nichts an.
- Während des Ziehens zeigt eine Vorschau Zeilen und Zeitraum, der alte Balken wird blass. Geschrieben wird erst beim Loslassen, in **einem** Rückgängig-Schritt und nur, was sich ändert. Escape bricht ab.
- Jeder Griff erscheint nur, wenn man die betroffenen Spalten schreiben darf.

### Überschneidungen

Zwei Einträge überschneiden sich, wenn sie in derselben Zeile liegen, beide belegen und ihre Zeiten sich überlappen. Anschließendes (14–16 und 16–18 Uhr) zählt nicht. Marken, verdrehte Zeiträume und „Ohne Zuordnung“ belegen nichts.

- Die Balken bekommen einen **roten Rand**, auch vergangene und auch abgeblasste.
- Oben steht „⚠ 2 Überschneidungen“. Gezählt wird, was **noch nicht vorbei** ist, auch außerhalb des Ausschnitts und in weggefilterten Zeilen. Eine Kette sich überschneidender Einträge in einer Zeile zählt einmal. Ein Klick springt reihum zur nächsten Stelle; versteckt Suche, Filter oder eine eingeklappte Gruppe die Zeile, wird sie wieder sichtbar. Die Zeile leuchtet kurz auf.
- Beim **Ziehen** (neu, verschieben, verlängern) wird die Vorschau rot, wenn sie auf Belegtes trifft.
- Das **Formular** warnt schon während des Ausfüllens, je Zeile mit Namen und Zeitraum, höchstens drei: „„Beamer“ ist in dieser Zeit schon belegt: Kim, 03.12.2026 – 05.12.2026“. Das gilt für jedes Formular eines Datensatzes aus der Quelltabelle eines Kalenders, auch aus der Tabelle heraus (`useOverlapWarnings.ts`). Die direkte Eingabe in Tabellenzellen warnt nicht; dort zeigt es der Kalender. Ohne Leserecht an der Beschriftung steht „Belegt“ statt eines Namens.
- Grid **verbietet** Überschneidungen nicht. Wenn zwei Geräte offline dasselbe buchen, entsteht die Überschneidung erst beim Zusammenführen. Sie muss darum sichtbar sein, und Menschen klären sie.

## Rechte

- Anlegen, ändern und löschen dürfen den Kalender nur Admins (Struktur). Gruppen bekommen am Kalender **kein Zugriff** oder **lesen**, wie bei Berichten.
- Das Recht am Kalender gibt keinen Zugriff auf Daten. Eintragen und Ändern richtet sich nach den Rechten an Tabelle und Spalten.
- Fehlt das Leserecht an der Tabelle, an Beginn, Ende, der Zeilen-Spalte oder der Zieltabelle, zeigt der Reiter nur einen Hinweis. Ende ohne Leserecht wegzulassen wäre falsch, weil Belegtes frei aussähe.
- Fehlt es an der Beschriftung, steht auf dem Balken „Belegt“. So kann eine Gruppe sehen, *wann* etwas belegt ist, ohne zu sehen, *von wem*. Bei Relationen ist das aber nur Sichtbarkeit in Grid: Verknüpfungen sind nicht verschlüsselt (docs/RIGHTS.md). Auch die Personen-Tabelle sollte die Gruppe dann nicht lesen dürfen.
- Fehlt es an der Spalte, die über „Belegt nicht“ entscheidet, zählt jeder Eintrag als belegend.
- Rechte an einzelnen Zeilen gibt es nicht: Wer Buchungen schreiben darf, kann auch fremde ändern.

## Technik

- **Dokument:** neue Wurzel `calendars`: `id` → `Y.Map{ name, icon, def }`; die ID steht wie bei Karten in `tableOrder`.

  ```ts
  interface CalendarDef {
    layers: { table: string; start: string; end?: string; lane: string; label?: string; color?: string;
              free?: { col: string; values: string[] } }[]
    groupBy?: string      // Auswahlspalte der Zieltabelle
    filters: string[]     // Spalten der Zieltabelle
    ownTable?: string     // Quelltabelle ohne eigenen Reiter
  }
  ```

  `layers` ist eine Liste, damit später mehrere Quellen in einen Kalender passen (etwa „Buchungen“ und „Wartungen“ auf dieselben Objekte). Alle Relationen müssen dann dieselbe Zieltabelle haben. Die erste Version bietet nur eine Quelle an.
- **Anschließen:** `readTabs`, `useTables`, Rückgängig (`undo.ts`), Gruppen-Dialog und `rightsView`. Beim Löschen einer Tabelle oder Spalte bleibt die Kalender-Einstellung **unverändert**: Fehlt etwas Nötiges, zeigt der Kalender einen Hinweis. Würde etwa das Ende still entfernt, sähe Belegtes frei aus. Fehlende freiwillige Spalten werden übergangen (fehlt die Spalte hinter „Belegt nicht“, belegt jeder Eintrag); beim nächsten Speichern der Einstellung fallen sie weg. `updateScope` stuft den Kalender als Struktur ein. Der Server ändert sich nicht.
- **Rechnen:** ohne Oberfläche und mit Tests: `src/calendar.ts` (Zeiträume, Stapeln, Zeitachse) und `src/calendarData.ts` (Zeilen, Einträge, Rechte, Filter).
- **Zeichnen:** `src/CalendarView.tsx` und `src/CalendarDialog.tsx`, mit HTML und CSS. Gezeichnet werden nur die sichtbaren Zeilen und die Balken in der Nähe des sichtbaren Zeitraums. Die Zeitachse ist ein begrenztes Stück, das beim Blättern nachrückt. Gemessen mit 500 Objekten und 10.000 Buchungen (Entwicklungsmodus, Mac): Daten berechnen 50–65 ms, Maßstab wechseln 40–110 ms, Filter etwa 15 ms, eine Änderung etwa 70 ms; gezeichnet sind rund 30 Zeilen. Mit Warnung öffnet sich dort das Formular einer Buchung in 100–190 ms (ohne Warnung etwa 75 ms), ein Tastendruck darin braucht gut 10 ms. Die Flüssigkeit beim Wischen ist noch nicht gemessen.
- **Ältere Versionen** von Grid zeigen den Reiter nicht; die Daten bleiben unberührt. Sortiert dort jemand die Reiter um, rutscht der Kalender ans Ende (`moveTable` schreibt nur die bekannten IDs neu).
- Texte wie üblich über `t()` mit Einträgen in `en.ts`.

## Phasen

1. **Ansehen** (gebaut): Reiter und Einstellungen, Zeitleiste mit Maßstäben, Gruppen, Zeilen- und Balkenfilter, Eintrag öffnen, „+ Eintrag“, Rechte.
2. **Eintragen und prüfen** (gebaut): neue Einträge durch Ziehen (`src/calendarDrag.ts`), Überschneidungen in Kalender und Formular.
3. **Bequemer:** Balken verschieben und verlängern (gebaut); „nur Objekte, die von … bis … frei sind“ (offen).

Jede Phase ist für sich benutzbar.

## Nicht Teil dieses Konzepts

- Monatsblatt als Kästchenraster, wiederkehrende Termine, Abgleich mit iCal oder anderen Kalendern, Drucken, Kalender in Berichten.
- Eine abgeleitete Tabelle als Quelle (feste Vorfilter). „Belegt nicht“ und die Balkenfilter decken den wichtigsten Fall ab.
- **„Heute“ in den Filtern abgeleiteter Tabellen** („Bis ist heute oder später“). Das ist auch ohne Kalender nützlich und wird getrennt gebaut.

## Offene Fragen

Jeweils mit Vorschlag:

1. **Mehrere gleiche Stücke** (acht Bierbänke): eigene Zeile je Stück, oder eine Zeile mit Anzahl? *Vorschlag:* zunächst jedes Stück als eigenes Objekt. Später optional eine Zahlenspalte „Anzahl“ am Objekt (und an der Buchung); eine Überschneidung gibt es dann erst, wenn mehr gebucht ist als vorhanden.
2. **Offenes Ende** (verliehen, Rückgabe unbekannt): *Vorschlag:* vorerst ein geschätztes Ende eintragen. Falls das nicht reicht, eine Einstellung „Ohne Ende: belegt bis auf Weiteres“.
3. **Pufferzeiten** (Zelt muss nach der Rückgabe trocknen): *Vorschlag:* nicht eingebaut; man trägt die Zeit mit ein.
4. **Vorläufige Buchungen** (angefragt): Sollen sie anders aussehen und mit bestätigten eine Überschneidung bilden? *Vorschlag:* Sie belegen wie alle anderen; die Farbe unterscheidet sie.
