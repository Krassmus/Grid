# Berichte

Ein Bericht ist ein Reiter, der wie ein Blatt Papier aussieht und zum Drucken gedacht ist. Er besteht aus Abschnitten:

- **Überschrift** (groß oder klein)
- **Text** mit einfacher Formatierung
- **Tabelle**: eine Tabelle oder abgeleitete Tabelle, mit wählbaren Spalten und Summenzeile. Es gilt die Standardsortierung der (Quell-)Tabelle.

Gespeichert wird nur die Vorlage; Werte und Tabellen werden bei jeder Anzeige neu berechnet. Einen festgehaltenen Stand liefert nur das PDF.

## Werte in `{{ }}`

In Überschriften und Texten gilt die Formelsprache der Formelspalten. Weil es keine „eigene Zeile“ gibt, meint ein Feld alle Zeilen:

```
{{ SUMME({{Spenden.Betrag}}) }}            Spalte „Betrag“ aller Zeilen der (abgeleiteten) Tabelle „Spenden“
{{ ANZAHL({{Spenden}}) }}                  Zahl der Zeilen
{{ 1240 + SUMME({{Girokonto.Betrag}}) }}   Rechnen mit Werten
```

Gefiltert wird über abgeleitete Tabellen. Bei gruppierten Sichten zählen die einzelnen Zeilen, die den Bedingungen genügen.

- Zahlen erscheinen mit Nachkommastellen und Einheit der Spalte (nicht bei Divisionen, ANZAHL oder gemischten Formaten), mit dem Dezimalzeichen der Sprache.
- Namen werden als Text gespeichert: Nach dem Umbenennen einer Tabelle oder Spalte muss der Bericht angepasst werden (wie bei Formelspalten).
- Namen mit Punkt lassen sich nicht ansprechen; gleichnamige Tabellen sind mehrdeutig.
- Verknüpfte Zeilen (`Tabelle.Relation.Spalte`) gehen nicht direkt; dafür eine Rollup- oder Formelspalte anlegen.

## Rechte

Siehe docs/RIGHTS.md, „Berichte“. Geprüft wird auch, woraus berechnete Spalten und Bedingungen entstehen (`report.ts`, `readable`), einschließlich vertraulicher Spalten ohne Schlüssel.

## Drucken

`print_page` (src-tauri/src/print.rs) öffnet den Druckdialog des Systems mit Seitenrändern, auf macOS über `NSPrintOperation`, auf iPadOS über `UIPrintInteractionController`. `@media print` in styles.css lässt nur das Blatt übrig.
