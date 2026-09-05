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
  assert.equal(b.max_tokens, 8000);
  assert.equal(b.messages[0].content, 'Halterung fürs Fahrrad');
  assert.equal(b.output_config.format.type, 'json_schema');
  assert.deepEqual(b.output_config.format.schema.properties.line.enum, ['PLA Basic','PETG Basic']);
});

test('effort geht an Opus, aber nicht an Haiku (Haiku lehnt es mit 400 ab)', () => {
  assert.equal(api.buildRequestBody('x', PAL, 'claude-opus-5').output_config.effort, 'low');
  assert.equal(api.buildRequestBody('x', PAL, 'claude-haiku-4-5').output_config.effort, undefined);
});

/* ---------- Modell aus Beschreibung ---------- */

test('SCAD-Schema verlangt Skript, Namen und Begründung', () => {
  const sc = api.scadSchema();
  assert.deepEqual(sc.required, ['scad','name','reason']);
  assert.equal(sc.additionalProperties, false);
});

test('SCAD-Request setzt Modell und Schema, effort nicht an Haiku', () => {
  const b = api.buildScadRequestBody('Distanzhülse 10 mm', 'claude-opus-5');
  assert.equal(b.output_config.format.type, 'json_schema');
  assert.equal(b.output_config.effort, 'low');
  assert.equal(api.buildScadRequestBody('x', 'claude-haiku-4-5').output_config.effort, undefined);
});

test('SCAD-Prompt verlangt benannte Variablen und verbietet Dateizugriff', () => {
  const p = api.scadSystemPrompt();
  assert.match(p, /benannten Variablen/);
  assert.match(p, /keine include-, use-, import- oder surface-Anweisungen/);
});

test('Harmloses Skript wird durchgelassen', () => {
  assert.equal(api.sanitizeScad('hoehe = 10; // mm\ncylinder(h=hoehe, r=5, $fn=48);'), null);
});

test('Dateizugriff wird abgelehnt', () => {
  for (const böse of [
    'include <MCAD/gears.scad>\ncube(10);',
    'use <lib.scad>\ncube(10);',
    'import("/etc/passwd");',
    'surface(file="/etc/shadow");',
  ]) assert.match(api.sanitizeScad(böse) || '', /Dateizugriff/, böse);
});

test('Leeres und überlanges Skript werden abgelehnt', () => {
  assert.match(api.sanitizeScad('') || '', /kein Skript/);
  assert.match(api.sanitizeScad('   ') || '', /kein Skript/);
  assert.match(api.sanitizeScad(undefined) || '', /kein Skript/);
  assert.match(api.sanitizeScad('cube(1);'.repeat(4000)) || '', /unplausibel lang/);
});

/* ---------- Bild und Moderation ---------- */

const jpeg = Buffer.from([0xFF,0xD8,0xFF,0xE0,0,0,0,0]).toString('base64');
const png  = Buffer.from([0x89,0x50,0x4E,0x47,13,10,26,10]).toString('base64');

test('Gültiges JPEG und PNG werden angenommen', () => {
  assert.equal(api.pruefeBild({media_type:'image/jpeg', data:jpeg}), null);
  assert.equal(api.pruefeBild({media_type:'image/png',  data:png}),  null);
});

test('Falscher media_type zu den Bytes wird abgelehnt', () => {
  assert.match(api.pruefeBild({media_type:'image/png', data:jpeg}) || '', /passt nicht zum angegebenen Format/);
});

test('Nicht unterstützte Formate werden abgelehnt', () => {
  for (const t of ['application/pdf','text/html','image/svg+xml','image/tiff'])
    assert.match(api.pruefeBild({media_type:t, data:jpeg}) || '', /nicht unterstuetzt/, t);
});

test('Fehlendes, leeres und zu großes Bild werden abgelehnt', () => {
  assert.match(api.pruefeBild(undefined) || '', /fehlt ein Bild/);
  assert.match(api.pruefeBild({media_type:'image/jpeg', data:''}) || '', /leer/);
  const gross = Buffer.alloc(5*1024*1024 + 10); gross[0]=0xFF; gross[1]=0xD8; gross[2]=0xFF;
  assert.match(api.pruefeBild({media_type:'image/jpeg', data:gross.toString('base64')}) || '', /zu gross/);
});

test('Moderations-Schema erzwingt Urteil, Kategorie und Hinweis', () => {
  const m = api.moderationSchema();
  assert.deepEqual(m.required, ['erlaubt','kategorie','hinweis']);
  assert.equal(m.properties.erlaubt.type, 'boolean');
  assert.ok(m.properties.kategorie.enum.includes('person'));
  assert.equal(m.additionalProperties, false);
});

test('Moderations-Prompt lehnt jede erkennbare Person ab, Statuen aber nicht', () => {
  const p = api.moderationSystemPrompt();
  assert.match(p, /Mensch erkennbar/);
  assert.match(p, /auch im Hintergrund/);
  assert.match(p, /Statuen, Puppen, Zeichnungen und Spielfiguren sind keine Menschen/);
});

test('Moderations-Request schickt Bild vor Text', () => {
  const b = api.buildModerationBody('Halterung', {media_type:'image/jpeg', data:jpeg});
  const inhalt = b.messages[0].content;
  assert.equal(inhalt[0].type, 'image');
  assert.equal(inhalt[0].source.media_type, 'image/jpeg');
  assert.equal(inhalt[1].type, 'text');
  assert.equal(b.output_config.format.schema.properties.kategorie.enum[0], 'ok');
});

