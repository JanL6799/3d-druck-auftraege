# KI-Vorschläge für Druckeinstellungen — Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kunden beschreiben ihr Vorhaben in einem Satz; die Seite füllt daraus Material, Farbe, Infill, Schichthöhe und Wandstärke vor.

**Architecture:** Neue Route `POST /ai-suggest` im bestehenden Node-Dienst (`server/api-server.js`) ruft die Anthropic-Messages-API per rohem `fetch` auf und erzwingt per Structured Output ein festes JSON-Schema. `index.html` schickt Beschreibung plus Farbpalette hin und übernimmt die Antwort in die vorhandenen Formularfelder. Rate-Limit in-memory im Server.

**Tech Stack:** Node ≥ 18 (Bordmittel, eingebautes `fetch`), keine Laufzeit-Abhängigkeiten. Tests: Playwright (bereits als devDependency vorhanden), `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-08-16-ki-vorschlaege-design.md`

## Global Constraints

- **Keine neuen Laufzeit-Abhängigkeiten.** `server/api-server.js` nutzt ausschließlich Node-Bordmittel — das steht so im Dateikopf und gilt weiter. Playwright bleibt `devDependencies`.
- **`index.html` bleibt self-contained** — kein CDN, keine externen Assets. Das ist die Kerneigenschaft des Projekts.
- **Alle Texte im UI auf Deutsch**, Du-Form, wie im Rest der Seite.
- **Der API-Key steht nie im Client.** `ANTHROPIC_API_KEY` ist ausschließlich serverseitige Env-Var.
- **Das Feature ist additiv.** Fällt Server, Key oder API aus, muss die Seite unverändert manuell bedienbar bleiben.
- **`customerEmail` wird nirgends gespeichert** (bestehende Regel, `index.html:925` ff.) — der neue Code fasst dieses Feld nicht an.
- Nach jeder Aufgabe müssen `npm test` grün sein.

---

### Task 1: Server — Route, Eingabeprüfung, Rate-Limit

Noch ohne Anthropic-Aufruf. Am Ende antwortet die Route mit einem festen Dummy-Vorschlag; damit sind Prüfungen und Limit isoliert testbar.

**Files:**
- Modify: `server/api-server.js` (Konstanten oben, Handler vor `ROUTES`, Eintrag in `ROUTES:146`, Export unten)
- Create: `tests/server.mjs`
- Modify: `package.json` (Test-Skript)

**Interfaces:**
- Consumes: nichts
- Produces: `clampInfill(v) -> number`, `clientIp(req) -> string`, `validPalette(p) -> boolean`, `rateLimitCheck(ip, now) -> string|null` (Fehlertext oder `null` wenn erlaubt), `resetRateLimit()` für Tests

- [x] **Step 1: Test-Datei anlegen (schlägt fehl, weil nichts exportiert wird)**

`tests/server.mjs`:

```js
// Prüft die reine Server-Logik ohne Netz: Infill-Klemmen, Palette-Validierung, Rate-Limit.
//   node tests/server.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const api = require('../server/api-server.js');

const results = [];
function test(name, fn){
  try { fn(); results.push(['ok  ', name]); }
  catch(e){ results.push(['FAIL', name + ' — ' + e.message]); }
}

test('Infill wird auf 5er-Schritte gerundet', () => {
  assert.equal(api.clampInfill(23), 25);
  assert.equal(api.clampInfill(22), 20);
});

test('Infill wird auf 0..100 geklemmt', () => {
  assert.equal(api.clampInfill(-40), 0);
  assert.equal(api.clampInfill(999), 100);
});

test('Unsinniger Infill fällt auf 20 zurück', () => {
  assert.equal(api.clampInfill('keine Zahl'), 20);
  assert.equal(api.clampInfill(undefined), 20);
});

test('Palette: gültige Struktur wird akzeptiert', () => {
  assert.equal(api.validPalette([{ line: 'PLA Basic', colors: ['Rot', 'Blau'] }]), true);
});

test('Palette: leer, zu viele Linien oder falsche Typen werden abgelehnt', () => {
  assert.equal(api.validPalette([]), false);
  assert.equal(api.validPalette('nope'), false);
  assert.equal(api.validPalette([{ line: 'X', colors: [] }]), false);
  assert.equal(api.validPalette([{ line: 'X', colors: [42] }]), false);
  assert.equal(api.validPalette(Array.from({length: 11}, () => ({line:'X', colors:['a']}))), false);
});

test('Palette: überlange Namen werden abgelehnt', () => {
  assert.equal(api.validPalette([{ line: 'x'.repeat(41), colors: ['a'] }]), false);
  assert.equal(api.validPalette([{ line: 'X', colors: ['y'.repeat(41)] }]), false);
});

test('Rate-Limit: 10 Anfragen pro IP und Stunde sind erlaubt, die 11. nicht', () => {
  api.resetRateLimit();
  const t0 = Date.parse('2026-08-16T10:00:00Z');
  for (let i = 0; i < 10; i++) assert.equal(api.rateLimitCheck('1.2.3.4', t0 + i), null);
  assert.match(api.rateLimitCheck('1.2.3.4', t0 + 10), /Stunde/);
});

test('Rate-Limit: andere IP ist davon nicht betroffen', () => {
  api.resetRateLimit();
  const t0 = Date.parse('2026-08-16T10:00:00Z');
  for (let i = 0; i < 10; i++) api.rateLimitCheck('1.2.3.4', t0 + i);
  assert.equal(api.rateLimitCheck('5.6.7.8', t0 + 11), null);
});

test('Rate-Limit: nach einer Stunde ist die IP wieder frei', () => {
  api.resetRateLimit();
  const t0 = Date.parse('2026-08-16T10:00:00Z');
  for (let i = 0; i < 10; i++) api.rateLimitCheck('1.2.3.4', t0 + i);
  assert.equal(api.rateLimitCheck('1.2.3.4', t0 + 60*60*1000 + 1), null);
});

test('Rate-Limit: Tageslimit greift über alle IPs hinweg', () => {
  api.resetRateLimit();
  const t0 = Date.parse('2026-08-16T10:00:00Z');
  for (let i = 0; i < 200; i++) api.rateLimitCheck('ip-' + i, t0 + i);
  assert.match(api.rateLimitCheck('neue-ip', t0 + 201), /Tageslimit/);
});

test('Rate-Limit: am nächsten Tag ist das Tageslimit zurückgesetzt', () => {
  api.resetRateLimit();
  const t0 = Date.parse('2026-08-16T10:00:00Z');
  for (let i = 0; i < 200; i++) api.rateLimitCheck('ip-' + i, t0 + i);
  assert.equal(api.rateLimitCheck('neue-ip', t0 + 24*60*60*1000), null);
});

test('clientIp nimmt den ersten Eintrag aus X-Forwarded-For', () => {
  const req = { headers: {'x-forwarded-for': '203.0.113.9, 10.0.0.1'}, socket: {remoteAddress: '127.0.0.1'} };
  assert.equal(api.clientIp(req), '203.0.113.9');
});

test('clientIp fällt ohne Header auf die Socket-Adresse zurück', () => {
  const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(api.clientIp(req), '127.0.0.1');
});

for (const [s, n] of results) console.log(s, n);
if (results.some(([s]) => s === 'FAIL')) process.exit(1);
console.log(`\n${results.length} Server-Tests, alle grün.`);
```

