# 3D-Druck Auftragserfassung

Stand: 21. Juli 2026

Werkzeug zum Erfassen und Kalkulieren von 3D-Druckaufträgen, die über eBay, Etsy oder Amazon
hereinkommen. STL/3MF laden → Material und Farbe wählen → Preis → Auftragsblatt als PDF.
Aufträge werden lokal mit Status, Suche und Filter verwaltet; Bestellungen kommen per
CSV-Import, raus geht es per Backup-JSON und Umsatz-CSV.

## Dateien

| Datei | Zweck |
|---|---|
| `index.html` | Die komplette Anwendung — Doppelklick genügt |
| `server/api-server.js` | Optionaler API-Server auf dem Pi (Backup + Mail-Versand), siehe unten |
| `deploy/setup-mail-feature.sh` | Einmal-Setup-Skript für den Resend-Mailversand auf dem Pi (systemd-Unit + nginx-Route + Webroot-Kopie), siehe „Deployment" |
| `README.md` | Kurzvorstellung mit Screenshot (`docs/screenshot.png`) |
| `tests/e2e.mjs` | 21 Playwright-Tests, fahren die App headless durch |
| `.github/workflows/test.yml` | CI: Tests laufen bei jedem Push |

## Deployment

Läuft produktiv auf dem Raspberry Pi unter `https://drucken.luetje.me`, zusätzlich zur
lokalen Doppelklick-Nutzung. Setup:

- **nginx** liefert `index.html` statisch aus `/var/www/drucken.luetje.me/index.html` aus
  (Port 80, kein PHP/Node dahinter — reine Datei). Nicht direkt aus dem Repo-Checkout im
  Home-Verzeichnis, weil `/home/jan` `drwx------` ist und `www-data` da nicht durchkäme.
- **Cloudflare Tunnel** (`cloudflared`, systemd-Dienst, `enabled`) verbindet den Pi ausgehend
  mit Cloudflare — kein eingehendes Port-Forwarding nötig. Grund: Der Hauptanschluss läuft
  über Starlink, das hinter Carrier-Grade-NAT sitzt (WAN-IP im `100.64.0.0/10`-Bereich),
  klassisches Port-Forwarding auf der Router-WAN-IP geht dort ins Leere. Der DSL-Zweitanschluss
  hängt zusätzlich hinter einem doppelten NAT. Tunnel umgeht beides.
- **DNS:** `drucken.luetje.me` ist ein CNAME auf den Tunnel (von `cloudflared tunnel route dns`
  gesetzt), TLS/HTTPS übernimmt Cloudflare am Edge. Kein certbot/Let's-Encrypt-Zertifikat auf
  dem Pi nötig.
- **Update nach Codeänderung:** `index.html` liegt nicht automatisch aktuell im Webroot, nach
  `git pull` manuell nachziehen: `sudo cp index.html /var/www/drucken.luetje.me/index.html`.
