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
const EUR_RATE          = +(process.env.ANTHROPIC_EUR_RATE || 0.92);   // USD -> EUR, grob
const CREDIT_WARN_EUR   = +(process.env.CREDIT_WARN_EUR || 1);         // Warnschwelle
// Preise in USD je 1 Mio Token (Stand 2026), grob nach Modellfamilie. Deckt Ein-/Ausgabe ab;
// Cache-Rabatte werden ignoriert — bei diesem Volumen unerheblich (leicht konservativ).
const PREISE_USD = {
  "haiku": { in: 1,  out: 5 },
  "sonnet":{ in: 2,  out: 10 },
  "opus":  { in: 5,  out: 25 },
  "fable": { in: 10, out: 50 },
};
const MODEL_PER_IP_HOUR = 5;             // Vorgabe: hoechstens 5 Modelle je Nutzer und Stunde
const MODEL_PER_DAY     = 100;           // globaler Deckel, der Pi rendert nicht unbegrenzt
const MAX_BODY_IMG      = 12*1024*1024;  // base64 blaeht ~1,33x auf
const IMG_MAX_BYTES     = 5*1024*1024;   // entpacktes Bild
const MAX_PARALLEL_SCAD = 2;             // 4 Kerne, aber der Pi macht noch anderes
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
// Zwei unabhaengige Zaehler mit verschiedenen Grenzen (Vorschlag vs. Modell aus Bild),
// deshalb eine kleine Fabrik statt zweier kopierter Bloecke.
function makeRateLimit(proIpStunde, proTag, tagesText){
  const hits = new Map();       // IP -> Zeitstempel[]
  let tagKey = "", tagZahl = 0;
  return {
    reset(){ hits.clear(); tagKey = ""; tagZahl = 0; },
    check(ip, now = Date.now()){
      const heute = new Date(now).toISOString().slice(0, 10);
      if (heute !== tagKey){ tagKey = heute; tagZahl = 0; }
      if (tagZahl >= proTag) return tagesText;

      const meine = (hits.get(ip) || []).filter(t => now - t < 60*60*1000);
      if (meine.length >= proIpStunde)
        return `Zu viele Anfragen von diesem Anschluss (${proIpStunde} pro Stunde). Bitte spaeter erneut versuchen.`;

      meine.push(now);
      hits.set(ip, meine);
      tagZahl++;
      // ponytail: einfacher Deckel gegen unbegrenztes Map-Wachstum. Reicht bei diesem
      // Anfragevolumen; bei echtem Dauerbetrieb waeren zeitgesteuerte Aufraeumlaeufe richtig.
      if (hits.size > 1000) hits.clear();
      return null;
    }
  };
}

const aiLimit = makeRateLimit(AI_PER_IP_HOUR, AI_PER_DAY,
  "Das Tageslimit für KI-Vorschläge ist erreicht. Bitte stell die Werte von Hand ein oder versuch es morgen erneut.");
const modelLimit = makeRateLimit(MODEL_PER_IP_HOUR, MODEL_PER_DAY,
  "Das Tageslimit für erzeugte Modelle ist erreicht. Bitte versuch es morgen erneut.");

function resetRateLimit(){ aiLimit.reset(); modelLimit.reset(); }
function rateLimitCheck(ip, now = Date.now()){ return aiLimit.check(ip, now); }
function modelLimitCheck(ip, now = Date.now()){ return modelLimit.check(ip, now); }

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

/* ---------- Guthaben mitzaehlen ---------- */
const CREDIT_FILE = path.join(DIR, "credit.json");

function preisFuer(model){
  const key = Object.keys(PREISE_USD).find(k => new RegExp(k, "i").test(model || ""));
  return PREISE_USD[key] || PREISE_USD.opus;   // Unbekannt -> teuerste Annahme, nie unterschaetzen
}

