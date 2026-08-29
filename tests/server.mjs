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
