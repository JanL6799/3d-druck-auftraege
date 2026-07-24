#!/usr/bin/env bash
# Einmaliges Pi-Setup für den Resend-Mailversand (PR #16, "Mail-Versand auf echten
# Anhang umstellen"). Holt drei liegen gebliebene Schritte nach:
#   1. index.html im Webroot ist noch der alte mailto:-Stand -> neu kopieren.
#   2. systemd-Unit zeigt noch auf das umbenannte server/backup-server.js -> auf
#      server/api-server.js umstellen und RESEND_API_KEY ergänzen.
#   3. nginx kennt nur /api/backup, nicht die neue Route /api/send-mail.
#
# Ausführen mit: sudo bash deploy-mail-feature.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Bitte mit sudo ausführen: sudo bash deploy-mail-feature.sh" >&2
  exit 1
fi

REPO=/home/jan/3d-druck-auftraege
UNIT=/etc/systemd/system/druckauftrag-backup.service
NGINX_SITE=/etc/nginx/sites-available/drucken.luetje.me
WEBROOT=/var/www/drucken.luetje.me

echo "== 1/4: index.html in den Webroot kopieren =="
cp "$REPO/index.html" "$WEBROOT/index.html"
echo "OK"

echo
echo "== 2/4: systemd-Unit auf server/api-server.js umstellen =="
if [ -z "${RESEND_API_KEY:-}" ]; then
  read -rsp "Resend API-Key eingeben (Eingabe bleibt unsichtbar): " RESEND_API_KEY
  echo
fi
if [ -z "$RESEND_API_KEY" ]; then
  echo "Kein API-Key eingegeben, breche ab." >&2
  exit 1
fi

# BACKUP_SECRET/BACKUP_DIR aus der laufenden Unit übernehmen statt neu zu erzeugen —
# der Secret-Wert steckt schon im ausgelieferten index.html und muss identisch bleiben.
CURRENT_SECRET=$(grep -oP '(?<=Environment=BACKUP_SECRET=).*' "$UNIT")
CURRENT_DIR=$(grep -oP '(?<=Environment=BACKUP_DIR=).*' "$UNIT")

cat > "$UNIT" <<EOF
[Unit]
Description=API-Server für die 3D-Druck-Auftragserfassung (Backup + Mail-Versand)
After=network.target

[Service]
ExecStart=/usr/bin/node $REPO/server/api-server.js
Environment=BACKUP_SECRET=$CURRENT_SECRET
Environment=BACKUP_DIR=$CURRENT_DIR
Environment=RESEND_API_KEY=$RESEND_API_KEY
Environment=MAIL_TO=jan@luetje.me
Environment=N8N_ORDER_HOOK=http://127.0.0.1:5678/webhook/new-order
Restart=on-failure
User=jan

[Install]
WantedBy=multi-user.target
EOF
echo "OK (BACKUP_SECRET/BACKUP_DIR unverändert übernommen)"

echo
echo "== 3/4: nginx-Route /api/send-mail ergänzen =="
if grep -q "location /api/send-mail" "$NGINX_SITE"; then
  echo "Route existiert schon, überspringe."
else
  python3 - "$NGINX_SITE" <<'PYEOF'
import sys
path = sys.argv[1]
with open(path) as f:
    content = f.read()
block = (
    "    location /api/send-mail {\n"
    "        proxy_pass http://127.0.0.1:8181/send-mail;\n"
    "        client_max_body_size 35m;\n"
    "    }\n\n"
)
marker = "    location / {"
assert marker in content, "location / nicht gefunden - Datei manuell pruefen"
content = content.replace(marker, block + marker, 1)
with open(path, "w") as f:
    f.write(content)
PYEOF
  echo "OK"
fi

echo
echo "== 4/4: Dienste neu laden =="
nginx -t
systemctl daemon-reload
systemctl restart druckauftrag-backup
systemctl reload nginx
echo "OK"

echo
echo "== Status =="
systemctl status druckauftrag-backup --no-pager -l | head -8

echo
echo "== Verifikation: POST /api/send-mail (leerer Body, erwartet 'Pflichtfelder'-Fehler) =="
curl -s -X POST \
  -H "Host: drucken.luetje.me" \
  -H "Content-Type: application/json" \
  -H "X-Backup-Secret: $CURRENT_SECRET" \
  -d '{}' \
  http://127.0.0.1/api/send-mail
echo
echo
echo "Fertig. Ein echter Sendetest lässt sich am einfachsten über die App selbst machen"
echo "(Auftrag mit Modell laden -> Per Mail senden)."