- **API-Server** (`server/api-server.js`, systemd-Dienst `druckauftrag-backup`, nur
  `127.0.0.1:8181`), zwei Routen:
  - `POST /api/backup` — aktuelle Auftragsliste (`persistOrders()` ruft das bei jeder Änderung
    mit) landet unter `/var/backups/druckauftrag/` (`latest.json` + eine Tageskopie).
  - `POST /api/send-mail` — verschickt die Auftrags-Mail über die **Resend-API**
    (`https://api.resend.com/emails`) inklusive echtem Dateianhang (Modell als STL, Stand als
    JSON, jeweils base64 im Request-Body vom Client). Absender `onboarding@resend.dev`
    (Resend-Testdomain, funktioniert ohne eigene Domain-Verifizierung nur an die eigene
    Resend-Account-Adresse — reicht, weil immer an `jan@luetje.me` verschickt wird). Für Mails
    an andere Adressen müsste `luetje.me` erst bei Resend verifiziert werden (DNS-Einträge über
    Cloudflare).

  nginx leitet beide Pfade weiter. `X-Backup-Secret` ist **kein echtes Geheimnis** — die App ist
  eine öffentliche, clientseitige Seite, der Wert steht im Quelltext und im öffentlichen
  GitHub-Repo. Er bremst nur zufälliges Abgreifen durch Bots, kein Schutz gegen gezielte
  Angriffe. Der **Resend-API-Key dagegen ist ein echtes Geheimnis** und steht nur server-seitig
  als Umgebungsvariable — niemals im Quelltext oder im Repo committen. Setup auf dem Pi:
  ```
  sudo mkdir -p /var/backups/druckauftrag
  sudo chown jan:jan /var/backups/druckauftrag
  ```
  systemd-Unit `/etc/systemd/system/druckauftrag-backup.service`:
  ```
  [Unit]
  Description=API-Server für die 3D-Druck-Auftragserfassung (Backup + Mail-Versand)
  After=network.target

  [Service]
  ExecStart=/usr/bin/node /home/jan/3d-druck-auftraege/server/api-server.js
  Environment=BACKUP_SECRET=<gleicher Wert wie BACKUP_SECRET in index.html>
  Environment=BACKUP_DIR=/var/backups/druckauftrag
  Environment=RESEND_API_KEY=<Resend-API-Key, NICHT ins Repo>
  Environment=MAIL_TO=jan@luetje.me
  Restart=on-failure
  User=jan

  [Install]
  WantedBy=multi-user.target
  ```
  nginx-Ergänzung in `/etc/nginx/sites-available/drucken.luetje.me` (vor der `location /`):
  ```
  location /api/backup {
      proxy_pass http://127.0.0.1:8181/backup;
      client_max_body_size 25m;
  }
  location /api/send-mail {
      proxy_pass http://127.0.0.1:8181/send-mail;
      client_max_body_size 35m;
  }
  ```
  Danach `sudo systemctl daemon-reload && sudo systemctl enable --now druckauftrag-backup`
  und `sudo systemctl reload nginx`.

  `deploy/setup-mail-feature.sh` automatisiert genau diese drei Schritte (Webroot-Kopie,
  Unit-Umstellung inkl. `RESEND_API_KEY`-Abfrage, nginx-Route) für den Fall, dass die Mail-
  Route je neu aufgesetzt werden muss — `BACKUP_SECRET`/`BACKUP_DIR` übernimmt es unverändert
  aus der laufenden Unit, fragt nur den Resend-Key interaktiv ab (landet nirgends im Klartext
  im Repo oder in einer Konversation). Aufruf: `sudo bash deploy/setup-mail-feature.sh`.

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
  Der 3MF-Parser ist namespace-fest (auch `<m:object>`-Prefixe), rechnet das `unit`-Attribut
  nach mm um (micron bis meter) und löst die 3MF-Production-Extension auf: Bambu Studio lagert
  die Geometrie bei größeren Modellen in eine eigene Datei im ZIP aus (z. B.
  `3D/Objects/object_1.model`), referenziert per `<component p:path="…">` aus der Hauptdatei
  `3D/3dmodel.model` — der Parser lädt diese Datei dateiübergreifend nach.
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
- **Bauraum:** X/Y/Z frei einstellbar (Startwert 256³). Die Größenwarnung berücksichtigt ein
  Drehen um 90° in der Ebene (sortierte Grundfläche gegen sortierte Bett-Grundfläche, Höhe separat).
- **Material & Farbe:** 90 offizielle Bambu-Lab-Farben (PLA Basic/Matte/CF/Translucent/Pure,
  PETG Basic/CF), gruppiert nach Linie mit Preis pro kg — bewusst keine eigene Farbe mehr, da
  nur gekauft und gedruckt werden kann, was Bambu tatsächlich anbietet. Die Farbwahl legt
  Material (Preis, Dichte, Tempo) und Farbe in einem Schritt fest, keine separate
  Materialliste mehr.
- **Einstellungen:** Füllung, Schichthöhe, Wandlinien, Stückzahl, Skalierung.
- **PDF:** einseitiges A4-Auftragsblatt mit Vorschaubild über den Druckdialog → „Als PDF sichern“.
  Bewusst ohne jsPDF, das wäre eine externe Abhängigkeit.
