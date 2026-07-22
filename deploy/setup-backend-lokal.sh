#!/usr/bin/env bash
# Sperrt backend.html von der öffentlichen Domain weg und macht es stattdessen nur im
# Heimnetz erreichbar — auf Port 8080, der NICHT im Cloudflare-Tunnel konfiguriert ist
# (/etc/cloudflared/config.yml kennt nur drucken.luetje.me und eauto.luetje.me auf Port 80).
# Der Zweitanschluss/Starlink-CGNAT blockt eingehende WAN-Verbindungen ohnehin schon (siehe
# NOTIZEN.md "Deployment") — ein nicht getunnelter Port ist damit von außen unerreichbar,
# ganz ohne dass nginx selbst Internet-Traffic filtern müsste. Die allow/deny-Regeln unten
# sind zusätzliche Absicherung, falls sich daran mal etwas ändert.
#
# WICHTIG VOR DEM AUSFÜHREN: backend.html wechselt dabei die Origin (neuer Port = neue
# Origin = neuer, leerer localStorage). Die bisherige Auftragsliste unter
# https://drucken.luetje.me/backend.html geht NICHT automatisch mit um. Vorher im Browser:
#   1. https://drucken.luetje.me/backend.html öffnen, "Backup exportieren" klicken.
#   2. Nach diesem Skript: neue Adresse öffnen (wird am Ende ausgegeben), "Backup laden"
#      mit der eben exportierten Datei.
#
# Ausführen mit: sudo bash deploy/setup-backend-lokal.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Bitte mit sudo ausführen: sudo bash deploy/setup-backend-lokal.sh" >&2
  exit 1
fi

REPO=/home/jan/3d-druck-auftraege
WEBROOT=/var/www/backend.druckauftrag
PUBLIC_WEBROOT=/var/www/drucken.luetje.me
PUBLIC_SITE=/etc/nginx/sites-available/drucken.luetje.me
NGINX_SITE=/etc/nginx/sites-available/backend-lokal
PORT=8080

read -rp "Auftragsliste vorher per 'Backup exportieren' gesichert (siehe Kommentar im Skript)? [j/N] " CONFIRM
if [[ ! "$CONFIRM" =~ ^[jJ]$ ]]; then
  echo "Abgebrochen — erst sichern, dann nochmal ausführen." >&2
  exit 1
fi

echo "== 1/5: Webroot für backend.html anlegen (getrennt von der öffentlichen Domain) =="
mkdir -p "$WEBROOT"
cp "$REPO/backend.html" "$WEBROOT/backend.html"
cp "$REPO/impressum.html" "$WEBROOT/impressum.html"
chown -R www-data:www-data "$WEBROOT"
echo "OK"

echo
echo "== 2/5: backend.html aus dem öffentlichen Webroot entfernen, falls dort vorhanden =="
if [ -f "$PUBLIC_WEBROOT/backend.html" ]; then
  rm -f "$PUBLIC_WEBROOT/backend.html"
  echo "Entfernt: $PUBLIC_WEBROOT/backend.html"
else
  echo "War dort nicht vorhanden, nichts zu tun."
fi

echo
echo "== 3/5: /api/calcbase auf der öffentlichen Domain ergänzen (falls noch nicht vorhanden) =="
if grep -q "location /api/calcbase" "$PUBLIC_SITE"; then
  echo "Route existiert schon, überspringe."
else
  python3 - "$PUBLIC_SITE" <<'PYEOF'
import sys
path = sys.argv[1]
with open(path) as f:
    content = f.read()
block = (
    "    location /api/calcbase {\n"
    "        proxy_pass http://127.0.0.1:8181/calcbase;\n"
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
echo "== 4/5: nginx-Site nur fürs Heimnetz anlegen (Port $PORT) =="
cat > "$NGINX_SITE" <<EOF
server {
    listen $PORT;
    listen [::]:$PORT;
    server_name _;

    root $WEBROOT;
    index backend.html;

    # Zusätzlich zum nicht getunnelten Port: nur private Adressbereiche + localhost.
    allow 127.0.0.1;
    allow ::1;
    allow 192.168.0.0/16;
    allow 10.0.0.0/8;
    allow 172.16.0.0/12;
    deny all;

    location /api/backup {
        proxy_pass http://127.0.0.1:8181/backup;
        client_max_body_size 25m;
    }

    location /api/send-mail {
        proxy_pass http://127.0.0.1:8181/send-mail;
        client_max_body_size 35m;
    }

    location /api/calcbase {
        proxy_pass http://127.0.0.1:8181/calcbase;
    }

    location / {
        try_files \$uri \$uri/ =404;
    }
}
EOF
ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/backend-lokal
echo "OK"

echo
echo "== 5/5: nginx neu laden =="
nginx -t
systemctl reload nginx
echo "OK"

LAN_IP=$(hostname -I | awk '{print $1}')
echo
echo "Fertig. backend.html ist jetzt nur im Heimnetz erreichbar unter:"
echo "  http://$LAN_IP:$PORT/"
echo "Von außerhalb (auch über drucken.luetje.me) nicht erreichbar."
echo
echo "Nicht vergessen: dort einmal 'Backup laden' mit der vorhin exportierten Datei,"
echo "damit die bisherige Auftragsliste wieder da ist."
