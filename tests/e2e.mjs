// Ende-zu-Ende-Tests der 3D-Druck-Auftragserfassung.
// Läuft headless gegen die lokalen index.html/backend.html — kein Server nötig.
//   npm install && npx playwright install chromium && npm test
//
// index.html (öffentliche Seite): Modell, Kalkulation, Material, PDF, Mail — läuft gegen `page`.
// backend.html (Kalkulationsbasis, Auftragsdaten, Aufträge — nur intern): läuft gegen `pageB`.
// Beide teilen sich dieselbe Rechenlogik und denselben localStorage-Origin, sind aber getrennte
// Seiten seit der Aufteilung in öffentliche Kundenseite und internes Backend.
import { chromium } from 'playwright';
import { deflateRawSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = pathToFileURL(path.join(HERE, '..', 'index.html')).href;
const BACKEND = pathToFileURL(path.join(HERE, '..', 'backend.html')).href;

/* ---------- Testdaten ---------- */

// Quader als ASCII-STL; dropOne=true lässt ein Dreieck weg -> Loch im Mesh
function boxSTL(sx, sy, sz, dropOne = false){
  const V = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]];
  const F = [[0,3,2],[0,2,1],[4,5,6],[4,6,7],[0,1,5],[0,5,4],
             [1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  if (dropOne) F.pop();
  let s = 'solid box\n';
  for (const [a,b,c] of F){
    s += 'facet normal 0 0 0\nouter loop\n';
    for (const i of [a,b,c]) s += `vertex ${V[i][0]} ${V[i][1]} ${V[i][2]}\n`;
    s += 'endloop\nendfacet\n';
  }
  return s + 'endsolid box\n';
}

// 20-mm-Würfel als 3MF (ZIP mit einem deflate-komprimierten .model-Eintrag)
function cube3MF(){
  const V = [[0,0,0],[20,0,0],[20,20,0],[0,20,0],[0,0,20],[20,0,20],[20,20,20],[0,20,20]];
  const F = [[0,3,2],[0,2,1],[4,5,6],[4,6,7],[0,1,5],[0,5,4],
             [1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  const verts = V.map(([x,y,z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('');
  const tris  = F.map(([a,b,c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<resources><object id="1" type="model"><mesh><vertices>${verts}</vertices><triangles>${tris}</triangles></mesh></object></resources>
<build><item objectid="1"/></build></model>`;
  return zip('3D/3dmodel.model', Buffer.from(xml, 'utf8'));
}

// 20-mm-Würfel als 3MF nach 3MF-Production-Extension: die Hauptdatei enthält nur einen
// <component p:path="…">-Verweis, die eigentliche Geometrie liegt in einer zweiten Datei im
// selben ZIP (so legt Bambu Studio größere Modelle ab, z.B. unter 3D/Objects/object_1.model).
function splitCube3MF(){
  const V = [[0,0,0],[20,0,0],[20,20,0],[0,20,0],[0,0,20],[20,0,20],[20,20,20],[0,20,20]];
  const F = [[0,3,2],[0,2,1],[4,5,6],[4,6,7],[0,1,5],[0,5,4],
             [1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  const verts = V.map(([x,y,z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('');
  const tris  = F.map(([a,b,c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('');
  const objectXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<resources><object id="1" type="model"><mesh><vertices>${verts}</vertices><triangles>${tris}</triangles></mesh></object></resources>
<build/></model>`;
  const rootXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
       xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
<resources><object id="2" type="model"><components>
  <component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
</components></object></resources>
<build><item objectid="2"/></build></model>`;
  return zipMulti([
    { name: '3D/3dmodel.model',        data: Buffer.from(rootXml, 'utf8') },
    { name: '3D/Objects/object_1.model', data: Buffer.from(objectXml, 'utf8') }
  ]);
}

function zipMulti(files){
  const locals = [], centrals = [];
  let offset = 0;
  for (const {name, data} of files){
    const nameB = Buffer.from(name, 'utf8');
    const comp = deflateRawSync(data);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50,0); lh.writeUInt16LE(20,4); lh.writeUInt16LE(8,8);
    lh.writeUInt32LE(crc,14); lh.writeUInt32LE(comp.length,18); lh.writeUInt32LE(data.length,22);
    lh.writeUInt16LE(nameB.length,26);
    const local = Buffer.concat([lh, nameB, comp]);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50,0); cd.writeUInt16LE(20,4); cd.writeUInt16LE(20,6); cd.writeUInt16LE(8,10);
    cd.writeUInt32LE(crc,16); cd.writeUInt32LE(comp.length,20); cd.writeUInt32LE(data.length,24);
    cd.writeUInt16LE(nameB.length,28); cd.writeUInt32LE(offset,42);
    centrals.push(Buffer.concat([cd, nameB]));
    locals.push(local);
    offset += local.length;
  }
  const localsBuf = Buffer.concat(locals), centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50,0); eocd.writeUInt16LE(files.length,8); eocd.writeUInt16LE(files.length,10);
  eocd.writeUInt32LE(centralBuf.length,12); eocd.writeUInt32LE(localsBuf.length,16);
  return Buffer.concat([localsBuf, centralBuf, eocd]);
}

function zip(name, data){
  const nameB = Buffer.from(name, 'utf8');
  const comp = deflateRawSync(data);
  const crc = crc32(data);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50,0); lh.writeUInt16LE(20,4); lh.writeUInt16LE(8,8);
  lh.writeUInt32LE(crc,14); lh.writeUInt32LE(comp.length,18); lh.writeUInt32LE(data.length,22);
  lh.writeUInt16LE(nameB.length,26);
  const local = Buffer.concat([lh, nameB, comp]);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50,0); cd.writeUInt16LE(20,4); cd.writeUInt16LE(20,6); cd.writeUInt16LE(8,10);
  cd.writeUInt32LE(crc,16); cd.writeUInt32LE(comp.length,20); cd.writeUInt32LE(data.length,24);
  cd.writeUInt16LE(nameB.length,28);
  const central = Buffer.concat([cd, nameB]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50,0); eocd.writeUInt16LE(1,8); eocd.writeUInt16LE(1,10);
  eocd.writeUInt32LE(central.length,12); eocd.writeUInt32LE(local.length,16);
  return Buffer.concat([local, central, eocd]);
}
function crc32(buf){
  let c, crc = 0xFFFFFFFF;
  for (let i=0;i<buf.length;i++){
    c = (crc ^ buf[i]) & 0xFF;
    for (let k=0;k<8;k++) c = c & 1 ? (c>>>1) ^ 0xEDB88320 : c>>>1;
    crc = (crc>>>8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

const CSV = `Order Number;Buyer Username;Item Title
14-13454-98123;maxmuster;Vase
88-00011-22233;lisa_k;Zahnrad
14-13454-98123;maxmuster;Vase
;;leerzeile
99-55500-11122;tom3d;Halterung`;

/* ---------- Testlauf ---------- */

const browser = await chromium.launch();
const page = await browser.newPage();
const pageB = await browser.newPage();
const jsErrors = [];
page.on('pageerror', e => jsErrors.push('[index] ' + e.message));
pageB.on('pageerror', e => jsErrors.push('[backend] ' + e.message));
await page.goto(INDEX);
await pageB.goto(BACKEND);

const results = [];
async function test(name, fn){
  try { await fn(); results.push(['ok  ', name]); }
  catch(e){ results.push(['FAIL', name + ' — ' + e.message]); }
}
const loadStl = async (txt, name, pg=page) => pg.evaluate(
  async ({txt, name}) => { await window.loadFile(new File([txt], name)); }, {txt, name});
const text = (sel, pg=page) => pg.textContent(sel);
const warnShown = (pg=page) => pg.$eval('#warn', el => el.classList.contains('show'));

await test('STL-Würfel 20 mm → exakt 8000 mm³', async () => {
  await loadStl(boxSTL(20,20,20), 'cube.stl');
  assert.equal(await text('#rVol'), '8,0 cm³');
  assert.equal(await text('#rDim'), '20 × 20 × 20 mm');
});

await test('Wasserdichtes Mesh: keine Warnung', async () => {
  assert.equal(await warnShown(), false);
});

await test('Loch im Mesh → Wasserdicht-Warnung', async () => {
  await loadStl(boxSTL(20,20,20,true), 'holey.stl');
  assert.equal(await warnShown(), true);
  assert.match(await text('#warn'), /wasserdicht/);
});

await test('3MF-Würfel → exakt 8000 mm³', async () => {
  const b64 = cube3MF().toString('base64');
  await page.evaluate(async b64 => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    await window.loadFile(new File([bytes], 'cube.3mf'));
  }, b64);
  assert.equal(await text('#rVol'), '8,0 cm³');
  assert.equal(await text('#rDim'), '20 × 20 × 20 mm');
});

await test('3MF mit externer Objektdatei (Production Extension) wird aufgelöst', async () => {
  const b64 = splitCube3MF().toString('base64');
  await page.evaluate(async b64 => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    await window.loadFile(new File([bytes], 'split.3mf'));
  }, b64);
  assert.equal(await text('#rVol'), '8,0 cm³');
  assert.equal(await text('#rDim'), '20 × 20 × 20 mm');
});

await test('Slicer-Zeit übersteuert die Schätzung', async () => {
  await page.fill('#slicerTime', '2:30');
  const t = await text('#rTime');
  assert.match(t, /2 h 30 min/);
  assert.match(t, /Slicer/);
  await page.fill('#slicerTime', '');
  assert.doesNotMatch(await text('#rTime'), /Slicer/);
});

await test('Bauraum-Warnung berücksichtigt 90°-Drehung', async () => {
  await loadStl(boxSTL(25,10,5), 'brick.stl', pageB);
  await pageB.click('#btnCalcBase');           // Kalkulationsbasis ist standardmäßig eingeklappt
  const setBed = async (x,y,z) => {
    for (const [id,v] of [['bx',x],['by',y],['bz',z]]) await pageB.fill('#'+id, String(v));
  };
  await setBed(12,30,50);                 // passt nur gedreht
  assert.equal(await warnShown(pageB), false);
  await setBed(12,20,50);                 // passt auch gedreht nicht
  assert.match(await text('#warn', pageB), /überschreitet/);
  await setBed(256,256,256);
});

await test('CSV-Import: 3 Aufträge, Duplikate und Leerzeilen gefiltert', async () => {
  await pageB.click('#btnOrders');           // Aufträge ist standardmäßig eingeklappt
  await pageB.click('#btnImport');
  await pageB.fill('#impText', CSV);
  await pageB.click('#impParse');
  await pageB.click('#impDo');
  assert.equal(await pageB.$$eval('.oitem', els => els.length), 3);
});

await test('Auftragsänderung löst Server-Backup-Versuch aus (fire-and-forget)', async () => {
  const call = await pageB.evaluate(() => {
    const orig = window.fetch;
    let captured = null;
    window.fetch = (url, opts) => { captured = { url, opts }; return Promise.reject(new Error('kein Server im Test')); };
    persistOrders();
    window.fetch = orig;
    return captured;
  });
  assert.equal(call.url, '/api/backup');
  assert.match(call.opts.headers['X-Backup-Secret'], /^[0-9a-f]{10,}$/);
  const body = JSON.parse(call.opts.body);
  assert.ok(Array.isArray(body.orders));
});

await test('Auftrag anklicken lädt Bestellnummer und Käufer', async () => {
  await pageB.locator('.oitem', { hasText: '88-00011-22233' }).click();
  assert.equal(await pageB.inputValue('#orderId'), '88-00011-22233');
  assert.equal(await pageB.inputValue('#buyer'), 'lisa_k');
});

await test('Status weiterschalten und filtern', async () => {
  await pageB.click('.oitem .stbadge');    // offen → gedruckt
  await pageB.click('.fchip[data-f="gedruckt"]');
  assert.equal(await pageB.$$eval('.oitem', els => els.length), 1);
  await pageB.click('.fchip[data-f="alle"]');
  assert.equal(await pageB.$$eval('.oitem', els => els.length), 3);
});

await test('Suche filtert die Liste', async () => {
  await pageB.fill('#oSearch', 'lisa');
  assert.equal(await pageB.$$eval('.oitem', els => els.length), 1);
  await pageB.fill('#oSearch', '');
  assert.equal(await pageB.$$eval('.oitem', els => els.length), 3);
});

await test('Sichern dedupliziert Geometrie über den Mesh-Speicher', async () => {
  // Der Auftragsklick oben hat das Modell korrekt geleert — für diesen Test frisch laden
  await loadStl(boxSTL(25,10,5), 'brick.stl', pageB);
  await pageB.click('#btnOrderSave');
  const r = await pageB.evaluate(() => {
    const orders = JSON.parse(localStorage.getItem('druckauftrag.orders.v1'));
    const withRef = orders.filter(o => o.snapshot && o.snapshot.meshHash).length;
    const embedded = orders.filter(o => o.snapshot && o.snapshot.mesh).length;
    const store = Object.keys(JSON.parse(localStorage.getItem('druckauftrag.meshes.v1') || '{}')).length;
    return { withRef, embedded, store };
  });
  assert.ok(r.withRef >= 1, 'kein Auftrag mit meshHash');
  assert.equal(r.embedded, 0, 'Geometrie doppelt eingebettet');
  assert.ok(r.store >= 1, 'Mesh-Speicher leer');
});

await test('Duplizieren: Modell bleibt, Käufer/Bestellnummer leer', async () => {
  const before = await pageB.$$eval('.oitem', els => els.length);
  await pageB.click('.oitem [data-dup]');
  assert.equal(await pageB.$$eval('.oitem', els => els.length), before + 1);
  assert.equal(await pageB.inputValue('#orderId'), '');
  assert.equal(await pageB.inputValue('#buyer'), '');
});

await test('Backup-Restore übernimmt neue Aufträge, überspringt bekannte', async () => {
  const added = await pageB.evaluate(() => applyBackup({
    v:1, type:'druckauftrag-backup',
    orders:[{ id:'restore-test-1', saved:new Date().toISOString(), platform:'eBay',
              orderId:'T-1', buyer:'tester', priceText:'', status:'offen',
              snapshot:{v:2, fields:{orderId:'T-1'}} }],
    meshes:{}
  }));
  assert.equal(added, 1);
  const again = await pageB.evaluate(() => applyBackup({
    v:1, type:'druckauftrag-backup',
    orders:[{ id:'restore-test-1', snapshot:{v:2, fields:{}} }], meshes:{}
  }));
  assert.equal(again, 0);
});

await test('Aufträge: Frist-Countdown zeigt korrekten Text und sortiert nach Dringlichkeit', async () => {
  // Lokale Kalendertage statt toISOString() — die App vergleicht in Lokalzeit (Mitternacht),
  // UTC-Strings könnten je nach Zeitzone/Uhrzeit auf den falschen Tag fallen.
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const tomorrow  = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const farOut    = new Date(today); farOut.setDate(farOut.getDate() + 10);

  await pageB.evaluate(({over, soon, far}) => applyBackup({
    v:1, type:'druckauftrag-backup',
    orders:[
      { id:'due-over', saved:new Date().toISOString(), platform:'Direktanfrage', orderId:'D-OVER', buyer:'', priceText:'', status:'offen', snapshot:{v:2, fields:{due:over}} },
      { id:'due-soon', saved:new Date().toISOString(), platform:'Direktanfrage', orderId:'D-SOON', buyer:'', priceText:'', status:'offen', snapshot:{v:2, fields:{due:soon}} },
      { id:'due-far',  saved:new Date().toISOString(), platform:'Direktanfrage', orderId:'D-FAR',  buyer:'', priceText:'', status:'offen', snapshot:{v:2, fields:{due:far}} },
    ],
    meshes:{}
  }), {over: fmt(yesterday), soon: fmt(tomorrow), far: fmt(farOut)});

  await pageB.click('.fchip[data-sort="frist"]');
  const order = await pageB.$$eval('.oitem', els => els.map(el => el.dataset.id));
  const idx = id => order.indexOf(id);
  assert.ok(idx('due-over') < idx('due-soon'), 'überfälliger Auftrag steht vor "bald fällig"');
  assert.ok(idx('due-soon') < idx('due-far'), '"bald fällig" steht vor weit entferntem Termin');
  assert.ok(idx('due-far') < idx('restore-test-1'), 'Auftrag mit Termin steht vor Auftrag ohne Termin');

  const overText = await pageB.$eval('.oitem[data-id="due-over"] .due-over', el => el.textContent);
  assert.match(overText, /1 Tag überfällig/);
  const soonText = await pageB.$eval('.oitem[data-id="due-soon"] .due-soon', el => el.textContent);
  assert.match(soonText, /noch 1 Tag/);

  await pageB.click('.fchip[data-sort="neu"]');   // Standard-Sortierung für nachfolgende Tests wiederherstellen
});

await test('Farbwahl legt Material für die Kalkulation fest', async () => {
  const cMatBefore = await page.evaluate(() => calc().cMat);
  await page.locator('.sw[data-line="PETG-CF"]').first().click();
  assert.match(await text('#cHex'), /PETG-CF/);
  const cMatAfter = await page.evaluate(() => calc().cMat);
  assert.notEqual(cMatAfter, cMatBefore);
});

await test('Mail-Button warnt ohne gültige Kunden-E-Mail', async () => {
  await page.fill('#customerEmail', '');
  await page.click('#btnMail');
  assert.match(await text('#warn'), /gültige E-Mail-Adresse/);
  await page.fill('#customerEmail', 'keine-email');
  await page.click('#btnMail');
  assert.match(await text('#warn'), /gültige E-Mail-Adresse/);
});

async function assertEmailNeverPersisted(pg){
  await pg.fill('#customerEmail', 'geheim@beispiel.de');
  await pg.click('#btnSave');
  const saved = await pg.evaluate(() => localStorage.getItem('druckauftrag.v2'));
  assert.ok(saved && !saved.includes('geheim@beispiel.de'),
    '"Stand speichern" darf die Kontakt-E-Mail nicht in localStorage ablegen');
  const snap = await pg.evaluate(() => JSON.stringify(snapshot()));
  assert.ok(!snap.includes('geheim@beispiel.de'),
    'snapshot() darf die Kontakt-E-Mail nicht enthalten (FIELDS schließt customerEmail bewusst aus)');
}
await test('index.html: Kontakt-E-Mail wird nie gespeichert, auch nicht über "Stand speichern"', async () => {
  await assertEmailNeverPersisted(page);
});
await test('backend.html: Kontakt-E-Mail wird nie gespeichert, auch nicht über "Stand speichern"', async () => {
  await assertEmailNeverPersisted(pageB);
});

await test('Mail-Button verschickt Auftrag mit echtem STL- und Stand-Anhang, Kunden-Mail als reply_to', async () => {
  await page.fill('#customerEmail', 'kunde@beispiel.de');
  const call = await page.evaluate(async () => {
    const orig = window.fetch;
    let captured = null;
    window.fetch = async (url, opts) => {
      captured = { url, body: JSON.parse(opts.body) };
      return { ok: true, json: async () => ({ok:true, id:'test-id'}) };
    };
    document.getElementById('btnMail').click();
    await new Promise(r => setTimeout(r, 300));
    window.fetch = orig;
    return captured;
  });
  assert.equal(call.url, '/api/send-mail');
  assert.equal(call.body.replyTo, 'kunde@beispiel.de');
  assert.match(call.body.subject, /^3D-Druck Auftrag/);
  assert.match(call.body.text, /Kontakt: kunde@beispiel\.de/);
  assert.match(call.body.text, /Materialbedarf/);
  assert.match(call.body.text, /Preis: /);
  assert.doesNotMatch(call.body.text, /Plattform:/);
  assert.doesNotMatch(call.body.text, /Bestellnummer:/);
  assert.doesNotMatch(call.body.text, /Käufer:/);
  assert.doesNotMatch(call.body.text, /Liefern bis:/);
  assert.equal(call.body.attachments.length, 2);
  assert.match(call.body.attachments[0].filename, /\.stl$/);
  assert.ok(call.body.attachments[0].content.length > 0);
  assert.match(call.body.attachments[1].filename, /^stand-.*\.json$/);
});

await test('Mail-Button warnt ohne geladenes Modell', async () => {
  await page.click('#btnClear');
  await page.click('#btnMail');
  assert.match(await text('#warn'), /zuerst eine STL- oder 3MF-Datei laden/);
});

// migrateV1()/applyState() sind dieselbe Funktion auf beiden Seiten, nur mit einer kürzeren
// FIELDS-Liste auf index.html (kein buyer/orderId dort mehr) — ein voller Migrationstest lohnt
// sich nur im Backend, wo alle Felder existieren. Die v3-Ablehnung ist seitenunabhängig,
// bleibt aber hier gleich mitgetestet statt eines eigenen, fast identischen Tests auf index.html.
await test('v1-Stand lädt (Migration), neuere Version wird abgelehnt', async () => {
  const v1 = await pageB.evaluate(() => {
    window.applyState({ v:1, buyer:'altkunde', orderId:'V1-001', infill:'55', qty:'3' });
    return { buyer: document.getElementById('buyer').value,
             qty: document.getElementById('qty').value };
  });
  assert.equal(v1.buyer, 'altkunde');
  assert.equal(v1.qty, '3');
  const msg = await pageB.evaluate(() => {
    try { window.applyState({v:3}); return null; } catch(e){ return e.message; }
  });
  assert.match(msg, /neueren Version/);
});

// Dieselbe v1-Migration, aber mit der kürzeren FIELDS-Liste von index.html: buyer/orderId
// existieren dort nicht mehr, infill/qty aber schon.
await test('v1-Stand lädt (Migration) auch mit der kürzeren Feldliste von index.html', async () => {
  const v1 = await page.evaluate(() => {
    window.applyState({ v:1, buyer:'altkunde', orderId:'V1-001', infill:'55', qty:'3' });
    return { infill: document.getElementById('infill').value,
             qty: document.getElementById('qty').value };
  });
  assert.equal(v1.infill, '55');
  assert.equal(v1.qty, '3');
});

await test('index.html: Mail ist hervorgehoben und steht nach PDF, Backend-Blöcke fehlen, E-Mail-Feld ist Pflicht', async () => {
  const order = await page.$$eval('header .stack button', els => els.map(el => el.id));
  assert.ok(order.indexOf('btnPdf') < order.indexOf('btnMail'), 'PDF steht vor Mail');
  assert.equal(await page.getAttribute('#btnPdf', 'class'), 'sm');
  assert.match(await page.getAttribute('#btnMail', 'class'), /primary/);
  for (const id of ['calcBaseBody', 'orderDataBody', 'ordersBody', 'modal'])
    assert.equal(await page.$(`#${id}`), null, `#${id} sollte auf index.html nicht existieren`);
  assert.equal(await page.getAttribute('#customerEmail', 'type'), 'email');
  assert.notEqual(await page.getAttribute('#customerEmail', 'required'), null);
});

await test('backend.html: Kalkulationsbasis/Auftragsdaten/Aufträge sind vorhanden, E-Mail-Feld ist Pflicht', async () => {
  for (const id of ['calcBaseBody', 'orderDataBody', 'ordersBody'])
    assert.notEqual(await pageB.$(`#${id}`), null, `#${id} sollte im Backend existieren`);
  assert.equal(await pageB.getAttribute('#customerEmail', 'type'), 'email');
  assert.notEqual(await pageB.getAttribute('#customerEmail', 'required'), null);
});

await test('Darstellung-Toggle merkt sich die Wahl über einen Reload', async () => {
  const before = await page.evaluate(() => document.documentElement.dataset.theme || null);
  await page.click('#btnTheme');
  const after = await page.evaluate(() => document.documentElement.dataset.theme);
  assert.notEqual(after, before);
  await page.reload();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), after);
});

await test('Keine JS-Fehler im gesamten Lauf', () => {
  assert.deepEqual(jsErrors, []);
});

await browser.close();

/* ---------- Ergebnis ---------- */
let failed = 0;
for (const [st, name] of results){
  if (st === 'FAIL') failed++;
  console.log(st + '  ' + name);
}
console.log(`\n${results.length - failed}/${results.length} Tests bestanden`);
process.exit(failed ? 1 : 0);