- [x] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `node tests/server.mjs`
Expected: Absturz beim `require` bzw. lauter `FAIL`, weil `api.clampInfill` undefined ist.

- [x] **Step 3: Konstanten und Hilfsfunktionen in `server/api-server.js`**

Zu den bestehenden Konstanten (nach `MAX_BODY_MAIL:29`) ergänzen:

```js
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL   = process.env.ANTHROPIC_MODEL   || "claude-opus-5";
const MAX_BODY_AI       = 64 * 1024;   // Beschreibung + Palette, mehr braucht es nie
const AI_PER_IP_HOUR    = 10;
const AI_PER_DAY        = 200;
const AI_DESC_MAX       = 1000;
```

Vor der `ROUTES`-Tabelle einfügen:

```js
/* ---------- KI-Vorschlag ---------- */
// Rate-Limit rein im Arbeitsspeicher: ein Neustart des Dienstes setzt die Zähler zurück.
// Bewusst so — Persistenz wäre für ein Limit, das nur Missbrauch bremsen soll, zu viel Aufwand.
const aiIpHits = new Map();   // IP -> Zeitstempel[]
let aiDayKey = "", aiDayCount = 0;

function resetRateLimit(){ aiIpHits.clear(); aiDayKey = ""; aiDayCount = 0; }

function rateLimitCheck(ip, now = Date.now()){
  const today = new Date(now).toISOString().slice(0, 10);
  if (today !== aiDayKey){ aiDayKey = today; aiDayCount = 0; }
  if (aiDayCount >= AI_PER_DAY)
    return "Das Tageslimit für KI-Vorschläge ist erreicht. Bitte stell die Werte von Hand ein oder versuch es morgen erneut.";

  const hits = (aiIpHits.get(ip) || []).filter(t => now - t < 60*60*1000);
  if (hits.length >= AI_PER_IP_HOUR)
    return "Zu viele Anfragen von diesem Anschluss. Bitte in einer Stunde erneut versuchen.";

  hits.push(now);
  aiIpHits.set(ip, hits);
  aiDayCount++;
  // ponytail: einfacher Deckel gegen unbegrenztes Map-Wachstum. Reicht bei diesem
  // Anfragevolumen; bei echtem Dauerbetrieb wären zeitgesteuerte Aufräumläufe richtig.
  if (aiIpHits.size > 1000) aiIpHits.clear();
  return null;
}

function clientIp(req){
  // nginx setzt X-Forwarded-For; der Dienst hört nur auf 127.0.0.1, direkte Aufrufe
  // von außen gibt es also nicht.
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress || "unbekannt";
}

function clampInfill(v){
  const n = Math.round(Number(v) / 5) * 5;
  if (!Number.isFinite(n)) return 20;          // Modell hat Unsinn geliefert -> Standardwert
  return Math.max(0, Math.min(100, n));
}

function validPalette(p){
  return Array.isArray(p) && p.length > 0 && p.length <= 10 && p.every(g =>
    g && typeof g === "object" &&
    typeof g.line === "string" && g.line.length > 0 && g.line.length <= 40 &&
    Array.isArray(g.colors) && g.colors.length > 0 && g.colors.length <= 50 &&
    g.colors.every(c => typeof c === "string" && c.length > 0 && c.length <= 40));
}
```

- [x] **Step 4: Handler und Route ergänzen**

