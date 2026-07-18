# 3D-Druck Auftragserfassung

Stand: 18. Juli 2026

Werkzeug zum Erfassen und Kalkulieren von 3D-Druckaufträgen, die über eBay, Etsy oder Amazon
hereinkommen. STL/3MF laden → Material und Farbe wählen → Preis → Auftragsblatt als PDF.
Mehrere Aufträge werden lokal verwaltet, Bestellungen lassen sich per CSV importieren.

## Dateien

| Datei | Zweck |
|---|---|
| `index.html` | Die komplette Anwendung — Doppelklick genügt |

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
  Ersetzt die alte „eine JSON-Datei pro Auftrag“-Handhabung — die JSON-Knöpfe in der Kopfzeile
  bleiben zusätzlich als Export/Backup erhalten.
- **CSV-Import:** Bestellexport von eBay, Etsy oder Amazon per Drag-and-drop oder Einfügen.
  Erkennt Trennzeichen (`;`, Tab, `,`) und die Spalten für Bestellnummer und Käufer selbst,
  entdoppelt und legt jede Bestellung als Auftrag an. Alles lokal, keine API, kein Server.
- **Upload:** STL binär und ASCII sowie 3MF, per Drag-and-drop. Alles bleibt lokal im Browser.
- **Vorschau:** eigener Software-Renderer auf Canvas (Painter's Algorithm, Flat-Shading),
  drehbar, zoombar, in der gewählten Filamentfarbe.
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

- Testwürfel 20 mm → **exakt 8000 mm³**, über den STL-Binär-, den STL-ASCII- *und* den
  3MF-Pfad (signiertes Tetraedervolumen gegen den Ursprung). Der 3MF-Test baut das ZIP mit
  echtem Deflate und prüft Volumen (8,0 cm³) und Abmessungen (20 × 20 × 20 mm) im Browser.
- CSV-Import: gemischte Trennzeichen, Duplikate und Leerzeilen werden gefiltert; die erkannten
  Aufträge landen in `localStorage` und lassen sich per Klick mit Bestellnummer und Käufer laden.
- Eigene Materialpreise: „Als Standard sichern“ → Reload → neue Aufträge starten mit dem
  gesicherten Preis; „Marktwerte laden“ stellt die Schätzwerte wieder her (im Browser geprüft).
- Bauraum-Warnung: Quader 25 × 10 × 5 mm passt bei 12 × 30 mm Bett (per 90°-Drehung), löst aber
  bei 12 × 20 mm aus. v1-Stand (flaches Format) lädt sauber, ein v3-Stand wird klar abgelehnt.
- Stromformel linear geprüft: doppelter Preis oder doppelte Leistung → punktgenau doppelte Kosten.
- Speichern/Laden-Rundlauf stellt eigene Materialien, eigene Farben und Preis identisch wieder her.
- PDF-Summe deckt sich mit der Anzeige.

## Grenzen des Modells

1. **Die Druckzeit ist eine Durchsatz-Schätzung, kein Slicing.** Sie kennt weder Beschleunigungs-
   werte noch reale Stützgeometrie. Für die Kalkulation brauchbar, für eine Terminzusage nicht.
   Wer es genau braucht, muss die Zeit aus dem Slicer übernehmen.
2. **Stützen sind ein pauschaler Materialaufschlag**, aus der Geometrie wird nichts abgeleitet —
   deshalb ist der Prozentsatz frei einstellbar (kleine Brücke ~5 %, frei stehende Figur ~60 %).
   Das bleibt bewusst so; echte Stützgeometrie käme nur mit einem Slicer.
3. **Speichern legt die Geometrie mit ins JSON.** Bei Modellen mit vielen hunderttausend Dreiecken
   sprengt das das `localStorage`-Quota — der Download funktioniert dann trotzdem, nur der
   automatische Wiedereinstieg beim Öffnen fällt aus (still abgefangen).
4. **v1-Migration ist Best-effort.** `migrateV1()` übernimmt Felder aus einem flachen v1-Objekt;
   was v1 nicht gespeichert hat, kann sie nicht rekonstruieren. Ohne echte v1-Datei ist das die
   plausibelste Annahme über das alte Format.
5. **3MF-Transformationen** werden zwar für Build-Items und Komponenten mitgerechnet, aber ohne
   Einheiten-Umrechnung — die 3MF-Vorgabe „Millimeter“ wird angenommen. Farb-/Materialdaten aus
   dem 3MF werden ignoriert (nur die Geometrie zählt für die Kalkulation).
7. **Der CSV-Import erkennt Spalten über gängige Kopfzeilen-Namen** (Order number/Bestellnummer,
   Buyer/Käufer …). Exotische oder umbenannte Exporte werden nicht gefunden — dann bleibt das
   Einfügefeld für manuelles Nacharbeiten.

## Erledigt (18. Juli 2026)

Erste Runde (PR #1) — durchgängig lokal, ohne Server:

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
3. **Auftragsliste ohne Suche/Filter.** Ab vielen Dutzend Aufträgen wäre eine Suche sinnvoll;
   aktuell nur nach Datum sortiert.
