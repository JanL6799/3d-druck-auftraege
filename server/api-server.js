#!/usr/bin/env node
"use strict";
// Kleiner Node-Dienst ohne Abhängigkeiten (nur Node-Bordmittel, inkl. dem seit Node 18
// eingebauten fetch), der zwei Dinge für die App erledigt, die eine rein statische Seite
// technisch nicht selbst kann:
//   POST /backup     — aktuelle Auftragsliste lokal auf dem Pi sichern
//   POST /send-mail  — Auftrags-Mail inkl. echtem Dateianhang über die Resend-API verschicken
// Läuft ausschließlich auf 127.0.0.1 — von außen nur über den nginx-Reverse-Proxy erreichbar.
// X-Backup-Secret ist kein echtes Geheimnis (steht im Client-Quelltext), sondern nur eine
// Hürde gegen zufälliges Abgreifen durch Bots, die die Domain sonst finden.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT            = process.env.BACKUP_PORT    || 8181;
const SECRET          = process.env.BACKUP_SECRET  || "";
const DIR             = process.env.BACKUP_DIR     || "/var/backups/druckauftrag";
const RESEND_API_KEY  = process.env.RESEND_API_KEY || "";
const MAIL_FROM       = process.env.MAIL_FROM      || "3D-Druck Auftragserfassung <onboarding@resend.dev>";
const MAIL_TO         = process.env.MAIL_TO        || "jan@luetje.me";
const MAX_BODY_BACKUP = 25 * 1024 * 1024; // 25 MB genügt für eine Auftragsliste bei weitem
const MAX_BODY_MAIL   = 35 * 1024 * 1024; // Modell als STL kommt base64-kodiert mit (~1,33x)

fs.mkdirSync(DIR, { recursive: true });

function readBody(req, maxBody){
  return new Promise((resolve, reject) => {
    let body = "", size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > maxBody){ reject(Object.assign(new Error("zu groß"), {code:413})); req.destroy(); return; }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function handleBackup(req, res){
  const body = await readBody(req, MAX_BODY_BACKUP);
  try { JSON.parse(body); }
  catch { res.writeHead(400); res.end("Ungültiges JSON"); return; }

  // "latest.json" ist immer der jüngste Stand, "backup-<Datum>.json" eine Kopie pro Tag
  // (mehrere Sicherungen am selben Tag überschreiben nur die Tageskopie, kein Datenverlust
  // innerhalb eines Tages relevant, da "latest.json" ohnehin den letzten Stand hält).
  fs.writeFileSync(path.join(DIR, "latest.json"), body);
  fs.writeFileSync(path.join(DIR, "backup-"+new Date().toISOString().slice(0,10)+".json"), body);

  res.writeHead(200, {"Content-Type":"application/json"});
  res.end(JSON.stringify({ok:true, saved:new Date().toISOString()}));
}

async function handleSendMail(req, res){
  if (!RESEND_API_KEY){
    res.writeHead(500, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:false, error:"RESEND_API_KEY ist auf dem Server nicht gesetzt."}));
    return;
  }
  const body = await readBody(req, MAX_BODY_MAIL);
  let payload;
  try { payload = JSON.parse(body); }
  catch { res.writeHead(400); res.end("Ungültiges JSON"); return; }

  const { subject, text, attachments } = payload;
  if (!subject || !text || !Array.isArray(attachments)){
    res.writeHead(400, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:false, error:"subject, text und attachments sind Pflichtfelder."}));
    return;
  }

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization":"Bearer "+RESEND_API_KEY, "Content-Type":"application/json" },
      body: JSON.stringify({ from: MAIL_FROM, to:[MAIL_TO], subject, text, attachments })
    });
    const data = await r.json();
    if (!r.ok){
      res.writeHead(502, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ok:false, error: data.message || "Resend hat die Mail abgelehnt."}));
      return;
    }
    res.writeHead(200, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:true, id:data.id}));
  } catch (e){
    res.writeHead(502, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:false, error:"Resend war nicht erreichbar: "+e.message}));
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || (req.url !== "/backup" && req.url !== "/send-mail")){
    res.writeHead(404); res.end(); return;
  }
  if (SECRET && req.headers["x-backup-secret"] !== SECRET){
    res.writeHead(403); res.end(); return;
  }

  const handler = req.url === "/backup" ? handleBackup : handleSendMail;
  handler(req, res).catch(e => {
    res.writeHead(e.code === 413 ? 413 : 500); res.end();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("API-Server läuft auf 127.0.0.1:"+PORT+" (/backup, /send-mail), Ablage: "+DIR);
});