```js
async function handleAiSuggest(req, res){
  const limitError = rateLimitCheck(clientIp(req));
  if (limitError){
    res.writeHead(429, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:false, error:limitError}));
    return;
  }

  const body = await readBody(req, MAX_BODY_AI);
  let payload;
  try { payload = JSON.parse(body); }
  catch { res.writeHead(400); res.end("Ungültiges JSON"); return; }

  const description = typeof payload.description === "string" ? payload.description.trim() : "";
  if (!description || description.length > AI_DESC_MAX){
    res.writeHead(400, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:false, error:`Beschreibung fehlt oder ist länger als ${AI_DESC_MAX} Zeichen.`}));
    return;
  }
  if (!validPalette(payload.palette)){
    res.writeHead(400, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:false, error:"palette fehlt oder hat das falsche Format."}));
    return;
  }

  // Platzhalter — wird in Task 2 durch den echten Anthropic-Aufruf ersetzt.
  res.writeHead(200, {"Content-Type":"application/json"});
  res.end(JSON.stringify({ok:true, suggestion:{
    line: payload.palette[0].line, color: payload.palette[0].colors[0],
    infill: 20, layer: 0.2, walls: 3, notes: "", reason: "Platzhalter."
  }}));
}
```

In der `ROUTES`-Tabelle (`server/api-server.js:146`) ergänzen:

```js
  "POST /ai-suggest": handleAiSuggest,
```

- [x] **Step 5: Exporte für die Tests, Server nur als Hauptmodul starten**

Am Dateiende `server.listen(...)` ersetzen durch:

```js
if (require.main === module){
  server.listen(PORT, "127.0.0.1", () => {
    console.log("API-Server läuft auf 127.0.0.1:"+PORT+" (/backup, /send-mail, /calcbase, /ai-suggest), Ablage: "+DIR);
  });
}

// Für die Tests (tests/server.mjs) — beim Einbinden als Modul startet oben kein Listener.
module.exports = { clampInfill, clientIp, validPalette, rateLimitCheck, resetRateLimit };
```

- [x] **Step 6: Test-Skript erweitern**

`package.json`:

```json
  "scripts": {
    "test": "node tests/e2e.mjs && node tests/server.mjs"
  },
```

- [x] **Step 7: Tests laufen lassen**

Run: `node tests/server.mjs`
Expected: 13 Server-Tests, alle grün.

Run: `npm test`
Expected: die bestehenden 30 E2E-Tests weiterhin grün, danach die Server-Tests.

- [x] **Step 8: Commit**

```bash
git add server/api-server.js tests/server.mjs package.json
git commit -m "feat(server): /ai-suggest mit Eingabepruefung und Rate-Limit"
```

---

### Task 2: Server — Anthropic-Aufruf mit Structured Output

**Files:**
- Modify: `server/api-server.js` (Platzhalter aus Task 1 ersetzen, drei neue Funktionen)
- Modify: `tests/server.mjs` (Tests für Schema- und Prompt-Bau)

**Interfaces:**
- Consumes: `clampInfill`, `validPalette` aus Task 1
- Produces: `buildSchema(palette) -> object`, `systemPrompt(palette) -> string`, `buildRequestBody(description, palette) -> object`

- [x] **Step 1: Failing tests ergänzen**

In `tests/server.mjs` vor der Ausgabe-Schleife einfügen:

```js
const PAL = [
  { line: 'PLA Basic',  colors: ['Jade White', 'Black'] },
  { line: 'PETG Basic', colors: ['Red', 'Black'] },
];

test('Schema listet genau die Linien aus der Palette als Enum', () => {
  const s = api.buildSchema(PAL);
  assert.deepEqual(s.properties.line.enum, ['PLA Basic', 'PETG Basic']);
});

test('Schema rastert Schichthöhe und Wandstärke als Enum', () => {
  const s = api.buildSchema(PAL);
  assert.deepEqual(s.properties.layer.enum, [0.08, 0.12, 0.16, 0.2, 0.24, 0.28, 0.32]);
  assert.deepEqual(s.properties.walls.enum, [2, 3, 4, 5]);
});

test('Schema verlangt alle Felder und verbietet zusätzliche', () => {
  const s = api.buildSchema(PAL);
  assert.deepEqual(s.required, ['line','color','infill','layer','walls','notes','reason']);
  assert.equal(s.additionalProperties, false);
});

test('System-Prompt nennt jede Linie mit ihren Farben', () => {
  const p = api.systemPrompt(PAL);
  assert.match(p, /PLA Basic: Jade White, Black/);
  assert.match(p, /PETG Basic: Red, Black/);
});

test('Request-Body setzt Modell, max_tokens und das Schema', () => {
  const b = api.buildRequestBody('Halterung fürs Fahrrad', PAL);
  assert.equal(b.model, 'claude-opus-5');
  assert.equal(b.max_tokens, 2000);
  assert.equal(b.messages[0].content, 'Halterung fürs Fahrrad');
  assert.equal(b.output_config.format.type, 'json_schema');
  assert.deepEqual(b.output_config.format.schema.properties.line.enum, ['PLA Basic','PETG Basic']);
});

test('effort geht an Opus, aber nicht an Haiku (Haiku lehnt es mit 400 ab)', () => {
  assert.equal(api.buildRequestBody('x', PAL, 'claude-opus-5').output_config.effort, 'low');
  assert.equal(api.buildRequestBody('x', PAL, 'claude-haiku-4-5').output_config.effort, undefined);
});
```