- **Mail:** „Per Mail senden“ verschickt Auftrag, Modell (als STL) und Stand direkt über den
  API-Server auf dem Pi (Resend-API) an Jan — echter Anhang, kein mailto:-Link und kein
  manueller Download mehr. Siehe „Deployment“ oben.
- **Zwischenstand:** JSON-Download inklusive Modellgeometrie und Farbe.
  Zusätzlich in `localStorage` (Schlüssel `druckauftrag.v2`) → beim Öffnen ist der letzte Stand da.

## Rechenmodell

```
Schale  = min(Volumen, Oberfläche × Wandlinien × 0,4 mm)
Solid   = Schale + (Volumen − Schale) × Füllung
Gramm   = Solid × Dichte / 1000
Stunden = Solid / (8 mm³/s × Tempo × (Schichthöhe / 0,2)) / 3600 × 1,25
Preis   = ((Material + Strom + Maschine) × (1 + Marge) + Rüsten) × Stück × (1 + MwSt.)
```

Strom ist eine eigene Position: **Leistung (W) × Druckzeit × €/kWh**. Startwerte 120 W und
0,27 €/kWh (Jans Tarif). Wichtig: In „Maschine €/h“ gehören nur Abschreibung, Düsen und Wartung —
**ohne Strom**, sonst zählt er doppelt. Der Faktor 1,25 in der Zeitformel deckt Bewegung und
Retraktion ab, die 8 mm³/s sind der Referenzdurchsatz bei 0,2 mm Schicht und PLA.

Keine Plattformgebühr mehr (früher fest für eBay/Etsy/Amazon hinterlegt, auf Wunsch entfernt).
Kein Materialaufschlag für Stützstrukturen mehr (früher ein freier Prozentregler, ebenfalls auf
Wunsch entfernt) — Solid rechnet jetzt direkt aus Schale und Füllung, ohne Zuschlag.

Weitere Startwerte: Maschine 1 €/h, Rüsten 1,50 €, Marge 15 %, MwSt. 0 %, Bauraum 256 × 256 ×
256 mm (frei einstellbar).

## Verifiziert

Die früheren Ad-hoc-Prüfungen sind jetzt **21 eingecheckte Playwright-Tests** (`tests/e2e.mjs`),
die bei jedem Push per GitHub Actions laufen (`npm test` lokal). Abgedeckt:

- Testwürfel 20 mm → **exakt 8000 mm³** über STL- und 3MF-Pfad, inklusive Abmessungen.
- Wasserdichtheit: intakter Würfel warnt nicht, Würfel mit fehlendem Dreieck warnt.
- 3MF mit ausgelagerter Objektdatei (Production Extension, z. B. aus Bambu Studio) wird
  korrekt aufgelöst.
- Slicer-Zeit `2:30` übersteuert die Schätzung („2 h 30 min · Slicer“) und lässt sich leeren.
- Bauraum-Warnung inkl. 90°-Rotationslogik (12 × 30 passt, 12 × 20 nicht).
- CSV-Import filtert Duplikate/Leerzeilen; Klick lädt Bestellnummer und Käufer.
- Auftragsänderung löst einen Server-Backup-Versuch aus (`POST /api/backup`, fire-and-forget).
- Status weiterschalten + Filter-Chips + Suche.
- Auftrag sichern legt `meshHash` statt eingebetteter Geometrie ab, Mesh-Speicher gefüllt.
- Duplizieren übernimmt das Modell, leert Käufer/Bestellnummer.
- Backup-Restore übernimmt neue Aufträge und überspringt bekannte IDs.
- Farbwahl legt das Material (und damit den Materialpreis) für die Kalkulation fest.
- Mail-Versand: „Per Mail senden“ schickt Auftrag inkl. echtem STL- und Stand-JSON-Anhang an
  `/api/send-mail`; ohne geladenes Modell erscheint stattdessen eine Warnung.
