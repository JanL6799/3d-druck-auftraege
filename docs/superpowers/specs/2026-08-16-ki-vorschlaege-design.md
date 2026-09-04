# KI-Vorschläge für Druckeinstellungen — Design

**Datum:** 2026-08-16
**Status:** Entwurf, abgestimmt mit Jan

## Warum

Kunden auf `drucken.luetje.me` müssen heute Infill, Schichthöhe, Wandstärke,
Material und Farbe selbst wählen. Wer nicht aus dem 3D-Druck kommt, kann das
nicht — und wählt entweder Standardwerte oder springt ab.

Das Feature lässt den Kunden sein Vorhaben in einem Satz beschreiben
(„Halterung fürs Fahrrad, muss Regen ab") und füllt daraus das Formular vor,
mit einer kurzen Begründung. Der eigentliche Gewinn liegt beim **Material**:
Ein Laie weiß nicht, dass PLA in der Sonne weich wird und PETG nicht — die KI
schon.

Alle Werte bleiben nach dem Vorschlag frei änderbar; das Feature schlägt vor,
es entscheidet nicht.

## Entscheidungen

| Frage | Entscheidung | Begründung |
|---|---|---|
| Wo | Öffentliche `index.html` | Der Kunde soll profitieren, nicht das Backend |
| Auslöser | Button „Vorschlag holen" | Ein Aufruf pro Klick, keine Überraschungskosten |
| Modell | `ANTHROPIC_MODEL`, Default `claude-opus-5` | Jan vergleicht mit echten Kundentexten, ohne Code zu ändern |
| Anbindung | Roher `fetch`, kein SDK | Server hat null Laufzeit-Abhängigkeiten; gleiches Muster wie der Resend-Aufruf |
| Missbrauch | 10/IP/Stunde + 200/Tag global | Endpunkt ist öffentlich, `X-Backup-Secret` steht im Client-Quelltext |
| Material | KI wählt Linie **und** Farbe | Größter Nutzen; ändert bewusst auch den Preis |

**Kosten** bei ~550 Token rein / ~150 raus: Opus 5 ~$6,50 pro 1000 Anfragen,
Sonnet 5 ~$2,60, Haiku 4.5 ~$1,30. Der Preis pro Anfrage ist unkritisch — das
Limit schützt gegen Volumen, nicht gegen Stückkosten.

## Architektur

```
index.html                        server/api-server.js            api.anthropic.com
─────────                         ────────────────────            ─────────────────
Beschreibung + Palette
   │  POST /api/ai-suggest
   │  X-Backup-Secret
   └──────────────────────────────►  Rate-Limit (IP + Tag)
                                     Eingabe prüfen
                                     Schema aus Palette bauen
                                     ──────────────────────────►  /v1/messages
                                                                  Structured Output
                                     ◄──────────────────────────  {line,color,...}
   ◄──────────────────────────────  infill klemmen/runden
Farbe gegen PALETTE auflösen         {ok:true, suggestion}
Felder setzen + input-Events
Preis rechnet neu
```

### Warum die Palette im Request steckt

Das Modell muss echte Farbnamen kennen, sonst erfindet es welche. Die Palette
(`PALETTE_LINES`, 7 Linien, ~90 Farben) lebt in `index.html:333`. Sie im Server
zu duplizieren hieße: zwei Listen, die auseinanderdriften.

Stattdessen schickt der Client die Namen mit. Eine Quelle der Wahrheit, kein
Abgleich nötig. Weil der Client öffentlich ist, deckelt der Server die Liste
(≤10 Linien, ≤50 Farben je Linie, ≤40 Zeichen je Name) — sonst wäre das ein
Weg, den Prompt aufzublähen.

## Server: `POST /ai-suggest`

Neue Route in der bestehenden `ROUTES`-Tabelle (`server/api-server.js:146`).
Die `X-Backup-Secret`-Prüfung in `server/api-server.js:156` greift automatisch
für alle Routen, also auch für diese.

**Request**

```json
{
  "description": "Halterung fürs Fahrrad, muss Regen abkönnen",
  "palette": [{ "line": "PETG Basic", "colors": ["Red", "Black", "..."] }]
}
```

**Prüfungen, in dieser Reihenfolge:**

1. Rate-Limit (siehe unten) → 429
2. `description` ist String, getrimmt 1–1000 Zeichen → 400
3. `palette` ist Array, Grenzen wie oben → 400
4. `ANTHROPIC_API_KEY` gesetzt → sonst 500 mit klarer Meldung
   (gleiches Muster wie `handleSendMail` bei fehlendem `RESEND_API_KEY`)

**Rate-Limit** — in-memory, kein Speicher, kein Zusatzpaket:

- Pro IP 10 Anfragen je gleitender Stunde. IP aus dem ersten Eintrag von
  `X-Forwarded-For` (nginx setzt den; der Server hört nur auf `127.0.0.1`,
  direkte Aufrufe von außen gibt es nicht).
- Global 200 Anfragen je Kalendertag, Reset um Mitternacht.
- Beide überschritten → `429` mit `{ok:false, error:"..."}`. Der Client zeigt
  die Meldung und lässt manuelles Ausfüllen unangetastet.
- Neustart des Dienstes setzt die Zähler zurück. Bewusst in Kauf genommen —
  Persistenz wäre hier mehr Aufwand als Nutzen.

**Aufruf an Anthropic**

`POST https://api.anthropic.com/v1/messages`, Header `x-api-key`,
`anthropic-version: 2023-06-01`, `content-type: application/json`.

```js
{
  model: process.env.ANTHROPIC_MODEL || "claude-opus-5",
  max_tokens: 2000,
  system: "<Rolle, Materialkunde, Palette>",
  messages: [{ role: "user", content: description }],
  output_config: { format: { type: "json_schema", schema: SCHEMA } }
}
```

Zwei Modell-Eigenheiten, bewusst eingebaut:

- **`max_tokens: 2000`, nicht knapp bemessen.** Opus 5 denkt standardmäßig mit,
  und `max_tokens` deckelt Denken **plus** Antwort. Ein knapper Wert schneidet
  die Antwort mitten im JSON ab.
- **`output_config.effort` nur für Nicht-Haiku-Modelle.** Haiku 4.5 lehnt
  `effort` mit 400 ab. Da das Modell per Env-Var umschaltbar ist, wird das Feld
  nur gesetzt, wenn der Modellname kein `haiku` enthält — sonst bricht Jans
  Vergleichstest ohne erkennbaren Grund ab.

**Retry:** bei 429 und 529 einmal nach 1 s wiederholen, danach 502 an den
Client. Nicht mehr — ein Kunde wartet nicht dreimal.

### JSON-Schema

Structured Outputs erzwingt gültige Werte. **`minimum`, `maximum` und
`multipleOf` werden nicht unterstützt** — deshalb sind Schichthöhe und
Wandstärke als Enum modelliert, und Infill wird serverseitig geklemmt.

```json
{
  "type": "object",
  "properties": {
    "line":   { "type": "string", "enum": ["<aus der Palette des Requests>"] },
    "color":  { "type": "string" },
    "infill": { "type": "integer" },
    "layer":  { "type": "number", "enum": [0.08,0.12,0.16,0.2,0.24,0.28,0.32] },
    "walls":  { "type": "integer", "enum": [2,3,4,5] },
    "notes":  { "type": "string" },
    "reason": { "type": "string" }
  },
  "required": ["line","color","infill","layer","walls","notes","reason"],
  "additionalProperties": false
}
```

`layer` deckt genau die Rasterwerte des Reglers ab
(`index.html:248`, min 0.08 / max 0.32 / step 0.04). `walls` entspricht den vier
`<option>`-Werten aus `index.html:254`.

**Nachbearbeitung im Server:**

- `infill` auf 0–100 klemmen und auf 5er-Schritte runden (Reglerraster)
- `notes` und `reason` trimmen und auf 500 Zeichen kürzen
- `color` **nicht** serverseitig prüfen — das macht der Client, wo die Palette
  ohnehin liegt

## Client: `index.html`

Neue Karte über „Druckeinstellungen":

- `<textarea id="aiWish">` mit Platzhalter-Beispiel
- Button „Vorschlag holen", während des Aufrufs deaktiviert
- Ergebnisbereich für `reason`, sonst ausgeblendet

Konstante `AI_API_URL = "/api/ai-suggest"` neben den bestehenden
(`index.html:381`), Aufruf mit demselben `X-Backup-Secret`-Header wie
`/api/send-mail` (`index.html:1153`).

**Übernahme der Vorschläge:**

1. `line` + `color` gegen `PALETTE` auflösen (Name case-insensitiv). Kein
   Treffer → erste Farbe der Linie, damit immer eine gültige Auswahl steht.
2. `infill`, `layer`, `walls` setzen, danach je ein `input`- bzw.
   `change`-Event auslösen — sonst rechnet der Preis nicht neu.
3. `notes` an das bestehende Notizfeld anhängen, nicht überschreiben (der Kunde
   hat dort evtl. schon getippt).
4. `reason` anzeigen.

**Fehlerfall:** Meldung im Ergebnisbereich, Formular bleibt unberührt. Das
Feature ist additiv — fällt der Server oder der Key aus, funktioniert die Seite
unverändert weiter.

## Tests

`tests/e2e.mjs` (Playwright, 30 Tests, laufen bei jedem Push über GitHub
Actions). Neue Tests mocken `/api/ai-suggest` per Route-Interception:

1. Erfolgsfall füllt Infill, Schichthöhe, Wandstärke, Material und Farbe, und
   der angezeigte Preis ändert sich
2. Farbname, den es nicht gibt → Fallback auf die erste Farbe der Linie
3. Serverfehler (500) → Meldung sichtbar, Formularwerte unverändert
4. Rate-Limit (429) → Meldung sichtbar

**Kein echter API-Aufruf in CI.** Das kostet Geld und bräuchte den Key als
GitHub-Secret. Gegen die echte API testet Jan lokal beim Modellvergleich.

Für die Server-Logik ohne Netz: kleine Selbstprüfung für das Klemmen/Runden von
`infill` und die Rate-Limit-Zähler.

## Deploy

Änderung an `server/api-server.js` heißt: Dienst neu starten und Key in die Unit.

1. `git push` (normal, kein sudo)
2. Neues `deploy/setup-ki-vorschlag.sh` nach dem Muster von
   `deploy/setup-mail-feature.sh`: liest die bestehenden `Environment=`-Zeilen
   aus der Unit, ergänzt `ANTHROPIC_API_KEY` (und optional `ANTHROPIC_MODEL`),
   schreibt die Unit zurück
3. `sudo bash deploy/setup-ki-vorschlag.sh` + `systemctl restart druckauftrag-backup`
4. `sudo cp index.html /var/www/drucken.luetje.me/index.html`

Schritte 2–4 brauchen sudo mit Passwort — die muss Jan selbst ausführen.

## Bewusst nicht enthalten

- **Kein Prompt-Caching.** Bei sporadischem Kundenaufkommen läuft der 5-Minuten-
  Cache fast immer ab, bevor die nächste Anfrage kommt; der Cache-Write kostet
  dann mehr als er spart.
- **Keine Geometrie-Analyse.** Die KI sieht das hochgeladene Modell nicht. Der
  Vorschlag beruht allein auf der Beschreibung.
- **Kein Chat.** Ein Aufruf, ein Vorschlag. Wer unzufrieden ist, tippt um und
  klickt nochmal.
- **Keine Persistenz der Zähler** über Neustarts hinweg.

## Offene Frage für später

Ob der Vorschlag gut ist, sieht man erst an echten Kundentexten. Nach ein paar
Wochen lohnt ein Blick, ob die Vorschläge angenommen oder regelmäßig
überschrieben werden — das ist das eigentliche Qualitätssignal, nicht ein
Testlauf.