Ergänze den Export-Block am Ende von `tests/server.mjs` nicht — die Ausgabe-Schleife bleibt, wo sie ist; die neuen Tests stehen davor.

- [x] **Step 2: Tests laufen lassen, Fehlschlag bestätigen**

Run: `node tests/server.mjs`
Expected: die sechs neuen Tests `FAIL` mit „api.buildSchema is not a function" o. ä.

- [x] **Step 3: Schema, Prompt und Request-Body implementieren**

In `server/api-server.js` nach `validPalette` einfügen:

```js
const AI_LAYERS = [0.08, 0.12, 0.16, 0.2, 0.24, 0.28, 0.32];  // Raster des Schichthöhen-Reglers
const AI_WALLS  = [2, 3, 4, 5];                                // Optionen des Wandstärke-Felds

// Structured Outputs unterstützt weder minimum/maximum noch multipleOf. Deshalb sind
// Schichthöhe und Wandstärke als Enum modelliert; Infill wird nachträglich geklemmt.
function buildSchema(palette){
  return {
    type: "object",
    properties: {
      line:   { type: "string",  enum: palette.map(g => g.line) },
      color:  { type: "string" },
      infill: { type: "integer" },
      layer:  { type: "number",  enum: AI_LAYERS },
      walls:  { type: "integer", enum: AI_WALLS },
      notes:  { type: "string" },
      reason: { type: "string" }
    },
    required: ["line","color","infill","layer","walls","notes","reason"],
    additionalProperties: false
  };
}

function systemPrompt(palette){
  const lines = palette.map(g => `- ${g.line}: ${g.colors.join(", ")}`).join("\n");
  return [
    "Du berätst Kunden einer kleinen 3D-Druckerei. Der Kunde beschreibt sein Vorhaben in Alltagssprache.",
    "Wähle daraus Material, Farbe und Druckeinstellungen.",
    "",
    "Materialkunde:",
    "- PLA Basic und PLA Matte: günstig, für Deko und Teile im Innenraum. Werden in praller Sonne und im Auto weich.",
    "- PETG Basic: witterungs- und UV-fest, wärmebeständiger. Für alles, was nach draußen soll.",
    "- PLA-CF und PETG-CF: steif und formstabil, für mechanisch belastete Teile. Teurer als die Basic-Linien.",
    "- PLA Translucent und PLA Pure: reine Optikmaterialien.",
    "",
    "Richtwerte: Infill 15 bis 20 Prozent für Deko, 30 bis 50 Prozent für belastete Teile.",
    "Schichthöhe 0.28 bis 0.32 wenn es schnell gehen soll, 0.12 bis 0.16 für sichtbare Details, sonst 0.2.",
    "Wandstärke 2 für Deko, 3 als Normalfall, 4 bis 5 für belastete Teile.",
    "",
    "Verfügbare Materialien und Farben. Wähle color exakt aus der Liste der gewählten Linie:",
    lines,
    "",
    "notes: ein kurzer Hinweis für den Drucker, oder leerer String wenn nichts anzumerken ist.",
    "reason: ein bis zwei Sätze auf Deutsch, für Laien verständlich, warum diese Wahl passt.",
    "Wenn du ein teureres Material als PLA Basic vorschlägst, nenne in reason ausdrücklich den Grund."
  ].join("\n");
}

function buildRequestBody(description, palette, model = ANTHROPIC_MODEL){
  const body = {
    model,
    max_tokens: 2000,   // Opus denkt standardmäßig mit; max_tokens deckelt Denken UND Antwort
    system: systemPrompt(palette),
    messages: [{ role: "user", content: description }],
    output_config: { format: { type: "json_schema", schema: buildSchema(palette) } }
  };
  // Haiku 4.5 lehnt output_config.effort mit 400 ab. Das Modell ist per Env-Var
  // umschaltbar, also darf das Feld nicht bedingungslos mitgehen.
  if (!/haiku/i.test(model)) body.output_config.effort = "low";
  return body;
}
```

- [x] **Step 4: Aufruf mit Retry**

```js
async function callAnthropic(body){
  for (let attempt = 0; attempt < 2; attempt++){
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (r.ok) return r.json();
    // 429 = Rate-Limit, 529 = überlastet. Alles andere ist ein echter Fehler, den ein
    // zweiter Versuch nicht heilt.
    if (r.status !== 429 && r.status !== 529) throw new Error("Anthropic antwortete mit HTTP " + r.status);
    if (attempt === 0) await new Promise(res => setTimeout(res, 1000));
  }
  throw new Error("Anthropic ist gerade überlastet.");
}
```

- [x] **Step 5: Platzhalter im Handler ersetzen**

Den Platzhalter-Block aus Task 1 Step 4 ersetzen durch:

