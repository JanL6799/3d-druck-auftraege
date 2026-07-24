#!/usr/bin/env node
"use strict";
// Kleiner Node-Dienst ohne Abhängigkeiten (nur Node-Bordmittel, inkl. dem seit Node 18
// eingebauten fetch), der Dinge für die App erledigt, die eine rein statische Seite
// technisch nicht selbst kann:
//   POST /backup     — aktuelle Auftragsliste lokal auf dem Pi sichern
//   POST /send-mail  — Auftrags-Mail inkl. echtem Dateianhang über die Resend-API verschicken
//   GET  /calcbase   — aktuelle Kalkulationsbasis auslesen
//   POST /calcbase   — Kalkulationsbasis aktualisieren
// Läuft ausschließlich auf 127.0.0.1 — von außen nur über den nginx-Reverse-Proxy erreichbar.
// /calcbase existiert, weil index.html (öffentlich, drucken.luetje.me) und backend.html
// (nur im Heimnetz, eigener Port, siehe deploy/setup-backend-lokal.sh) unterschiedliche
// Origins sind und sich deshalb keinen localStorage mehr teilen können — dieser kleine
// Dateispeicher auf dem Pi übernimmt die Rolle, die vorher der gemeinsame localStorage hatte.
// X-Backup-Secret ist kein echtes Geheimnis (steht im Client-Quelltext), sondern nur eine
// Hürde gegen zufälliges Abgreifen durch Bots, die die Domain sonst finden.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT            = process.env.BACKUP_PORT    || 8181;
const SECRET          = process.env.BACKUP_SECRET  || "";
const DIR             = process.env.BACKUP_DIR     || "/var/backups/druckauftrag";
const RESEND_API_KEY  = process.env.RESEND_API_KEY || "";
const N8N_ORDER_HOOK  = process.env.N8N_ORDER_HOOK || ""; // n8n-Webhook für neue-Bestellung-Push, leer = aus
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

  const { subject, text, attachments, replyTo } = payload;
  if (!subject || !text || !Array.isArray(attachments)){
    res.writeHead(400, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:false, error:"subject, text und attachments sind Pflichtfelder."}));
    return;
  }

  // reply_to trägt die Kunden-Adresse, damit eine normale Antwort im Mailprogramm direkt an
  // den Kunden geht statt an die Absenderadresse (Resend-Testdomain). Client validiert das
  // Format schon, hier trotzdem serverseitig geprüft statt ungeprüft an Resend durchgereicht.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const mailPayload = { from: MAIL_FROM, to:[MAIL_TO], subject, text, attachments };
  if (typeof replyTo === "string" && EMAIL_RE.test(replyTo)) mailPayload.reply_to = replyTo;

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization":"Bearer "+RESEND_API_KEY, "Content-Type":"application/json" },
      body: JSON.stringify(mailPayload)
    });
    const data = await r.json();
    if (!r.ok){
      res.writeHead(502, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ok:false, error: data.message || "Resend hat die Mail abgelehnt."}));
      return;
    }
    // Fire-and-forget: n8n über die neue Bestellung informieren. Fehler hier dürfen den
    // erfolgreichen Mailversand nie umwerfen, daher .catch(()=>{}) und kein await.
    if (N8N_ORDER_HOOK){
      fetch(N8N_ORDER_HOOK, {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({ subject, text, replyTo: replyTo || "" })
      }).catch(()=>{});
    }
    res.writeHead(200, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:true, id:data.id}));
  } catch (e){
    res.writeHead(502, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:false, error:"Resend war nicht erreichbar: "+e.message}));
  }
}

const CALCBASE_FILE = path.join(DIR, "calcbase.json");

async function handleGetCalcbase(req, res){
  let data = {};
  try { data = JSON.parse(fs.readFileSync(CALCBASE_FILE, "utf8")); } catch (e) { /* noch nie gespeichert */ }
  res.writeHead(200, {"Content-Type":"application/json"});
  res.end(JSON.stringify(data));
}
async function handlePostCalcbase(req, res){
  const body = await readBody(req, 4096); // winzige Zahlenliste, 4 KB reichen dick
  let data;
  try { data = JSON.parse(body); }
  catch { res.writeHead(400); res.end("Ungültiges JSON"); return; }
  fs.writeFileSync(CALCBASE_FILE, JSON.stringify(data));
  res.writeHead(200, {"Content-Type":"application/json"});
  res.end(JSON.stringify({ok:true}));
}

const ROUTES = {
  "POST /backup":     handleBackup,
  "POST /send-mail":  handleSendMail,
  "GET /calcbase":    handleGetCalcbase,
  "POST /calcbase":   handlePostCalcbase,
};

const server = http.createServer((req, res) => {
  const handler = ROUTES[req.method + " " + req.url];
  if (!handler){ res.writeHead(404); res.end(); return; }
  if (SECRET && req.headers["x-backup-secret"] !== SECRET){
    res.writeHead(403); res.end(); return;
  }

  handler(req, res).catch(e => {
    res.writeHead(e.code === 413 ? 413 : 500); res.end();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("API-Server läuft auf 127.0.0.1:"+PORT+" (/backup, /send-mail, /calcbase), Ablage: "+DIR);
});
