# 3D-Druck Auftragserfassung

Stand: 19. Juli 2026

Werkzeug zum Erfassen und Kalkulieren von 3D-Druckaufträgen, die über eBay, Etsy oder Amazon
hereinkommen. STL/3MF laden → Material und Farbe wählen → Preis → Auftragsblatt als PDF.
Aufträge werden lokal mit Status, Suche und Filter verwaltet; Bestellungen kommen per
CSV-Import, raus geht es per Backup-JSON und Umsatz-CSV.

## Dateien

| Datei | Zweck |
|---|---|
| `index.html` | Die komplette Anwendung — Doppelklick genügt |
| `README.md` | Kurzvorstellung mit Screenshot (`docs/screenshot.png`) |
| `tests/e2e.mjs` | 16 Playwright-Tests, fahren die App headless durch |
| `.github/workflows/test.yml` | CI: Tests laufen bei jedem Push |

**Kein `build_standalone.py` wie in den anderen Ordnern.** Diese Seite wurde von vornherein als
vollständiges HTML-Dokument mit eigenem `<head>` geschrieben, nicht als Artifact-Quelle. Sie hat
keine externen Abhängigkeiten: STL-/3MF-Parser, 3D-Renderer und PDF-Ausgabe sind selbst
geschrieben, kein CDN, kein Server. Das 3MF-Entpacken liest das ZIP-Zentralverzeichnis von Hand
und nutzt für Deflate das native `DecompressionStream` des Browsers — keine Bibliothek. Falls die
Seite später als Artifact veröffentlicht werden soll, muss der `<head>` raus — dann lohnt ein
Build-Skript wie bei PV und E-Auto.

## Was drin ist

- **Auftragsliste:** mehrere Aufträge nebeneinander, lokal in `localStorage`
  (`druckauftrag.orders.v1`). „Sichern“ legt den aktuellen Stand ab bzw. aktualisiert den
  geladenen Auftrag, „Neu“ beginnt einen frischen. Klick auf einen Eintrag lädt ihn zurück.
  Jeder Auftrag hat einen **Status** (offen → gedruckt → versendet → bezahlt, Klick aufs
  Badge schaltet weiter), dazu **Suche** (Bestellnummer/Käufer/Plattform) und **Filter-Chips**
  pro Status. **⧉ dupliziert** einen Auftrag für Wiederholungskäufe — gleiches Modell und
  gleiche Einstellungen, Käufer/Bestellnummer/Termin leer.
- **Speicher-Diät:** Aufträge betten die Modellgeometrie nicht mehr einzeln ein, sondern
  referenzieren sie per Hash im deduplizierten Mesh-Speicher (`druckauftrag.meshes.v1`).
  Zehn Aufträge mit demselben Modell kosten so nur einmal Quota; verwaiste Geometrien werden
  beim Löschen aufgeräumt. Alte Aufträge mit eingebetteter Geometrie laden weiterhin.
- **Backup & Buchhaltung:** „Backup exportieren/laden“ sichert die komplette Auftragsliste
  inklusive Geometrien als eine JSON-Datei (Import überspringt bereits vorhandene IDs) —
  wichtig, weil `localStorage` browsergebunden ist. „Umsatz-CSV“ exportiert Datum, Plattform,
  Bestellnummer, Käufer, Status und Bruttopreis mit Semikolon und BOM für Excel.
- **CSV-Import:** Bestellexport von eBay, Etsy oder Amazon per Drag-and-drop oder Einfügen.
  Erkennt Trennzeichen (`;`, Tab, `,`) und die Spalten für Bestellnummer und Käufer selbst,
  entdoppelt und legt jede Bestellung als Auftrag an. Alles lokal, keine API, kein Server.
- **Upload:** STL binär und ASCII sowie 3MF, per Drag-and-drop. Alles bleibt lokal im Browser.
  Der 3MF-Parser ist namespace-fest (auch `<m:object>`-Prefixe) und rechnet das
  `unit`-Attribut nach mm um (micron bis meter).