```js
  if (!ANTHROPIC_API_KEY){
    res.writeHead(500, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:false, error:"ANTHROPIC_API_KEY ist auf dem Server nicht gesetzt."}));
    return;
  }

  try {
    const data = await callAnthropic(buildRequestBody(description, payload.palette));
    if (data.stop_reason === "refusal"){
      res.writeHead(422, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ok:false, error:"Zu dieser Beschreibung gibt es keinen Vorschlag. Bitte formuliere sie anders."}));
      return;
    }
    const block = (data.content || []).find(b => b.type === "text");
    if (!block) throw new Error("Antwort ohne Textblock.");
    const s = JSON.parse(block.text);

    res.writeHead(200, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:true, suggestion:{
      line:   s.line,
      color:  s.color,                       // Prüfung macht der Client, dort liegt die Palette
      infill: clampInfill(s.infill),
      layer:  s.layer,
      walls:  s.walls,
      notes:  String(s.notes  || "").trim().slice(0, 500),
      reason: String(s.reason || "").trim().slice(0, 500)
    }}));
  } catch (e){
    res.writeHead(502, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:false, error:"Der Vorschlag hat nicht geklappt: " + e.message}));
  }
```

- [x] **Step 6: Export ergänzen**

```js
module.exports = { clampInfill, clientIp, validPalette, rateLimitCheck, resetRateLimit,
                   buildSchema, systemPrompt, buildRequestBody };
```

- [x] **Step 7: Tests laufen lassen**

Run: `node tests/server.mjs`
Expected: 19 Tests, alle grün.

- [x] **Step 8: Commit**

```bash
git add server/api-server.js tests/server.mjs
git commit -m "feat(server): Anthropic-Aufruf mit Structured Output fuer /ai-suggest"
```

---

### Task 3: Lokaler Dev-Server zum Anschauen

Jan will das Feature vor dem Deploy lokal sehen. `index.html` ruft `/api/...` relativ auf — dafür müssen Seite und API auf derselben Origin liegen. In Produktion macht das nginx; lokal übernimmt es dieses Skript. **Wird nicht deployed.**

**Files:**
- Create: `dev/serve.mjs`
- Modify: `package.json` (Skript `dev`)

**Interfaces:**
- Consumes: die laufende `server/api-server.js` auf `127.0.0.1:8181`
- Produces: nichts, was andere Tasks nutzen

- [x] **Step 1: Dev-Server schreiben**

`dev/serve.mjs`:

```js
// Nur für die lokale Ansicht: liefert index.html aus und reicht /api/* an den
// API-Dienst auf 127.0.0.1:8181 weiter — dieselbe Origin, wie nginx es in Produktion macht.
// Wird NICHT deployed. Start: npm run dev
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const API  = 'http://127.0.0.1:8181';
const PORT = 8000;

const TYPES = { '.html':'text/html; charset=utf-8', '.png':'image/png', '.svg':'image/svg+xml' };

http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/')){
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      const r = await fetch(API + req.url.slice(4), {
        method: req.method,
        headers: {
          'content-type': 'application/json',
          'x-backup-secret': req.headers['x-backup-secret'] || '',
          'x-forwarded-for': '127.0.0.1'
        },
        body: chunks.length ? Buffer.concat(chunks) : undefined
      });
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, {'content-type':'application/json'});
      res.end(buf);
    } catch (e){
      res.writeHead(502, {'content-type':'application/json'});
      res.end(JSON.stringify({ok:false, error:'API-Dienst nicht erreichbar: ' + e.message}));
    }
    return;
  }

  const name = req.url === '/' ? 'index.html' : path.basename(req.url.split('?')[0]);
  fs.readFile(path.join(ROOT, name), (err, buf) => {
    if (err){ res.writeHead(404); res.end('nicht gefunden'); return; }
    res.writeHead(200, {'content-type': TYPES[path.extname(name)] || 'application/octet-stream'});
    res.end(buf);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`Lokale Ansicht: http://127.0.0.1:${PORT}`));
```

- [x] **Step 2: npm-Skript ergänzen**

`package.json`:

```json
  "scripts": {
    "test": "node tests/e2e.mjs && node tests/server.mjs",
    "dev": "node dev/serve.mjs"
  },
```

- [ ] **Step 3: Von Hand prüfen, dass die Kette steht**

Zwei Terminals:

```bash
# Terminal 1 — API-Dienst mit echtem Key
ANTHROPIC_API_KEY=... BACKUP_DIR=/tmp/druck-dev node server/api-server.js

# Terminal 2 — statische Seite + Proxy
npm run dev
```

Dann:

```bash
curl -s -X POST http://127.0.0.1:8000/api/ai-suggest \
  -H 'content-type: application/json' \
  -d '{"description":"Halterung fürs Fahrrad, muss Regen abkoennen",
       "palette":[{"line":"PLA Basic","colors":["Jade White","Black"]},
                  {"line":"PETG Basic","colors":["Red","Black"]}]}' | head -c 400