- Darstellung-Umschalter merkt sich die Wahl über einen Reload.
- v1-Stand migriert, neuere Formate werden mit klarer Meldung abgelehnt.
- Kein einziger JS-Fehler im gesamten Lauf.

Aus früheren Runden zusätzlich von Hand geprüft: Stromformel linear (doppelter Preis/Leistung →
doppelte Kosten), Speichern/Laden-Rundlauf identisch, PDF-Summe deckt sich mit der Anzeige.

## Grenzen des Modells

1. **Die Druckzeit-Schätzung bleibt eine Durchsatz-Näherung, kein Slicing.** Sie kennt weder
   Beschleunigungswerte noch reale Stützgeometrie. Wer es genau braucht, trägt die Slicer-Zeit
   ins Übersteuerungsfeld ein — dann rechnen Maschinen- und Stromkosten exakt.
2. **Der Datei-Export („Stand speichern“) bettet die Geometrie weiterhin ein** — gewollt, damit
   die JSON-Datei in sich vollständig ist. Nur die Auftragsliste dedupliziert über den
   Mesh-Speicher. Sehr große Modelle können den `localStorage`-Autosave weiterhin sprengen
   (still abgefangen, der Download klappt trotzdem).
3. **v1-Migration ist Best-effort.** `migrateV1()` übernimmt Felder aus einem flachen v1-Objekt;
   was v1 nicht gespeichert hat, kann sie nicht rekonstruieren.
4. **3MF: Farb- und Materialdaten werden ignoriert** — nur die Geometrie zählt für die
   Kalkulation. Einheiten (`unit`-Attribut) und Prefix-Namespaces werden inzwischen korrekt
   behandelt.
5. **Der Wasserdichtheits-Check pausiert ab 300.000 Dreiecken** (sonst hakt das Laden); sehr
   große Meshes werden also ungeprüft kalkuliert.
6. **Der CSV-Import erkennt Spalten über gängige Kopfzeilen-Namen** (Order number/Bestellnummer,
   Buyer/Käufer …). Exotische oder umbenannte Exporte werden nicht gefunden — dann bleibt das
   Einfügefeld für manuelles Nacharbeiten.

## Erledigt

Neunte Runde (22. Juli 2026):

