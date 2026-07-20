# 3D-Druck Auftragserfassung

Eine einzige HTML-Datei zum Erfassen und Kalkulieren von 3D-Druckaufträgen, die über
eBay, Etsy oder Amazon hereinkommen. Kein Server, kein CDN, keine Installation —
**`index.html` herunterladen, Doppelklick, fertig.** Alle Daten bleiben lokal im Browser.

![Screenshot: Modellvorschau und Live-Kalkulation](docs/screenshot.png)

## Ablauf

STL oder 3MF laden → Material und Farbe wählen → Einstellungen prüfen → Preis steht →
Auftragsblatt als PDF drucken. Aufträge landen in einer lokalen Auftragsliste mit
Status (offen → gedruckt → versendet → bezahlt), Suche und Filter.

## Funktionen

- **Modell:** STL (binär + ASCII) und 3MF per Drag-and-drop, eigener Parser, eigene
  3D-Vorschau (Canvas-Software-Renderer). Warnt bei nicht wasserdichten Meshes und
  bei Teilen, die den eingestellten Bauraum sprengen (90°-Drehung wird berücksichtigt).
- **Kalkulation:** Material, Strom, Maschinenzeit, Rüsten, Marge, Plattformgebühr
  (eBay/Etsy/Amazon), MwSt. Die Druckzeit-Schätzung lässt sich durch die echte
  Slicer-Zeit übersteuern.
- **Material & Farbe:** frei editierbare Filamentliste (eigene Einkaufspreise als
  Standard speicherbar), 56 benannte Farbtöne plus eigene Farben.
- **Aufträge:** CSV-Import der Bestellexporte von eBay/Etsy/Amazon, Auftragsliste mit
  Status/Suche/Filter, Duplizieren für Wiederholungskäufe, Komplett-Backup als JSON,
  Umsatz-CSV für die Buchhaltung.
- **PDF:** einseitiges A4-Auftragsblatt mit Vorschaubild über den Druckdialog.

Details zu Rechenmodell, Grenzen und Entscheidungen: [`NOTIZEN.md`](NOTIZEN.md).

16 Ende-zu-Ende-Tests fahren die App headless durch: Volumenberechnung (STL + 3MF),
Wasserdichtheits- und Bauraum-Warnung, CSV-Import, Auftragsliste, Backup, Migration.
Sie laufen bei jedem Push automatisch über GitHub Actions.
