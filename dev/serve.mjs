// Nur für die lokale Ansicht: liefert index.html aus und reicht /api/* an den
// API-Dienst auf 127.0.0.1:8181 weiter — dieselbe Origin, wie nginx es in Produktion macht.
// Wird NICHT deployed. Start: npm run dev
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Auf dem Pi haelt der produktive Dienst druckauftrag-backup bereits 8181. Ohne eigenen
// Port wuerde der Proxy still gegen Produktion laufen: DEV_API=http://127.0.0.1:8182 setzen.
const API  = process.env.DEV_API || 'http://127.0.0.1:8181';
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
