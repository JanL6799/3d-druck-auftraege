#!/usr/bin/env bash
# Richtet den KI-Vorschlag auf dem Pi ein: ANTHROPIC_API_KEY in die systemd-Unit,
# nginx-Route /api/ai-suggest auf den Dienst, Webroot-Kopie von index.html.
#
# Ausführen mit: sudo bash deploy/setup-ki-vorschlag.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Bitte mit sudo ausführen: sudo bash deploy/setup-ki-vorschlag.sh" >&2
  exit 1
fi

REPO=/home/jan/3d-druck-auftraege
UNIT=/etc/systemd/system/druckauftrag-backup.service
SITE=/etc/nginx/sites-available/drucken.luetje.me
WEBROOT=/var/www/drucken.luetje.me
SITE_LOKAL=/etc/nginx/sites-available/backend-lokal
WEBROOT_LOKAL=/var/www/backend.druckauftrag

read -rsp "Anthropic-API-Key (console.anthropic.com): " ANTHROPIC_API_KEY; echo
[ -n "$ANTHROPIC_API_KEY" ] || { echo "Kein Key eingegeben, Abbruch." >&2; exit 1; }

read -rp "Modell [claude-opus-5]: " ANTHROPIC_MODEL
ANTHROPIC_MODEL=${ANTHROPIC_MODEL:-claude-opus-5}

echo "== 1/4: Key in die systemd-Unit =="
# Bestehende Environment-Zeilen behalten, ANTHROPIC_* ersetzen bzw. ergänzen.
sed -i '/^Environment=ANTHROPIC_/d' "$UNIT"
sed -i "/^ExecStart=/a Environment=ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY\nEnvironment=ANTHROPIC_MODEL=$ANTHROPIC_MODEL" "$UNIT"
chmod 600 "$UNIT"

echo "== 2/4: nginx-Routen =="
# Beide Sites brauchen die Route: die oeffentliche fuer Kunden, die Heimnetz-Site
# (Port 8080) damit Jan im Backend testen kann, ohne die Kundenseite anzufassen.
for site in "$SITE" "$SITE_LOKAL"; do
  [ -f "$site" ] || { echo "   $site fehlt, uebersprungen."; continue; }
  if grep -q '/api/ai-suggest' "$site"; then
    echo "   $(basename "$site"): Route existiert schon, uebersprungen."
  else
    sed -i '/location \/api\/send-mail/i\    location = /api/ai-suggest {\n        proxy_pass http://127.0.0.1:8181/ai-suggest;\n    }\n' "$site"
    echo "   $(basename "$site"): Route ergaenzt."
  fi
done
nginx -t

echo "== 3/4: Seiten in die Webroots =="
cp "$REPO/index.html" "$WEBROOT/index.html"
[ -d "$WEBROOT_LOKAL" ] && cp "$REPO/backend.html" "$WEBROOT_LOKAL/backend.html"

echo "== 4/4: Dienste neu laden =="
systemctl daemon-reload
systemctl restart druckauftrag-backup
systemctl reload nginx

echo
echo "Fertig. Kurztest:"
echo "  curl -s -X POST https://drucken.luetje.me/api/ai-suggest -H 'content-type: application/json' \\"
echo "    -d '{\"description\":\"Test\",\"palette\":[{\"line\":\"PLA Basic\",\"colors\":[\"Black\"]}]}'"
