// Ende-zu-Ende-Tests der 3D-Druck-Auftragserfassung.
// Läuft headless gegen die lokale index.html — kein Server nötig.
//   npm install && npx playwright install chromium && npm test
import { chromium } from 'playwright';
import { deflateRawSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const INDEX = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html')).href;

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
const jsErrors = [];
page.on('pageerror', e => jsErrors.push(e.message));
await page.goto(INDEX);

const results = [];
async function test(name, fn){
  try { await fn(); results.push(['ok  ', name]); }
  catch(e){ results.push(['FAIL', name + ' — ' + e.message]); }
}
const loadStl = async (txt, name) => page.evaluate(
  async ({txt, name}) => { await window.loadFile(new File([txt], name)); }, {txt, name});
const text = sel => page.textContent(sel);
const warnShown = () => page.$eval('#warn', el => el.classList.contains('show'));

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
  await loadStl(boxSTL(25,10,5), 'brick.stl');
  await page.click('#btnCalcBase');           // Kalkulationsbasis ist standardmäßig eingeklappt
  const setBed = async (x,y,z) => {
    for (const [id,v] of [['bx',x],['by',y],['bz',z]]) await page.fill('#'+id, String(v));
  };
  await setBed(12,30,50);                 // passt nur gedreht
  assert.equal(await warnShown(), false);
  await setBed(12,20,50);                 // passt auch gedreht nicht
  assert.match(await text('#warn'), /überschreitet/);
  await setBed(256,256,256);
});

await test('CSV-Import: 3 Aufträge, Duplikate und Leerzeilen gefiltert', async () => {
  await page.click('#btnOrders');           // Aufträge ist standardmäßig eingeklappt
  await page.click('#btnImport');
  await page.fill('#impText', CSV);
  await page.click('#impParse');
  await page.click('#impDo');
  assert.equal(await page.$$eval('.oitem', els => els.length), 3);
});

await test('Auftrag anklicken lädt Bestellnummer und Käufer', async () => {
  await page.locator('.oitem', { hasText: '88-00011-22233' }).click();
  assert.equal(await page.inputValue('#orderId'), '88-00011-22233');
  assert.equal(await page.inputValue('#buyer'), 'lisa_k');
});

await test('Status weiterschalten und filtern', async () => {
  await page.click('.oitem .stbadge');    // offen → gedruckt
  await page.click('.fchip[data-f="gedruckt"]');
  assert.equal(await page.$$eval('.oitem', els => els.length), 1);
  await page.click('.fchip[data-f="alle"]');
  assert.equal(await page.$$eval('.oitem', els => els.length), 3);
});

await test('Suche filtert die Liste', async () => {
  await page.fill('#oSearch', 'lisa');
  assert.equal(await page.$$eval('.oitem', els => els.length), 1);
  await page.fill('#oSearch', '');
  assert.equal(await page.$$eval('.oitem', els => els.length), 3);
});

await test('Sichern dedupliziert Geometrie über den Mesh-Speicher', async () => {
  // Der Auftragsklick oben hat das Modell korrekt geleert — für diesen Test frisch laden
  await loadStl(boxSTL(25,10,5), 'brick.stl');
  await page.click('#btnOrderSave');
  const r = await page.evaluate(() => {
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
  const before = await page.$$eval('.oitem', els => els.length);
  await page.click('.oitem [data-dup]');
  assert.equal(await page.$$eval('.oitem', els => els.length), before + 1);
  assert.equal(await page.inputValue('#orderId'), '');
  assert.equal(await page.inputValue('#buyer'), '');
});

await test('Backup-Restore übernimmt neue Aufträge, überspringt bekannte', async () => {
  const added = await page.evaluate(() => applyBackup({
    v:1, type:'druckauftrag-backup',
    orders:[{ id:'restore-test-1', saved:new Date().toISOString(), platform:'eBay',
              orderId:'T-1', buyer:'tester', priceText:'', status:'offen',
              snapshot:{v:2, fields:{orderId:'T-1'}} }],
    meshes:{}
  }));
  assert.equal(added, 1);
  const again = await page.evaluate(() => applyBackup({
    v:1, type:'druckauftrag-backup',
    orders:[{ id:'restore-test-1', snapshot:{v:2, fields:{}} }], meshes:{}
  }));
  assert.equal(again, 0);
});

await test('Farbwahl legt Material für die Kalkulation fest', async () => {
  const cMatBefore = await page.evaluate(() => calc().cMat);
  await page.locator('.sw[data-line="PETG-CF"]').first().click();
  assert.match(await text('#cHex'), /PETG-CF/);
  const cMatAfter = await page.evaluate(() => calc().cMat);
  assert.notEqual(cMatAfter, cMatBefore);
});

await test('Mail-Button baut mailto-Link mit Auftragsdetails an Jan selbst', async () => {
  const href = await page.evaluate(() => {
    const orig = document.createElement.bind(document);
    let captured = null;
    document.createElement = tag => {
      const el = orig(tag);
      if (tag === 'a') el.click = () => { captured = el.href; };
      return el;
    };
    document.getElementById('btnMail').click();
    document.createElement = orig;
    return captured;
  });
  assert.match(href, /^mailto:jan@luetje\.me\?subject=/);
  const decoded = decodeURIComponent(href);
  assert.match(decoded, /Materialbedarf/);
  assert.match(decoded, /Preis: /);
  assert.match(decoded, /\.stl.*anhängen/);
  assert.doesNotMatch(decoded, /Plattform:/);
  assert.doesNotMatch(decoded, /Bestellnummer:/);
  assert.doesNotMatch(decoded, /Käufer:/);
  assert.doesNotMatch(decoded, /Liefern bis:/);
});

await test('Mail-Button warnt ohne geladenes Modell', async () => {
  await page.click('#btnClear');
  await page.click('#btnMail');
  assert.match(await text('#warn'), /zuerst eine STL- oder 3MF-Datei laden/);
});

await test('v1-Stand lädt (Migration), neuere Version wird abgelehnt', async () => {
  const v1 = await page.evaluate(() => {
    window.applyState({ v:1, buyer:'altkunde', orderId:'V1-001', infill:'55', qty:'3' });
    return { buyer: document.getElementById('buyer').value,
             qty: document.getElementById('qty').value };
  });
  assert.equal(v1.buyer, 'altkunde');
  assert.equal(v1.qty, '3');
  const msg = await page.evaluate(() => {
    try { window.applyState({v:3}); return null; } catch(e){ return e.message; }
  });
  assert.match(msg, /neueren Version/);
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
