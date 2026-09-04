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
const os = require("os");
const { execFile } = require("child_process");
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
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL   = process.env.ANTHROPIC_MODEL   || "claude-opus-5";
// Jans Account gibt identity-linked Keys aus; die lehnt die API ohne Workspace-Angabe
// mit 400 ab. Bei einem normalen Key bleibt die Variable leer und der Header entfaellt.
const ANTHROPIC_WORKSPACE = process.env.ANTHROPIC_WORKSPACE_ID || "";
const MAX_BODY_AI       = 64 * 1024;   // Beschreibung + Palette, mehr braucht es nie
const AI_PER_IP_HOUR    = 10;
const AI_PER_DAY        = 200;
const AI_DESC_MAX       = 1000;
const SCAD_TIMEOUT_MS   = 20000;         // ein Pi 4 rendert einfache CSG in Sekunden
const SCAD_MAX_STL      = 20*1024*1024;  // groesser wird kein parametrisches Teil


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
  // Nur filename+content (base64) durchlassen. Ohne diese Prüfung könnte ein Anhang statt
  // "content" ein "path" mit beliebiger URL enthalten, die Resend serverseitig abruft (SSRF).
  const attachmentsOk = attachments.every(a =>
    a && typeof a === "object" &&
    typeof a.filename === "string" &&
    typeof a.content === "string" &&
    !("path" in a)
  );
  if (!attachmentsOk){
    res.writeHead(400, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:false, error:"attachments: nur filename (string) und content (base64-string) erlaubt."}));
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
    // Opus 5 denkt standardmäßig adaptiv mit; max_tokens deckelt Denken UND Antwort.
    // Großzügig bemessen, weil nur tatsächlich erzeugte Token abgerechnet werden — ein
    // knapper Wert schneidet dagegen die Antwort mitten im JSON ab.
    max_tokens: 8000,
    system: systemPrompt(palette),
    messages: [{ role: "user", content: description }],
    output_config: { format: { type: "json_schema", schema: buildSchema(palette) } }
  };
  // Haiku 4.5 lehnt output_config.effort mit 400 ab. Das Modell ist per Env-Var
  // umschaltbar, also darf das Feld nicht bedingungslos mitgehen.
  if (!/haiku/i.test(model)) body.output_config.effort = "low";
  return body;
}

async function callAnthropic(body){
  for (let attempt = 0; attempt < 2; attempt++){
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        ...(ANTHROPIC_WORKSPACE ? {"anthropic-workspace-id": ANTHROPIC_WORKSPACE} : {})
      },
      body: JSON.stringify(body)
    });
    if (r.ok) return r.json();
    // 429 = Rate-Limit, 529 = überlastet. Alles andere ist ein echter Fehler, den ein
    // zweiter Versuch nicht heilt.
    // Der Fehlertext geht ins Journal, nicht an den Kunden — sonst stuenden API-Interna
    // auf der oeffentlichen Seite. Ohne ihn ist jede 400 aber Ratespiel.
    if (r.status !== 429 && r.status !== 529){
      console.error("Anthropic-Fehler", r.status, await r.text().catch(() => ""));
      throw new Error("Anthropic antwortete mit HTTP " + r.status);
    }
    if (attempt === 0) await new Promise(res => setTimeout(res, 1000));
  }
  throw new Error("Anthropic ist gerade überlastet.");
}
/* ---------- Modell aus Beschreibung (OpenSCAD) ---------- */

function scadSchema(){
  return {
    type: "object",
    properties: {
      scad:   { type: "string" },
      name:   { type: "string" },
      reason: { type: "string" }
    },
    required: ["scad","name","reason"],
    additionalProperties: false
  };
}