```

Expected: `{"ok":true,"suggestion":{"line":"PETG Basic",...}}` — die Linie sollte PETG sein, weil „muss Regen abkönnen" in der Beschreibung steht. Ist sie es nicht, ist der System-Prompt aus Task 2 zu schwach und muss nachgeschärft werden.

Ohne Key gesetzt: `{"ok":false,"error":"ANTHROPIC_API_KEY ist auf dem Server nicht gesetzt."}` mit HTTP 500.

- [x] **Step 4: Commit**

```bash
git add dev/serve.mjs package.json
git commit -m "chore(dev): lokaler Server fuer die Ansicht ohne nginx"
```

---

### Task 4: Client — Eingabefeld und Übernahme der Vorschläge

**Files:**
- Modify: `index.html` — neue Karte vor `Druckeinstellungen` (`index.html:238`), Konstante bei `index.html:381`, Logik im Abschnitt „Eingaben" (`index.html:918`)

**Interfaces:**
- Consumes: `POST /api/ai-suggest` aus Task 2
- Produces: `applySuggestion(s)` und `requestSuggestion()` — nur intern in `index.html`, keine weiteren Tasks bauen darauf auf

- [x] **Step 1: Karte ins Markup**

Direkt **vor** `<div class="card"><h3>Druckeinstellungen</h3>` (`index.html:238`) einfügen:

```html
    <div class="card">
      <h3>Beschreib dein Vorhaben</h3>
      <p class="sub">Ein Satz genügt — wir schlagen Material, Farbe und Einstellungen vor. Ändern kannst du alles danach noch.</p>
      <textarea id="aiWish" rows="2" placeholder="z. B. Halterung fürs Fahrrad, muss Regen abkönnen"></textarea>
      <div class="stack" style="margin-top:10px">
        <button id="btnAi">Vorschlag holen</button>
      </div>
      <div class="hint" id="aiOut" style="display:none"></div>
    </div>
```

- [x] **Step 2: Konstante ergänzen**

Bei den bestehenden API-Konstanten (`index.html:381`):

```js
const AI_API_URL = "/api/ai-suggest";
```

- [x] **Step 3: Übernahme-Logik**

Im Abschnitt „Eingaben" einfügen, direkt nach der Zeile
`["walls","qty","scale","ship"].forEach(...)` (`index.html:921`). Der `$`-Helfer ist ab
`index.html:403` definiert, `color` ab `index.html:400` — beides steht davor, passt also.

```js
/* ---------- KI-Vorschlag ---------- */
// Der Server kennt die Palette nicht — sie lebt hier in PALETTE_LINES. Sie geht mit dem
// Request raus und der zurückgelieferte Farbname wird hier gegen sie aufgelöst. So gibt es
// genau eine Quelle der Wahrheit für Materialien und Farben.
function applySuggestion(s){
  const line = PALETTE_LINES.find(g => g.line === s.line) || PALETTE_LINES[0];
  const name = String(s.color || "").toLowerCase();
  const hit  = line.colors.find(([n]) => n.toLowerCase() === name) || line.colors[0];
  const found = PALETTE.find(o => o.n === hit[0] && o.line === line.line);
  if (found){ color = {...found}; drawSwatches(); }

  // .value zu setzen löst kein Event aus — ohne dispatchEvent bleiben Label und Preis stehen.
  const set = (id, v) => { const el = $(id); el.value = String(v); el.dispatchEvent(new Event("input", {bubbles:true})); };
  set("infill", s.infill);
  set("layer",  s.layer);
  set("walls",  s.walls);

  if (s.notes){
    const n = $("notes");
    n.value = n.value ? n.value + "\n" + s.notes : s.notes;   // nie überschreiben
  }
  render();
}

async function requestSuggestion(){
  const wish = $("aiWish").value.trim();
  const out = $("aiOut");
  const btn = $("btnAi");
  out.style.display = "block";
  if (!wish){ out.textContent = "Bitte beschreib kurz, was du drucken lassen willst."; return; }

  btn.disabled = true;
  out.textContent = "Einen Moment …";
  try {
    const res = await fetch(AI_API_URL, {
      method: "POST",
      headers: { "Content-Type":"application/json", "X-Backup-Secret": BACKUP_SECRET },
      body: JSON.stringify({
        description: wish,
        palette: PALETTE_LINES.map(g => ({ line: g.line, colors: g.colors.map(([n]) => n) }))
      })
    });
    const data = await res.json();
    if (!data.ok){ out.textContent = data.error || "Das hat nicht geklappt."; return; }
    applySuggestion(data.suggestion);
    out.textContent = data.suggestion.reason || "Vorschlag übernommen.";
  } catch (e){
    out.textContent = "Der Vorschlag ist gerade nicht erreichbar. Stell die Werte einfach von Hand ein.";
  } finally {
    btn.disabled = false;
  }
}
$("btnAi").onclick = requestSuggestion;
```

- [ ] **Step 4: Von Hand im Browser prüfen**

Mit beiden Terminals aus Task 3: `http://127.0.0.1:8000` öffnen, „Halterung fürs Fahrrad, muss Regen abkönnen" eintippen, Button klicken.

Expected: Material springt auf eine PETG-Linie, ein Swatch ist markiert, Infill/Schichthöhe/Wandstärke ändern sich samt Beschriftung, der Preis rechnet sich neu, und unter dem Button steht die Begründung.

- [x] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat(index): Freitextfeld fuer KI-Vorschlaege samt Uebernahme"
```

---

### Task 5: E2E-Tests für den Client

Gemockt wird nach dem Muster des bestehenden Mail-Tests (`tests/e2e.mjs:413`): `window.fetch` wird innerhalb von `page.evaluate` ersetzt. **Kein echter API-Aufruf** — das kostet Geld und bräuchte den Key als GitHub-Secret.

**Files:**
- Modify: `tests/e2e.mjs` (neue Tests am Ende, vor der Ergebnisausgabe)

**Interfaces:**
- Consumes: `applySuggestion`, `#aiWish`, `#btnAi`, `#aiOut` aus Task 4
- Produces: nichts

- [x] **Step 1: Tests schreiben**