// Kosten dieser einen Antwort in Euro. Reine Funktion, testbar.
function kostenEur(usage, model, rate = EUR_RATE){
  if (!usage) return 0;
  const p = preisFuer(model);
  const ein  = (usage.input_tokens  || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  const aus  = usage.output_tokens || 0;
  const usd = ein/1e6 * p.in + aus/1e6 * p.out;
  return usd * rate;
}

function ladeCredit(){
  try { return JSON.parse(fs.readFileSync(CREDIT_FILE, "utf8")); }
  catch { return { start_eur: 0, spent_eur: 0 }; }
}

function bucheSpend(usage, model){
  // start_eur bleibt, spent_eur waechst. Bei fehlender Datei zaehlt ab 0 — die Warnung
  // greift dann erst, wenn Jan ein Startguthaben gesetzt hat.
  const c = ladeCredit();
  c.spent_eur = +( (c.spent_eur || 0) + kostenEur(usage, model) ).toFixed(6);
  try { fs.writeFileSync(CREDIT_FILE, JSON.stringify(c)); } catch(e){ console.error("credit.json:", e.message); }
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
    if (r.ok){
      const data = await r.json();
      try { bucheSpend(data.usage, body.model); } catch(e){ console.error("Spend-Buchung:", e.message); }
      return data;
    }
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
/* ---------- Bildpruefung ---------- */

// Nur Formate, die die Anthropic-Vision-API annimmt. Der media_type aus dem Request wird
// gegen die Magic Bytes geprueft — sonst koennte jemand beliebige Bytes als Bild deklarieren.
const IMG_MAGIC = {
  "image/jpeg": b => b[0]===0xFF && b[1]===0xD8 && b[2]===0xFF,
  "image/png":  b => b[0]===0x89 && b[1]===0x50 && b[2]===0x4E && b[3]===0x47,
  "image/gif":  b => b.slice(0,4).toString("latin1") === "GIF8",
  "image/webp": b => b.slice(0,4).toString("latin1") === "RIFF" && b.slice(8,12).toString("latin1") === "WEBP"
};

// Gibt einen Fehlertext zurueck oder null, wenn das Bild in Ordnung ist.
function pruefeBild(bild){
  if (!bild || typeof bild !== "object") return "Es fehlt ein Bild.";
  const { media_type, data } = bild;
  if (!IMG_MAGIC[media_type]) return "Dieses Bildformat wird nicht unterstuetzt. Bitte JPEG, PNG, GIF oder WebP.";
  if (typeof data !== "string" || !data) return "Das Bild ist leer.";
  let roh;
  try { roh = Buffer.from(data, "base64"); }
  catch { return "Das Bild liess sich nicht lesen."; }
  if (roh.length === 0) return "Das Bild ist leer.";
  if (roh.length > IMG_MAX_BYTES) return "Das Bild ist zu gross (hoechstens 5 MB).";
  if (!IMG_MAGIC[media_type](roh)) return "Das Bild passt nicht zum angegebenen Format.";
  return null;
}

/* ---------- Moderation ---------- */

function moderationSchema(){
  return {
    type: "object",
    properties: {
      erlaubt:   { type: "boolean" },
      kategorie: { type: "string", enum: ["ok","person","sexuell","gewalt","hass","beschreibung","sonstiges"] },
      hinweis:   { type: "string" }
    },
    required: ["erlaubt","kategorie","hinweis"],
    additionalProperties: false
  };
}

function moderationSystemPrompt(){
  return [
    "Du pruefst Uploads fuer eine 3D-Druckerei, bevor daraus ein Modell erzeugt wird.",
    "Der Kunde soll den Gegenstand fotografieren, den er gedruckt haben moechte.",
    "",
    "Liegt kein Bild vor, beurteile nur die Beschreibung; die Bildkriterien entfallen dann.",
    "",
    "Setze erlaubt=false, wenn eines davon zutrifft:",
    "- Auf dem Bild ist ein Mensch erkennbar — Gesicht oder Koerper, ganz oder teilweise,",
    "  Erwachsener oder Kind, auch im Hintergrund. Kategorie: person.",
    "  Statuen, Puppen, Zeichnungen und Spielfiguren sind keine Menschen.",
    "- Nacktheit oder sexueller Inhalt in Bild oder Text. Kategorie: sexuell.",
    "- Gewaltdarstellung, Verletzungen, Blut. Kategorie: gewalt.",
    "- Hass-Symbole oder verfassungsfeindliche Kennzeichen. Kategorie: hass.",
    "- Die Beschreibung ist beleidigend, diskriminierend oder sexuell. Kategorie: beschreibung.",
    "",
    "Sonst erlaubt=true und kategorie=ok.",
    "",
    "hinweis: ein freundlicher deutscher Satz an den Kunden, in der Du-Form wie der Rest",
    "der Seite. Bei Ablehnung sagen, was er",
    "aendern soll (zum Beispiel: nur den Gegenstand fotografieren, ohne Personen im Bild).",
    "Keine Vorwuerfe, keine Wiederholung des beanstandeten Inhalts. Bei erlaubt=true ein",
    "kurzer Satz, was auf dem Bild zu sehen ist."
  ].join("\n");
}

// Der Ablehnungstext kommt aus dem Code, nicht vom Modell: Haiku formuliert sonst "lade ein
// anderes Foto hoch", auch wenn gar keines dabei war. Die Kategorie liefert es zuverlaessig,
// die Formulierung nicht — also hier festlegen.
function ablehnText(kategorie, mitBild){
  switch (kategorie){
    case "person":
      return "Auf dem Bild ist eine Person zu erkennen. Bitte fotografiere nur den Gegenstand, den du gedruckt haben moechtest.";
    case "sexuell":
    case "gewalt":
    case "hass":
      return mitBild
        ? "Das laesst sich so leider nicht umsetzen. Bitte waehl ein anderes Bild und beschreib einen anderen Gegenstand."
        : "Das laesst sich so leider nicht umsetzen. Bitte beschreib einen anderen Gegenstand.";
    case "beschreibung":
      return "Deine Beschreibung laesst sich so nicht umsetzen. Bitte formuliere sie anders.";
    default:
      return mitBild
        ? "Dieser Upload laesst sich nicht verarbeiten. Bitte fotografiere nur den Gegenstand, den du gedruckt haben moechtest."
        : "Das laesst sich so nicht umsetzen. Bitte beschreib den Gegenstand anders.";
  }
}

function bildBlock(bild){
  return { type: "image", source: { type: "base64", media_type: bild.media_type, data: bild.data } };
}

function buildModerationBody(description, bild = null, model = ANTHROPIC_MODEL){
  const body = {
    model,
    max_tokens: 2000,
    system: moderationSystemPrompt(),
    // Bild vor Text, wie von der API empfohlen. Ohne Bild wird nur der Text beurteilt.
    messages: [{ role: "user",
      content: bild ? [bildBlock(bild), { type: "text", text: description }] : description }],
    output_config: { format: { type: "json_schema", schema: moderationSchema() } }
  };
  if (!/haiku/i.test(model)) body.output_config.effort = "low";
  return body;
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

function buildScadRequestBody(description, model = ANTHROPIC_MODEL, bild = null){
  const body = {
    model,
    max_tokens: 8000,
    system: scadSystemPrompt() + (bild
      ? "\n\nDu siehst zusaetzlich ein Foto des gewuenschten Teils. Nutze es, um Form und\n" +
        "Aufbau zu verstehen. Masse liefert ein Foto nicht — nimm die aus dem Text, und wo\n" +
        "sie fehlen, waehle uebliche Werte und markiere sie als angenommen."
      : ""),
    messages: [{ role: "user",
      content: bild ? [bildBlock(bild), { type: "text", text: description }] : description }],
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
// Ein oeffentlich erreichbarer Renderer auf einem Pi 4: mehr als zwei gleichzeitige
// Laeufe will die Kiste nicht, auch wenn das Rate-Limit pro IP greift.
let laufendeRenders = 0;

function renderScad(code){
  return new Promise((resolve, reject) => {
    if (laufendeRenders >= MAX_PARALLEL_SCAD){
      reject(new Error("Gerade sind zu viele Modelle in Arbeit. Bitte in einer Minute erneut versuchen."));
      return;
    }
    laufendeRenders++;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scad-"));
    const src = path.join(dir, "m.scad"), out = path.join(dir, "m.stl");
    const aufraeumen = () => { laufendeRenders--; try { fs.rmSync(dir, {recursive:true, force:true}); } catch {} };
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

// Oeffentlich erreichbar: Kunde laedt ein Foto hoch und beschreibt, was er gedruckt haben
// moechte. Das Bild wird NIRGENDS gespeichert — weder auf Platte noch im Backup. Es lebt nur
// in dieser Anfrage und geht an die Moderation und die Modellerzeugung.
async function handleModel(req, res){
  const limitError = modelLimitCheck(clientIp(req));
  if (limitError){
    res.writeHead(429, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:false, error:limitError}));
    return;
  }

  const body = await readBody(req, MAX_BODY_IMG);
  let payload;
  try { payload = JSON.parse(body); }
  catch { res.writeHead(400); res.end("Ungueltiges JSON"); return; }

  const description = typeof payload.description === "string" ? payload.description.trim() : "";
  if (!description || description.length > AI_DESC_MAX){
    res.writeHead(400, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:false, error:`Bitte beschreib in ein bis zwei Saetzen, was gedruckt werden soll (hoechstens ${AI_DESC_MAX} Zeichen).`}));
    return;
  }
  // Das Bild ist optional: ohne eines wird allein aus der Beschreibung erzeugt.
  const bild = payload.image ? payload.image : null;
  if (bild){
    const bildFehler = pruefeBild(bild);
    if (bildFehler){
      res.writeHead(400, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ok:false, error:bildFehler}));
      return;
    }
  }
  if (!ANTHROPIC_API_KEY){
    res.writeHead(500, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:false, error:"ANTHROPIC_API_KEY ist auf dem Server nicht gesetzt."}));
    return;
  }

  // Schritt 1: Moderation. Faellt sie aus, wird abgelehnt — ein Sicherheitsgatter, das bei
  // eigenem Fehler durchwinkt, ist keines.
  let pruefung;
  try {
    const data = await callAnthropic(buildModerationBody(description, bild));
    if (data.stop_reason === "refusal"){
      res.writeHead(422, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ok:false, kategorie:"sonstiges", error:ablehnText("sonstiges", !!bild)}));
      return;
    }
    const block = (data.content || []).find(b => b.type === "text");
    pruefung = JSON.parse(block.text);
  } catch (e){
    console.error("Moderation fehlgeschlagen:", e.message);
    res.writeHead(502, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:false, error:"Die Pruefung des Bildes hat nicht geklappt. Bitte versuch es spaeter erneut."}));
    return;
  }

  if (!pruefung.erlaubt){
    console.error("Upload abgelehnt, Kategorie:", pruefung.kategorie);
    res.writeHead(422, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:false, kategorie:pruefung.kategorie,
      error:ablehnText(pruefung.kategorie, !!bild)}));
    return;
  }

  // Schritt 2: erst jetzt das Modell.
  try {
    const data = await callAnthropic(buildScadRequestBody(description, ANTHROPIC_MODEL, bild));
    if (data.stop_reason === "refusal"){
      res.writeHead(422, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ok:false, error:"Dazu laesst sich kein Modell erzeugen. Bitte beschreib es anders."}));
      return;
    }
    if (data.stop_reason === "max_tokens")
      throw new Error("Die Antwort wurde abgeschnitten. Bitte beschreib ein einfacheres Teil.");
    const block = (data.content || []).find(b => b.type === "text");
    if (!block) throw new Error("Antwort ohne Textblock.");
    const sug = JSON.parse(block.text);

    const schlecht = sanitizeScad(sug.scad);
    if (schlecht){
      res.writeHead(422, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ok:false, error:schlecht}));
      return;
    }

    const stl = await renderScad(sug.scad);
    res.writeHead(200, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:true,
      name:    String(sug.name || "modell").replace(/[^a-z0-9-]/gi, "").slice(0,60) || "modell",
      scad:    sug.scad,
      reason:  String(sug.reason || "").trim().slice(0,500),
      hinweis: String(pruefung.hinweis || "").trim().slice(0,300),
      stl:     stl.toString("base64")
    }));
  } catch (e){
    res.writeHead(502, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:false, error:"Das Modell hat nicht geklappt: " + e.message}));
  }
}

