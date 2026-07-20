#!/usr/bin/env node
"use strict";
// Minimaler Backup-Endpunkt für die Auftragsliste. Nimmt POST /backup mit der aktuellen
// Auftragsliste als JSON entgegen und schreibt sie lokal auf den Pi — die App selbst bleibt
// eine statische Datei, das hier ist ein separater, schlanker Node-Prozess ohne Abhängigkeiten
// (nur Node-Bordmittel), der über nginx unter /api/backup erreichbar gemacht wird.
//
// Läuft ausschließlich auf 127.0.0.1 — von außen nur über den nginx-Reverse-Proxy erreichbar.
// X-Backup-Secret ist kein echtes Geheimnis (steht im Client-Quelltext), sondern nur eine
// Hürde gegen zufälliges Abgreifen durch Bots, die die Domain sonst finden.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT   = process.env.BACKUP_PORT   || 8181;
const SECRET = process.env.BACKUP_SECRET || "";
const DIR    = process.env.BACKUP_DIR    || "/var/backups/druckauftrag";
const MAX_BODY = 25 * 1024 * 1024; // 25 MB genügt für eine Auftragsliste bei weitem

fs.mkdirSync(DIR, { recursive: true });

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/backup") {
    res.writeHead(404); res.end(); return;
  }
  if (SECRET && req.headers["x-backup-secret"] !== SECRET) {
    res.writeHead(403); res.end(); return;
  }

  let body = "", size = 0, tooBig = false;
  req.on("data", chunk => {
    size += chunk.length;
    if (size > MAX_BODY){ tooBig = true; req.destroy(); return; }
    body += chunk;
  });
  req.on("end", () => {
    if (tooBig){ res.writeHead(413); res.end(); return; }
    try { JSON.parse(body); }
    catch { res.writeHead(400); res.end("Ungültiges JSON"); return; }

    // "latest.json" ist immer der jüngste Stand, "backup-<Datum>.json" eine Kopie pro Tag
    // (mehrere Sicherungen am selben Tag überschreiben nur die Tageskopie, kein Datenverlust
    // innerhalb eines Tages relevant, da "latest.json" ohnehin den letzten Stand hält).
    fs.writeFileSync(path.join(DIR, "latest.json"), body);
    fs.writeFileSync(path.join(DIR, "backup-"+new Date().toISOString().slice(0,10)+".json"), body);

    res.writeHead(200, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:true, saved:new Date().toISOString()}));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Backup-Server läuft auf 127.0.0.1:"+PORT+", Ablage: "+DIR);
});