function scadSystemPrompt(){
  return [
    "Du schreibst OpenSCAD-Skripte fuer eine kleine 3D-Druckerei.",
    "Der Kunde beschreibt ein Teil in Alltagssprache. Erzeuge daraus ein druckbares Modell.",
    "",
    "Regeln:",
    "- Beginne mit benannten Variablen fuer alle Masse, eine pro Zeile, mit Kommentar und Einheit in mm.",
    "  So kann der Drucker eine Zahl aendern, statt neu zu beschreiben.",
    "- Nenne fehlende Masse nicht als Frage, sondern waehle einen ueblichen Wert und schreib ihn",
    "  als Kommentar an die Variable, zum Beispiel // angenommen, bitte pruefen",
    "- Nur reines OpenSCAD: keine include-, use-, import- oder surface-Anweisungen, keine externen Dateien.",
    "- Halte es einfach: Quader, Zylinder, Kugeln, hull, minkowski, difference, union.",
    "  Keine Schleifen mit mehr als ein paar hundert Durchlaeufen.",
    "- $fn hoechstens 64, sonst dauert das Rendern zu lange.",
    "- Druckbar denken: keine hauchduennen Waende (mindestens 1.2 mm), flache Standflaeche.",
    "",
    "name: kurzer Dateiname ohne Endung, klein, mit Bindestrichen.",
    "reason: ein bis zwei Saetze auf Deutsch, was du gebaut und welche Masse du angenommen hast."
  ].join("\n");
}

function buildScadRequestBody(description, model = ANTHROPIC_MODEL){
  const body = {
    model,
    max_tokens: 8000,
    system: scadSystemPrompt(),
    messages: [{ role: "user", content: description }],
    output_config: { format: { type: "json_schema", schema: scadSchema() } }
  };
  if (!/haiku/i.test(model)) body.output_config.effort = "low";
  return body;
}

// Das Skript kommt vom Modell und wird auf dem Pi ausgefuehrt — also nur reine Geometrie
// durchlassen. OpenSCAD kann sonst ueber include/use/import/surface Dateien vom Server lesen.
const SCAD_VERBOTEN = /\b(include|use|import|surface|dxf_linear_extrude|dxf_rotate_extrude)\b|<[^>]*>/;

function sanitizeScad(code){
  if (typeof code !== "string" || !code.trim()) return "Das Modell hat kein Skript geliefert.";
  if (code.length > 20000) return "Das Skript ist unplausibel lang.";
  if (SCAD_VERBOTEN.test(code)) return "Das Skript enthaelt nicht erlaubte Anweisungen (Dateizugriff).";
  return null;
}

// Rendert in einem eigenen Temp-Verzeichnis mit hartem Zeitlimit. Ein Skript mit
// Endlosschleife wuerde sonst dauerhaft einen Kern belegen.
function renderScad(code){
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scad-"));
    const src = path.join(dir, "m.scad"), out = path.join(dir, "m.stl");
    const aufraeumen = () => { try { fs.rmSync(dir, {recursive:true, force:true}); } catch {} };
    fs.writeFileSync(src, code);
    execFile("openscad", ["-o", out, src], {timeout: SCAD_TIMEOUT_MS}, (err, stdout, stderr) => {
      if (err){
        aufraeumen();
        console.error("OpenSCAD-Fehler:", err.killed ? "Zeitlimit" : err.message, String(stderr).slice(0,500));
        reject(new Error(err.killed
          ? "Das Rendern hat zu lange gedauert. Bitte beschreib ein einfacheres Teil."
          : "OpenSCAD konnte das Skript nicht uebersetzen."));
        return;
      }
      let stl;
      try {
        const groesse = fs.statSync(out).size;
        if (groesse > SCAD_MAX_STL) throw new Error("Das erzeugte Modell ist zu gross.");
        if (groesse === 0) throw new Error("OpenSCAD hat eine leere Datei erzeugt.");
        stl = fs.readFileSync(out);
      } catch (e){ aufraeumen(); reject(e); return; }
      aufraeumen();
      resolve(stl);
    });
  });
}