```js
/* ---------- KI-Vorschlag ---------- */

const aiSuggest = (suggestion, ok = true, error = null) => page.evaluate(async ({suggestion, ok, error}) => {
  const orig = window.fetch;
  let captured = null;
  window.fetch = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ok ? {ok:true, suggestion} : {ok:false, error} };
  };
  document.getElementById('aiWish').value = 'Halterung fürs Fahrrad, muss Regen abkönnen';
  document.getElementById('btnAi').click();
  await new Promise(r => setTimeout(r, 300));
  window.fetch = orig;
  return captured;
}, {suggestion, ok, error});

await test('KI-Vorschlag füllt Einstellungen und Material, Preis rechnet neu', async () => {
  await loadStl(boxSTL(20,20,20), 'cube.stl');
  const preisVorher = await text('#rTotal');
  const call = await aiSuggest({
    line:'PETG Basic', color:'Red', infill:40, layer:0.28, walls:5,
    notes:'Bitte ohne Stützen.', reason:'PETG hält Regen und UV aus.'
  });

  assert.equal(call.url, '/api/ai-suggest');
  assert.match(call.body.description, /Fahrrad/);
  assert.ok(call.body.palette.some(g => g.line === 'PETG Basic'),
    'Palette muss mitgeschickt werden, sonst kann das Modell keine echten Farben wählen');

  assert.equal(await page.$eval('#infill', el => el.value), '40');
  assert.equal(await page.$eval('#layer',  el => el.value), '0.28');
  assert.equal(await page.$eval('#walls',  el => el.value), '5');
  assert.equal(await text('#lInfill'), '40 %');
  assert.match(await text('#cHex'), /PETG Basic/);
  assert.equal(await text('#cName'), 'Red');
  assert.match(await text('#aiOut'), /PETG hält Regen/);
  assert.notEqual(await text('#rTotal'), preisVorher, 'Materialwechsel muss den Preis ändern');
});

await test('Unbekannter Farbname fällt auf die erste Farbe der Linie zurück', async () => {
  await aiSuggest({
    line:'PETG Basic', color:'Gibtsnicht', infill:20, layer:0.2, walls:3,
    notes:'', reason:'Test.'
  });
  assert.equal(await text('#cName'), 'Red', 'erste Farbe von PETG Basic');
});

await test('KI-Notiz wird angehängt, nicht überschrieben', async () => {
  await page.fill('#notes', 'Eigener Hinweis.');
  await aiSuggest({
    line:'PLA Basic', color:'Black', infill:20, layer:0.2, walls:3,
    notes:'Bitte ohne Stützen.', reason:'Test.'
  });
  const notes = await page.$eval('#notes', el => el.value);
  assert.match(notes, /Eigener Hinweis\./);
  assert.match(notes, /Bitte ohne Stützen\./);
});

await test('Serverfehler zeigt Meldung und lässt die Werte in Ruhe', async () => {
  await page.fill('#notes', '');
  const infillVorher = await page.$eval('#infill', el => el.value);
  await aiSuggest(null, false, 'Das Tageslimit für KI-Vorschläge ist erreicht.');
  assert.match(await text('#aiOut'), /Tageslimit/);
  assert.equal(await page.$eval('#infill', el => el.value), infillVorher);
});

await test('Leere Beschreibung ruft den Server gar nicht erst auf', async () => {
  const called = await page.evaluate(async () => {
    const orig = window.fetch;
    let hit = false;
    window.fetch = async () => { hit = true; return {ok:true, json: async () => ({ok:true})}; };
    document.getElementById('aiWish').value = '   ';
    document.getElementById('btnAi').click();
    await new Promise(r => setTimeout(r, 200));
    window.fetch = orig;
    return hit;
  });
  assert.equal(called, false);
  assert.match(await text('#aiOut'), /beschreib/i);
});
```

- [ ] **Step 2: Tests laufen lassen**

Run: `npm test`
Expected: 35 E2E-Tests grün (30 bestehende + 5 neue), danach 19 Server-Tests grün.

- [x] **Step 3: Commit**

```bash
git add tests/e2e.mjs
git commit -m "test: E2E-Tests fuer den KI-Vorschlag"
```

---

### Task 6: Deploy-Skript, nginx-Route, Doku

**Files:**
- Create: `deploy/setup-ki-vorschlag.sh`
- Modify: `NOTIZEN.md` (Skript-Tabelle bei Zeile 24, Routen-Liste bei Zeile 58, Deployment-Abschnitt bei Zeile 104)
- Modify: `README.md`

**Interfaces:**
- Consumes: die Route aus Task 2
- Produces: nichts

- [ ] **Step 1: Deploy-Skript schreiben**

`deploy/setup-ki-vorschlag.sh`, nach dem Muster von `deploy/setup-mail-feature.sh`:

