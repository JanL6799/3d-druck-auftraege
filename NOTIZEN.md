# 3D-Druck Auftragserfassung

Stand: 16. Juli 2026

Werkzeug zum Erfassen und Kalkulieren von 3D-Druckaufträgen, die über eBay, Etsy oder Amazon
hereinkommen. STL laden → Material und Farbe wählen → Preis → Auftragsblatt als PDF.

## Dateien

| Datei | Zweck |
|---|---|
| `index.html` | Die komplette Anwendung — Doppelklick genügt |

**Kein `build_standalone.py` wie in den anderen Ordnern.** Diese Seite wurde von vornherein als
vollständiges HTML-Dokument mit eigenem `<head>` geschrieben, nicht als Artifact-Quelle. Sie hat
keine externen Abhängigkeiten: STL-Parser, 3D-Renderer und PDF-Ausgabe sind selbst geschrieben,
kein CDN, kein Server. Falls sie später als Artifact veröffentlicht werden soll, muss der `<head>`
raus — dann lohnt ein Build-Skript wie bei PV und E-Auto.

## Was drin ist

- **Upload:** STL binär und ASCII, per Drag-and-drop. Alles bleibt lokal im Browser.
- **Vorschau:** eigener Software-Renderer auf Canvas (Painter's Algorithm, Flat-Shading),
  drehbar, zoombar, in der gewählten Filamentfarbe.
- **Material:** 10 Filamente als Startwerte, aber Name, €/kg, Dichte und Tempo-Faktor sind alle
  frei editierbar; anlegen, löschen, zurücksetzen.
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

Weitere Startwerte: Maschine 2,50 €/h, Rüsten 3 €, Marge 40 %, MwSt. 19 %, Bauraumwarnung ab
256 × 256 × 256 mm.

## Verifiziert

- Testwürfel 20 mm → **exakt 8000 mm³**, über den Binär- *und* den ASCII-Pfad (signiertes
  Tetraedervolumen gegen den Ursprung).
- Stromformel linear geprüft: doppelter Preis oder doppelte Leistung → punktgenau doppelte Kosten.
- Speichern/Laden-Rundlauf stellt eigene Materialien, eigene Farben und Preis identisch wieder her.
- PDF-Summe deckt sich mit der Anzeige.

## Grenzen des Modells

1. **Die Druckzeit ist eine Durchsatz-Schätzung, kein Slicing.** Sie kennt weder Beschleunigungs-
   werte noch reale Stützgeometrie. Für die Kalkulation brauchbar, für eine Terminzusage nicht.
   Wer es genau braucht, muss die Zeit aus dem Slicer übernehmen.
2. **Stützen sind ein pauschaler Materialaufschlag**, aus der Geometrie wird nichts abgeleitet —
   deshalb ist der Prozentsatz frei einstellbar (kleine Brücke ~5 %, frei stehende Figur ~60 %).
3. **Der Bauraum 256³ ist fest verdrahtet** (`render()`), nicht einstellbar.
4. **Speichern legt die Geometrie mit ins JSON.** Bei Modellen mit vielen hunderttausend Dreiecken
   sprengt das das `localStorage`-Quota — der Download funktioniert dann trotzdem, nur der
   automatische Wiedereinstieg beim Öffnen fällt aus (still abgefangen).
5. **Format v2 ist nicht abwärtskompatibel** zu Ständen aus der ersten Fassung (v1).

## Offene Punkte

1. **Aufträge werden noch von Hand erfasst.** Bestellnummer und Käufer tippt man ab. Ein Import aus
   eBay/Etsy wäre der nächste sinnvolle Schritt, braucht aber deren API und damit einen Server —
   der Punkt, an dem die „läuft lokal per Doppelklick“-Eigenschaft fällt. Bewusste Entscheidung.
2. **Nur STL.** 3MF und STEP kommen häufig von Kunden; STL deckt aber alle FDM-Slicer ab.
3. **Keine Auftragsliste** — jeder Auftrag ist eine eigene JSON-Datei. Ab ~20 Aufträgen/Monat
   nervt das.
4. Die 10 Materialpreise sind Marktschätzungen Juli 2026, **keine Einkaufspreise von Jan**.