async function handleScad(req, res){
  const limitError = rateLimitCheck(clientIp(req));
  if (limitError){
    res.writeHead(429, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:false, error:limitError}));
    return;
  }
  const body = await readBody(req, MAX_BODY_AI);
  let payload;
  try { payload = JSON.parse(body); }
  catch { res.writeHead(400); res.end("Ungueltiges JSON"); return; }

  // Zweiter Weg: fertiges Skript neu rendern, nachdem eine Zahl geaendert wurde.
  // Kein API-Aufruf, kostet nichts — deshalb ist das Bearbeiten der Masse der Normalfall
  // und nicht das erneute Beschreiben.
  if (typeof payload.scad === "string" && payload.scad.trim()){
    const schlecht = sanitizeScad(payload.scad);
    if (schlecht){
      res.writeHead(422, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ok:false, error:schlecht}));
      return;
    }
    try {
      const stl = await renderScad(payload.scad);
      res.writeHead(200, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ok:true,
        name:   String(payload.name || "modell").replace(/[^a-z0-9-]/gi, "").slice(0,60) || "modell",
        scad:   payload.scad,
        reason: "Aus dem bearbeiteten Skript gerendert.",
        stl:    stl.toString("base64")
      }));
    } catch (e){
      res.writeHead(502, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ok:false, error:"Das Rendern hat nicht geklappt: " + e.message}));
    }
    return;
  }

  const description = typeof payload.description === "string" ? payload.description.trim() : "";
  if (!description || description.length > AI_DESC_MAX){
    res.writeHead(400, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:false, error:`Beschreibung fehlt oder ist laenger als ${AI_DESC_MAX} Zeichen.`}));
    return;
  }
  if (!ANTHROPIC_API_KEY){
    res.writeHead(500, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:false, error:"ANTHROPIC_API_KEY ist auf dem Server nicht gesetzt."}));
    return;
  }

  try {
    const data = await callAnthropic(buildScadRequestBody(description));
    if (data.stop_reason === "refusal"){
      res.writeHead(422, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ok:false, error:"Zu dieser Beschreibung gibt es kein Modell. Bitte formuliere sie anders."}));
      return;
    }
    if (data.stop_reason === "max_tokens")
      throw new Error("Die Antwort wurde abgeschnitten. Bitte beschreib ein einfacheres Teil.");
    const block = (data.content || []).find(b => b.type === "text");
    if (!block) throw new Error("Antwort ohne Textblock.");
    const s = JSON.parse(block.text);

    const schlecht = sanitizeScad(s.scad);
    if (schlecht){
      res.writeHead(422, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ok:false, error:schlecht}));
      return;
    }

    const stl = await renderScad(s.scad);
    res.writeHead(200, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:true,
      name:   String(s.name || "modell").replace(/[^a-z0-9-]/gi, "").slice(0, 60) || "modell",
      scad:   s.scad,
      reason: String(s.reason || "").trim().slice(0, 500),
      stl:    stl.toString("base64")
    }));
  } catch (e){
    res.writeHead(502, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:false, error:"Das Modell hat nicht geklappt: " + e.message}));
  }
}

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
    // Bei max_tokens ist die Antwort mitten im JSON abgeschnitten. Ohne eigenen Zweig
    // scheitert erst JSON.parse und der Kunde bekäme eine Parser-Meldung zu lesen.
    if (data.stop_reason === "max_tokens")
      throw new Error("Die Antwort wurde abgeschnitten. Bitte beschreibe dein Vorhaben kürzer.");
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
}

const ROUTES = {
  "POST /backup":     handleBackup,
  "POST /send-mail":  handleSendMail,
  "GET /calcbase":    handleGetCalcbase,
  "POST /calcbase":   handlePostCalcbase,
  "POST /ai-suggest": handleAiSuggest,
  "POST /scad":       handleScad,
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

if (require.main === module){
  // Erst beim echten Start anlegen, nicht schon beim Import: tests/server.mjs bindet dieses
  // Modul nur ein, um die reinen Funktionen zu pruefen, und darf an /var/backups nicht
  // scheitern (in der CI gehoert das Verzeichnis dem Runner nicht).
  fs.mkdirSync(DIR, { recursive: true });
  server.listen(PORT, "127.0.0.1", () => {
    console.log("API-Server läuft auf 127.0.0.1:"+PORT+" (/backup, /send-mail, /calcbase, /ai-suggest), Ablage: "+DIR);
  });
}

// Für die Tests (tests/server.mjs) — beim Einbinden als Modul startet oben kein Listener.
module.exports = { clampInfill, clientIp, validPalette, rateLimitCheck, resetRateLimit,
                   buildSchema, systemPrompt, buildRequestBody,
                   scadSchema, scadSystemPrompt, buildScadRequestBody, sanitizeScad };