// Kuma fragt diesen Endpunkt ab: 200 solange Restguthaben >= Schwelle, sonst 402 -> Kuma
// meldet "down" und schickt die uebliche Benachrichtigung. Auch per Browser lesbar.
async function handleCredit(req, res){
  const c = ladeCredit();
  const rest = +( (c.start_eur || 0) - (c.spent_eur || 0) ).toFixed(4);
  const ok = rest >= CREDIT_WARN_EUR;
  res.writeHead(ok ? 200 : 402, {"Content-Type":"application/json"});
  res.end(JSON.stringify({
    ok, rest_eur: rest, start_eur: c.start_eur || 0, spent_eur: c.spent_eur || 0,
    schwelle_eur: CREDIT_WARN_EUR,
    hinweis: ok ? "Guthaben ok" : "Guthaben unter " + CREDIT_WARN_EUR + " EUR — bitte aufladen und Startguthaben neu setzen."
  }));
}

// Startguthaben nach dem Aufladen setzen (spent wird auf 0 zurueckgesetzt).
async function handleSetCredit(req, res){
  const body = await readBody(req, 1024);
  let d; try { d = JSON.parse(body); } catch { res.writeHead(400); res.end("Ungueltiges JSON"); return; }
  const start = Number(d.start_eur);
  if (!Number.isFinite(start) || start < 0){ res.writeHead(400); res.end("start_eur fehlt/ungueltig"); return; }
  fs.writeFileSync(CREDIT_FILE, JSON.stringify({ start_eur: +start.toFixed(4), spent_eur: 0 }));
  res.writeHead(200, {"Content-Type":"application/json"});
  res.end(JSON.stringify({ ok:true, start_eur: +start.toFixed(4), spent_eur: 0 }));
}

const ROUTES = {
  "POST /backup":     handleBackup,
  "POST /send-mail":  handleSendMail,
  "GET /calcbase":    handleGetCalcbase,
  "POST /calcbase":   handlePostCalcbase,
  "POST /scad":       handleScad,
  "POST /model":      handleModel,
  "GET /credit":      handleCredit,
  "POST /credit":     handleSetCredit,
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
    console.log("API-Server läuft auf 127.0.0.1:"+PORT+" (/backup, /send-mail, /calcbase, /scad, /model), Ablage: "+DIR);
  });
}

// Für die Tests (tests/server.mjs) — beim Einbinden als Modul startet oben kein Listener.
module.exports = { clampInfill, clientIp, validPalette, rateLimitCheck, resetRateLimit,
                   buildSchema, systemPrompt, buildRequestBody,
                   scadSchema, scadSystemPrompt, buildScadRequestBody, sanitizeScad,
                   pruefeBild, moderationSchema, moderationSystemPrompt, buildModerationBody,
                   modelLimitCheck, ablehnText, kostenEur, preisFuer };