- **Wasserdichtheits-Check:** Beim Laden wird geprüft, ob jede Kante zu genau zwei Dreiecken
  gehört. Löchrige Meshes liefern beliebig falsche Volumina — statt still einen falschen Preis
  zu zeigen, warnt die App mit der Zahl der offenen Kanten. (Ab 300.000 Dreiecken wird die
  Prüfung aus Tempogründen übersprungen.)
- **Slicer-Zeit:** Die eingebaute Druckzeit-Schätzung lässt sich pro Auftrag durch die echte
  Zeit aus dem Slicer übersteuern (Formate: `4:30`, `270`, `1,5h`) — Maschinen- und Stromkosten
  rechnen dann exakt. Kalkulation und PDF kennzeichnen das mit „Slicer“.
- **Vorschau:** eigener Software-Renderer auf Canvas (Painter's Algorithm, Flat-Shading),
  drehbar, zoombar, in der gewählten Filamentfarbe. Ab ~40.000 Dreiecken wird die Vorschau
  ausgedünnt (jedes n-te Dreieck), damit das Drehen flüssig bleibt — die Kalkulation rechnet
  immer mit dem vollen Mesh, und der Hinweis unter dem Canvas zeigt die Reduktion an.
- **Material:** 10 Filamente als Startwerte, aber Name, €/kg, Dichte und Tempo-Faktor sind alle
  frei editierbar; anlegen, löschen, zurücksetzen. **Als Standard sichern** legt die eigenen
  Einkaufspreise dauerhaft in `localStorage` (`druckauftrag.materials.v1`) ab — danach starten
  neue Aufträge mit Jans Preisen statt den Marktschätzungen, „Zurücksetzen“ holt genau diese,
  „Marktwerte laden“ die ursprünglichen Schätzwerte.
- **Bauraum:** X/Y/Z frei einstellbar (Startwert 256³). Die Größenwarnung berücksichtigt ein
  Drehen um 90° in der Ebene (sortierte Grundfläche gegen sortierte Bett-Grundfläche, Höhe separat).
- **Farbe:** 56 benannte Töne plus beliebige eigene Farben. Farbe hängt **nicht** am Material.
- **Einstellungen:** Füllung, Schichthöhe, Wandlinien, Stückzahl, Skalierung, Stützstruktur
  (Schalter + freier Prozentregler).
- **PDF:** einseitiges A4-Auftragsblatt mit Vorschaubild über den Druckdialog → „Als PDF sichern“.
  Bewusst ohne jsPDF, das wäre eine externe Abhängigkeit.
- **Zwischenstand:** JSON-Download inklusive Modellgeometrie, eigenen Materialien und Farben.
  Zusätzlich in `localStorage` (Schlüssel `druckauftrag.v2`) → beim Öffnen ist der letzte Stand da.

## Rechenmodell

```
Schale  = min(Volumen, Oberfläche × Wandlinien × 0,4 mm)
Solid   = (Schale + (Volumen − Schale) × Füllung) × (1 + Stützen%)
Gramm   = Solid × Dichte / 1000
Stunden = Solid / (8 mm³/s × Tempo × (Schichthöhe / 0,2)) / 3600 × 1,25
Preis   = ((Material + Strom + Maschine) × (1 + Marge) + Rüsten) × Stück
          / (1 − Plattformgebühr) × (1 + MwSt.)
```

Strom ist eine eigene Position: **Leistung (W) × Druckzeit × €/kWh**. Startwerte 120 W und
0,25 €/kWh (Jans Tarif). Wichtig: In „Maschine €/h“ gehören nur Abschreibung, Düsen und Wartung —
**ohne Strom**, sonst zählt er doppelt. Der Faktor 1,25 in der Zeitformel deckt Bewegung und
Retraktion ab, die 8 mm³/s sind der Referenzdurchsatz bei 0,2 mm Schicht und PLA.

Plattformgebühren fest hinterlegt: eBay 11 %, Etsy 9,5 %, Amazon 15 %. Die Gebühr wird auf den
Endpreis aufgeschlagen (`/(1−Satz)`), nicht draufgerechnet — sonst bleibt nach Abzug zu wenig übrig.

Weitere Startwerte: Maschine 2,50 €/h, Rüsten 3 €, Marge 40 %, MwSt. 19 %, Bauraum 256 × 256 ×
256 mm (jetzt frei einstellbar).

## Verifiziert

Die früheren Ad-hoc-Prüfungen sind jetzt **16 eingecheckte Playwright-Tests** (`tests/e2e.mjs`),
die bei jedem Push per GitHub Actions laufen (`npm test` lokal). Abgedeckt:

- Testwürfel 20 mm → **exakt 8000 mm³** über STL- und 3MF-Pfad, inklusive Abmessungen.
- Wasserdichtheit: intakter Würfel warnt nicht, Würfel mit fehlendem Dreieck warnt.
- Slicer-Zeit `2:30` übersteuert die Schätzung („2 h 30 min · Slicer“) und lässt sich leeren.
- Bauraum-Warnung inkl. 90°-Rotationslogik (12 × 30 passt, 12 × 20 nicht).
- CSV-Import filtert Duplikate/Leerzeilen; Klick lädt Bestellnummer und Käufer.
- Status weiterschalten + Filter-Chips + Suche.
- Auftrag sichern legt `meshHash` statt eingebetteter Geometrie ab, Mesh-Speicher gefüllt.
- Duplizieren übernimmt das Modell, leert Käufer/Bestellnummer.
- Backup-Restore übernimmt neue Aufträge und überspringt bekannte IDs.
- Eigene Materialpreise überleben einen Reload; „Marktwerte laden“ stellt Schätzwerte her.
- v1-Stand migriert, neuere Formate werden mit klarer Meldung abgelehnt.
- Kein einziger JS-Fehler im gesamten Lauf.

Aus früheren Runden zusätzlich von Hand geprüft: Stromformel linear (doppelter Preis/Leistung →
doppelte Kosten), Speichern/Laden-Rundlauf identisch, PDF-Summe deckt sich mit der Anzeige.

## Grenzen des Modells

1. **Die Druckzeit-Schätzung bleibt eine Durchsatz-Näherung, kein Slicing.** Sie kennt weder
   Beschleunigungswerte noch reale Stützgeometrie. Wer es genau braucht, trägt die Slicer-Zeit
   ins Übersteuerungsfeld ein — dann rechnen Maschinen- und Stromkosten exakt.
2. **Stützen sind ein pauschaler Materialaufschlag**, aus der Geometrie wird nichts abgeleitet —
   deshalb ist der Prozentsatz frei einstellbar (kleine Brücke ~5 %, frei stehende Figur ~60 %).
   Das bleibt bewusst so; echte Stützgeometrie käme nur mit einem Slicer.
3. **Der Datei-Export („Stand speichern“) bettet die Geometrie weiterhin ein** — gewollt, damit
   die JSON-Datei in sich vollständig ist. Nur die Auftragsliste dedupliziert über den
   Mesh-Speicher. Sehr große Modelle können den `localStorage`-Autosave weiterhin sprengen
   (still abgefangen, der Download klappt trotzdem).
4. **v1-Migration ist Best-effort.** `migrateV1()` übernimmt Felder aus einem flachen v1-Objekt;
   was v1 nicht gespeichert hat, kann sie nicht rekonstruieren.
5. **3MF: Farb- und Materialdaten werden ignoriert** — nur die Geometrie zählt für die
   Kalkulation. Einheiten (`unit`-Attribut) und Prefix-Namespaces werden inzwischen korrekt
   behandelt.
6. **Der Wasserdichtheits-Check pausiert ab 300.000 Dreiecken** (sonst hakt das Laden); sehr
   große Meshes werden also ungeprüft kalkuliert.
7. **Der CSV-Import erkennt Spalten über gängige Kopfzeilen-Namen** (Order number/Bestellnummer,
   Buyer/Käufer …). Exotische oder umbenannte Exporte werden nicht gefunden — dann bleibt das
   Einfügefeld für manuelles Nacharbeiten.

## Erledigt

Dritte Runde (19. Juli 2026, erste im eigenen Repo) — alle zwölf Review-Vorschläge:

1. **Auftragsstatus + Filter + Suche** (offen/gedruckt/versendet/bezahlt, Chips, Volltextsuche).
2. **Komplett-Backup** der Auftragsliste als eine JSON, Import mit ID-Deduplizierung.
3. **Slicer-Zeit-Übersteuerung** für exakte Maschinen- und Stromkosten.
4. **Auftrag duplizieren** für Wiederholungskäufe.
5. **Umsatz-CSV** für die Buchhaltung (Semikolon + BOM, Excel-tauglich).
6. **Wasserdichtheits-Check** — kein stiller Falschpreis mehr bei löchrigen Meshes.
7. **Mesh-Deduplizierung** in der Auftragsliste (Hash-Referenzen statt Geometrie-Kopien).
8. PDF-Fehlermeldung nennt jetzt auch 3MF.
9. **3MF namespace-fest + `unit`-Umrechnung** (micron bis meter).
10. **Vorschau-Ausdünnung** ab ~40.000 Dreiecken gegen Ruckeln.
11. **README** mit Screenshot.
12. **16 Playwright-Tests eingecheckt + GitHub-Actions-CI.**

Erste Runde (PR #1 im alten Sammel-Repo) — durchgängig lokal, ohne Server:

1. **CSV-Import statt reiner Handerfassung.** eBay/Etsy/Amazon erlauben einen CSV-Bestellexport;
   der wird lokal geparst und legt die Aufträge automatisch an. Der ursprünglich befürchtete
   API-/Server-Zwang entfällt damit — die „läuft lokal per Doppelklick“-Eigenschaft bleibt.
   *(Ein echter Live-Abgleich per Plattform-API bräuchte weiterhin einen Server; das ist bewusst
   nicht gebaut.)*
2. **3MF zusätzlich zu STL.** Eigener ZIP-Reader plus natives `DecompressionStream` — keine
   Bibliothek. STEP bleibt außen vor, das bräuchte einen CAD-Kernel.
3. **Auftragsliste** oben links: mehrere Aufträge in `localStorage` statt einer JSON pro Auftrag.

Zweite Runde:

4. **Eigene Einkaufspreise als Standard.** „Als Standard sichern“ legt Jans Materialpreise in
   `localStorage` ab; neue Aufträge starten damit statt mit den Marktschätzungen. „Marktwerte
   laden“ holt die Schätzwerte zurück.
5. **Bauraum konfigurierbar + v1 wieder ladbar.** X/Y/Z frei einstellbar mit 90°-Rotationslogik
   in der Warnung; `applyState()` migriert v1-Stände (best-effort) und lehnt neuere Formate mit
   klarer Meldung ab. Die pauschalen Stützen bleiben bewusst wie sie sind.

## Offene Punkte

1. **Kein Live-Abgleich mit den Plattformen.** Der CSV-Import ersetzt das Abtippen, aber ein
   automatischer Statusabgleich (bezahlt, versendet) bräuchte weiterhin eBay/Etsy-API und Server.
2. **Kein STEP.** 3MF ist jetzt drin und deckt mit STL alle FDM-Slicer ab; STEP käme nur mit
   CAD-Kernel.
3. **Drucker-Profile.** Wer mehrere Drucker hat, stellt Bauraum/Leistung/€-pro-h bisher von Hand
   um — benannte Profile wären der nächste sinnvolle Ausbau.