1. **Pi-seitiges Setup zur achten Runde nachgezogen.** Der Mail-PR (#16) war gemergt, aber
   drei Schritte auf dem Pi standen noch aus: `index.html` im Webroot war noch der alte
   mailto:-Stand, die systemd-Unit zeigte noch auf das umbenannte `server/backup-server.js`
   (lief unbemerkt auf dem alten, bereits gelöschten Datei-Handle weiter) ohne
   `RESEND_API_KEY`, und nginx kannte nur `/api/backup`, nicht `/api/send-mail`. Alle drei
   Schritte jetzt nachgeholt, `deploy/setup-mail-feature.sh` dafür ergänzt (siehe „Deployment").
2. Verifiziert über `curl -X POST .../api/send-mail` mit leerem Body — lieferte den
   erwarteten Pflichtfelder-Fehler statt eines nginx-404, also Route + neuer Code + Key
   bestätigt aktiv.

Achte Runde (20. Juli 2026):

1. **Mail-Versand auf echten Anhang umgestellt.** mailto: kann technisch keine Anhänge
   transportieren — die bisherige Download-dann-manuell-anhängen-Lösung war dem Nutzer zu
   umständlich. `server/backup-server.js` zu `server/api-server.js` erweitert (neue Route
   `POST /api/send-mail`), verschickt die Mail direkt über die Resend-API mit Modell (STL) und
   Stand (JSON) als echten Anhängen. Erfordert einen Resend-Account + API-Key (Secret, nur
   server-seitig als Umgebungsvariable, nie im Repo).
2. Nebenbei zwei veraltete NOTIZEN-Abschnitte korrigiert, die noch die längst entfernte
   editierbare Materialliste beschrieben (Rest vom Material-&-Farbe-Merge).

Siebte Runde (20. Juli 2026):

1. **Standardwerte der Kalkulationsbasis angepasst:** Maschine 2,50 € → 1 €/h, MwSt. 19 % → 0 %,
   Strompreis 0,25 € → 0,27 €/kWh, Marge 40 % → 15 %.
2. **Materialaufschlag durch Stützen komplett entfernt** (Schalter „Stützen mitdrucken“ +
   Prozentregler) — auf Wunsch, keine Nachfolgefunktion. `Solid` rechnet jetzt direkt aus
   Schale und Füllung, ohne Zuschlag. Damit auch das dann ungenutzte `.switch`/`.tog`-CSS
   (der Schalter) entfernt.

Sechste Runde (20. Juli 2026):

1. **3D-Vorschau bei feinteiligen Modellen grundlegend überarbeitet.** Die bisherige
   Ausdünnung (jedes n-te Dreieck überspringen) half bei Modellen mit sehr feiner Geometrie
   (viele tausend winzige Facetten, z.B. dünne Lamellen/Rippen) nicht — auch das volle,
   unausgedünnte Mesh sah identisch "gepunktet" aus, wie ein Vergleich mit dem echten
   Nutzer-Testmodell (132.636 Dreiecke) zeigte. Ursache: subpixelkleine Dreiecke, kein
   Ausdünnungs-Bug. Jetzt Vertex-Clustering (Ecken auf ein Gitter runden, entartete/doppelte
   Dreiecke danach verwerfen) statt stumpfem Überspringen — verschmilzt benachbarte kleine
   Facetten zu größeren, tatsächlich sichtbaren Flächen. Nebenbei einen echten Bug im
   Canvas-Resize gefunden und behoben: `draw()` prüfte bisher nur die Breite, nicht die Höhe.
2. **Rüsten-Standardwert auf 1,50 € gesenkt** (vorher 3 €).
3. **Bambu-Lab-Preise aktualisiert** auf aktuelle EU-Straßenpreise (Stand 20. Juli 2026,
   siehe Kommentar im Code für Details/Vorbehalt).

Fünfte Runde (20. Juli 2026):

1. **Bugfix: 3MF-Dateien mit externer Objektdatei wurden als leer abgelehnt**
   ("Keine Dreiecke im 3MF-Modell gefunden"). Bambu Studio legt die Geometrie bei größeren
   Modellen in `3D/Objects/*.model` ab und verweist nur per `<component p:path="…">` darauf —
   der Parser las bisher ausschließlich `3D/3dmodel.model`. Jetzt löst er referenzierte Dateien
   im selben ZIP-Archiv rekursiv auf. Regressionstest mit synthetischer Production-Extension-
   Datei ergänzt.

Vierte Runde (20. Juli 2026):

1. **Farbpalette auf echte Bambu-Lab-Farben umgestellt** (90 Farben aus den offiziellen
   Hex-Code-Tabellen für PLA Basic, PLA Matte, PLA-CF, PLA Translucent, PLA Pure, PETG Basic,
   PETG-CF), gruppiert nach Linie mit Preis pro kg. Eigene Farbe anlegen entfernt — es kann nur
   gedruckt werden, was tatsächlich gekauft werden kann.
2. **Kalkulationsbasis ist jetzt standardmäßig eingeklappt**, Pfeil-Button klappt sie auf.
3. **Aufträge-Karte an das Seitenende verschoben**, volle Breite — das Feld, das von Hand
   ausgefüllt wird, steht nicht mehr ganz oben im Weg.

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
   klarer Meldung ab.

## Offene Punkte

1. **Kein Live-Abgleich mit den Plattformen.** Der CSV-Import ersetzt das Abtippen, aber ein
   automatischer Statusabgleich (bezahlt, versendet) bräuchte weiterhin eBay/Etsy-API und Server.
2. **Kein STEP.** 3MF ist jetzt drin und deckt mit STL alle FDM-Slicer ab; STEP käme nur mit
   CAD-Kernel.
3. **Drucker-Profile.** Wer mehrere Drucker hat, stellt Bauraum/Leistung/€-pro-h bisher von Hand
   um — benannte Profile wären der nächste sinnvolle Ausbau.
