# 3D-Druck Auftragserfassung

Eine einzige HTML-Datei zum Erfassen und Kalkulieren von 3D-Druckaufträgen, die über
eBay, Etsy oder Amazon hereinkommen. Kein CDN, keine Installation —
**`index.html` herunterladen, Doppelklick, fertig.** Alle Daten bleiben lokal im Browser.
Zwei Funktionen (Server-Backup, Mail-Versand mit Anhang) brauchen zusätzlich den kleinen
API-Server aus `server/`, siehe [`NOTIZEN.md`](NOTIZEN.md) — ohne den läuft die App trotzdem
komplett offline, nur diese zwei Extras fehlen dann.

![Screenshot: Modellvorschau und Live-Kalkulation](docs/screenshot.png)

## Ablauf

STL oder 3MF laden → Bambu-Lab-Farbe wählen (legt Material gleich mit fest) → Preis
steht sofort oben, ganz ohne Scrollen. Aufträge, Auftragsdaten und die
Kalkulationsbasis stecken bei Bedarf hinter einem Pfeil, damit der Kopf der Seite
aufgeräumt bleibt. Fertig geht es raus als PDF oder direkt per Mail mit Anhang.

## Funktionen

- **Modell:** STL (binär + ASCII) und 3MF per Drag-and-drop, eigener Parser (auch für
  3MF-Dateien, die die Geometrie in eine separate Datei im Archiv auslagern, z. B. aus
  Bambu Studio), eigene 3D-Vorschau (Canvas-Software-Renderer). Warnt bei nicht
  wasserdichten Meshes und bei Teilen, die den eingestellten Bauraum sprengen
  (90°-Drehung wird berücksichtigt).
- **Kalkulation:** Material, Strom, Maschinenzeit, Rüsten, Marge, MwSt. — steht direkt
  oben im Blick, keine Plattformgebühr. Die Druckzeit-Schätzung lässt sich durch die
  echte Slicer-Zeit übersteuern.
- **Material & Farbe:** nur die 90 offiziellen Bambu-Lab-Farben (PLA Basic/Matte/CF/
  Translucent/Pure, PETG Basic/CF), gruppiert nach Linie mit Preis pro kg — die
  Farbwahl legt Material (Preis, Dichte, Tempo) und Farbe in einem Schritt fest, es
  lässt sich nichts drucken, was nicht auch gekauft werden kann.
- **Aufträge:** CSV-Import der Bestellexporte von eBay/Etsy/Amazon, Auftragsliste mit
  Status/Suche/Filter, Duplizieren für Wiederholungskäufe, Komplett-Backup als JSON,
  Umsatz-CSV für die Buchhaltung.
- **PDF & Mail:** einseitiges A4-Auftragsblatt über den Druckdialog, oder direkter
  Mail-Versand mit echtem Anhang (Modell als STL, aktueller Stand als JSON) über den
  API-Server auf dem Pi (Resend-API) — kein manuelles Anhängen mehr nötig.
- **Darstellung:** folgt automatisch dem System, manueller Hell/Dunkel-Umschalter im
  Header überschreibt das bei Bedarf.

Details zu Rechenmodell, Grenzen und Entscheidungen: [`NOTIZEN.md`](NOTIZEN.md).

21 Ende-zu-Ende-Tests fahren die App headless durch: Volumenberechnung (STL + 3MF,
auch mit ausgelagerter Geometrie), Wasserdichtheits- und Bauraum-Warnung, CSV-Import,
Auftragsliste, Backup, Migration, Darstellungs-Umschalter, Mail-Versand. Sie laufen
bei jedem Push automatisch über GitHub Actions.