test('SCAD-Request nimmt das Bild mit auf, wenn eines da ist', () => {
  const ohne = api.buildScadRequestBody('Huelse');
  assert.equal(typeof ohne.messages[0].content, 'string');
  const mit = api.buildScadRequestBody('Huelse', 'claude-opus-5', {media_type:'image/png', data:png});
  assert.equal(mit.messages[0].content[0].type, 'image');
  assert.match(mit.system, /Foto des gewuenschten Teils/);
});

test('Modell-Limit: 5 pro IP und Stunde, danach Sperre', () => {
  api.resetRateLimit();
  const t0 = Date.parse('2026-09-04T10:00:00Z');
  for (let i = 0; i < 5; i++)
    assert.equal(api.modelLimitCheck('9.9.9.9', t0 + i), null, 'Anfrage ' + (i+1));
  assert.match(api.modelLimitCheck('9.9.9.9', t0 + 6) || '', /5 pro Stunde/);
  assert.equal(api.modelLimitCheck('8.8.8.8', t0 + 7), null, 'andere IP unbetroffen');
  assert.equal(api.modelLimitCheck('9.9.9.9', t0 + 60*60*1000 + 1), null, 'nach einer Stunde frei');
});

test('Modell-Limit ist unabhängig vom Vorschlags-Limit', () => {
  api.resetRateLimit();
  const t0 = Date.parse('2026-09-04T10:00:00Z');
  for (let i = 0; i < 5; i++) api.modelLimitCheck('7.7.7.7', t0 + i);
  assert.equal(api.rateLimitCheck('7.7.7.7', t0 + 6), null, 'Vorschlag darf noch');
});

test('Moderation ohne Bild beurteilt nur den Text', () => {
  const b = api.buildModerationBody('Distanzhuelse 20 mm');
  assert.equal(typeof b.messages[0].content, 'string', 'ohne Bild reiner Text');
  assert.match(api.moderationSystemPrompt(), /Liegt kein Bild vor/);
});

test('Ablehnungstext passt zur Kategorie und erwähnt ohne Bild kein Foto', () => {
  assert.match(api.ablehnText('person', true), /nur den Gegenstand/);
  for (const k of ['sexuell','gewalt','hass','beschreibung','sonstiges','quatsch'])
    assert.doesNotMatch(api.ablehnText(k, false), /Foto|Bild/, k + ' ohne Bild');
  assert.match(api.ablehnText('sexuell', true), /anderes Bild/);
  assert.match(api.ablehnText('beschreibung', true), /formuliere sie anders/);
});

/* ---------- Guthaben mitzaehlen ---------- */

test('Preis wird nach Modellfamilie gewählt, Unbekanntes = teuerste Annahme', () => {
  assert.deepEqual(api.preisFuer('claude-haiku-4-5'), { in:1, out:5 });
  assert.deepEqual(api.preisFuer('claude-opus-5'),   { in:5, out:25 });
  assert.deepEqual(api.preisFuer('irgendwas-neues'), { in:5, out:25 });
});

test('Kosten in Euro aus Token und Rate', () => {
  // 1 Mio in + 1 Mio out bei Haiku ($1 + $5 = $6), Rate 0.5 -> 3 EUR
  const eur = api.kostenEur({input_tokens:1_000_000, output_tokens:1_000_000}, 'claude-haiku-4-5', 0.5);
  assert.equal(+eur.toFixed(4), 3);
});

test('Cache-Token zählen als Eingabe mit', () => {
  const eur = api.kostenEur({input_tokens:0, cache_read_input_tokens:1_000_000, output_tokens:0}, 'claude-haiku-4-5', 1);
  assert.equal(+eur.toFixed(4), 1);   // 1 Mio * $1 * Rate 1
});

test('Keine Usage -> keine Kosten', () => {
  assert.equal(api.kostenEur(null, 'claude-haiku-4-5'), 0);
});

/* ---------- Drei Varianten ---------- */

test('Varianten-Schema verlangt ein variants-Array aus name/scad/reason', () => {
  const sc = api.scadVariantsSchema();
  assert.equal(sc.properties.variants.type, 'array');
  assert.deepEqual(sc.properties.variants.items.required, ['name','scad','reason']);
  assert.equal(sc.properties.variants.items.additionalProperties, false);
});

test('Varianten-Body verlangt genau drei und setzt das Schema', () => {
  const b = api.buildVariantsBody('Halterung');
  assert.match(b.system, /GENAU DREI verschiedene Varianten/);
  assert.equal(b.output_config.format.schema.properties.variants.type, 'array');
  assert.equal(typeof b.messages[0].content, 'string');
});

test('Varianten-Body nimmt ein Bild mit auf, wenn vorhanden', () => {
  const jpeg = Buffer.from([0xFF,0xD8,0xFF,0xE0]).toString('base64');
  const b = api.buildVariantsBody('x', {media_type:'image/jpeg', data:jpeg});
  assert.equal(b.messages[0].content[0].type, 'image');
  assert.match(b.system, /Foto des gewuenschten Teils/);
});

for (const [s, n] of results) console.log(s, n);
if (results.some(([s]) => s === 'FAIL')) process.exit(1);
console.log(`\n${results.length} Server-Tests, alle grün.`);