```bash
#!/usr/bin/env bash
# Richtet den KI-Vorschlag auf dem Pi ein: ANTHROPIC_API_KEY in die systemd-Unit,
# nginx-Route /api/ai-suggest auf den Dienst, Webroot-Kopie von index.html.
#
# Ausführen mit: sudo bash deploy/setup-ki-vorschlag.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Bitte mit sudo ausführen: sudo bash deploy/setup-ki-vorschlag.sh" >&2
  exit 1
fi

REPO=/home/jan/3d-druck-auftraege
UNIT=/etc/systemd/system/druckauftrag-backup.service
SITE=/etc/nginx/sites-available/drucken.luetje.me
WEBROOT=/var/www/drucken.luetje.me

read -rsp "Anthropic-API-Key (console.anthropic.com): " ANTHROPIC_API_KEY; echo
[ -n "$ANTHROPIC_API_KEY" ] || { echo "Kein Key eingegeben, Abbruch." >&2; exit 1; }

read -rp "Modell [claude-opus-5]: " ANTHROPIC_MODEL
ANTHROPIC_MODEL=${ANTHROPIC_MODEL:-claude-opus-5}

echo "== 1/4: Key in die systemd-Unit =="
# Bestehende Environment-Zeilen behalten, ANTHROPIC_* ersetzen bzw. ergänzen.
sed -i '/^Environment=ANTHROPIC_/d' "$UNIT"
sed -i "/^ExecStart=/a Environment=ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY\nEnvironment=ANTHROPIC_MODEL=$ANTHROPIC_MODEL" "$UNIT"
chmod 600 "$UNIT"

echo "== 2/4: nginx-Route =="
if grep -q '/api/ai-suggest' "$SITE"; then
  echo "   Route existiert schon, übersprungen."
else
  sed -i '/location \/api\/send-mail/i\    location = /api/ai-suggest {\n        proxy_pass http://127.0.0.1:8181/ai-suggest;\n    }\n' "$SITE"
fi
nginx -t

echo "== 3/4: index.html in den Webroot =="
cp "$REPO/index.html" "$WEBROOT/index.html"

echo "== 4/4: Dienste neu laden =="
systemctl daemon-reload
systemctl restart druckauftrag-backup
systemctl reload nginx

echo
echo "Fertig. Kurztest:"
echo "  curl -s -X POST https://drucken.luetje.me/api/ai-suggest -H 'content-type: application/json' \\"
echo "    -d '{\"description\":\"Test\",\"palette\":[{\"line\":\"PLA Basic\",\"colors\":[\"Black\"]}]}'"
```

- [ ] **Step 2: Skript prüfen, ohne es auszuführen**

Run: `bash -n deploy/setup-ki-vorschlag.sh`
Expected: keine Ausgabe (Syntax in Ordnung).

Das Skript selbst **nicht** ausführen — es braucht sudo mit Passwort und gehört Jan.

- [ ] **Step 3: NOTIZEN.md nachziehen**

Drei Stellen:

- Skript-Tabelle (Zeile 24): Zeile ergänzen
  `| \`deploy/setup-ki-vorschlag.sh\` | Einmal-Setup für den KI-Vorschlag (Key in die Unit, nginx-Route, Webroot-Kopie) |`
- Routen-Liste (Zeile 58): `/ai-suggest` als fünfte Route mit einem Satz, was sie tut
- Deployment-Abschnitt (Zeile 104): den nginx-`location`-Block für `/api/ai-suggest` ergänzen

Dazu einen kurzen Abschnitt, der festhält:

```markdown
### KI-Vorschlag

`POST /api/ai-suggest` nimmt Beschreibung und Farbpalette entgegen und liefert
Material, Farbe, Infill, Schichthöhe, Wandstärke, Notiz und Begründung zurück.

- Modell über `ANTHROPIC_MODEL` umschaltbar, Standard `claude-opus-5`.
  Kosten je 1000 Anfragen: Opus 5 ~$6,50, Sonnet 5 ~$2,60, Haiku 4.5 ~$1,30.
- Limit: 10 Anfragen je IP und Stunde, 200 am Tag. Zähler liegen im Arbeitsspeicher
  und sind nach einem Neustart des Dienstes wieder auf null.
- Die Farbpalette lebt ausschließlich in `index.html` und geht mit dem Request raus.
  Der Server prüft nur die Struktur; den Farbnamen löst der Client auf.
- `output_config.effort` geht bewusst **nicht** an Haiku-Modelle — die lehnen das
  Feld mit HTTP 400 ab.
- `max_tokens` ist mit 2000 großzügig, weil Opus standardmäßig mitdenkt und
  `max_tokens` Denken plus Antwort zusammen deckelt.
```

- [ ] **Step 4: README.md ergänzen**

Einen Absatz in der Feature-Liste: Kunde beschreibt sein Vorhaben im Freitext, die Seite schlägt Material, Farbe und Einstellungen vor; braucht `ANTHROPIC_API_KEY` auf dem Server, ohne den läuft alles andere unverändert.

- [ ] **Step 5: Tests ein letztes Mal**

Run: `npm test`
Expected: alles grün.

- [ ] **Step 6: Commit**

```bash
git add deploy/setup-ki-vorschlag.sh NOTIZEN.md README.md
git commit -m "docs+deploy: Setup-Skript und Doku fuer den KI-Vorschlag"
```

---

## Danach — was Jan selbst machen muss

Alles mit sudo, kann Claude auf dieser Maschine nicht ausführen:

1. `sudo bash deploy/setup-ki-vorschlag.sh` (fragt Key und Modell ab)
2. Kurztest mit dem `curl`-Befehl, den das Skript am Ende ausgibt
3. Die Seite im Browser gegenprüfen

**Vor dem Deploy lokal anschauen** — genau dafür ist Task 3 da:

```bash
ANTHROPIC_API_KEY=... BACKUP_DIR=/tmp/druck-dev node server/api-server.js   # Terminal 1
npm run dev                                                                 # Terminal 2
# http://127.0.0.1:8000
```
