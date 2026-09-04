#!/usr/bin/env bash
# Richtet den KI-Vorschlag auf dem Pi ein: ANTHROPIC_API_KEY in die systemd-Unit,
# nginx-Routen /api/model und /api/scad auf den Dienst, Webroot-Kopie von index.html.
#
# Ausführen mit: sudo bash deploy/setup-ki-vorschlag.sh
#   Key und Modell werden, wenn vorhanden, aus ~/.config/druckauftrag/env des aufrufenden
#   Nutzers gelesen; nur was dort fehlt, wird abgefragt.
#   --nur-backend  lässt die öffentliche Seite komplett unangetastet: keine nginx-Route
#                  auf drucken.luetje.me, keine index.html-Kopie. Zum Ausprobieren im
#                  Heimnetz, bevor Kunden den Knopf sehen.
set -euo pipefail

NUR_BACKEND=0
[ "${1:-}" = "--nur-backend" ] && NUR_BACKEND=1

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

# Key und Modell bevorzugt aus der 0600-Datei des aufrufenden Nutzers lesen, damit sie
# nicht bei jedem Lauf neu eingetippt werden muessen. Unter sudo ist $HOME /root, deshalb
# ueber SUDO_USER. Fehlt die Datei, wird wie bisher gefragt.
KEYFILE="/home/${SUDO_USER:-jan}/.config/druckauftrag/env"
if [ -r "$KEYFILE" ]; then
  set -a; . "$KEYFILE"; set +a
  [ -n "${ANTHROPIC_API_KEY:-}" ] && echo "Key aus $KEYFILE uebernommen."
  [ -n "${ANTHROPIC_MODEL:-}"   ] && echo "Modell aus $KEYFILE: ${ANTHROPIC_MODEL}"
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  read -rsp "Anthropic-API-Key (console.anthropic.com): " ANTHROPIC_API_KEY; echo
  [ -n "$ANTHROPIC_API_KEY" ] || { echo "Kein Key eingegeben, Abbruch." >&2; exit 1; }
fi

if [ -z "${ANTHROPIC_MODEL:-}" ]; then
  read -rp "Modell [claude-opus-5]: " ANTHROPIC_MODEL
  ANTHROPIC_MODEL=${ANTHROPIC_MODEL:-claude-opus-5}
fi
# Modell-IDs schreiben sich durchgehend mit Bindestrich (claude-haiku-4-5, nicht -4.5).
# Ein Punkt wird sonst kommentarlos uebernommen und faellt erst auf, wenn ein Kunde
# "Anthropic antwortete mit HTTP 404" liest.
if ! printf '%s' "$ANTHROPIC_MODEL" | grep -qE '^claude-[a-z0-9-]+$'; then
  echo "Unplausibler Modellname: $ANTHROPIC_MODEL" >&2
  echo "Erwartet wird etwas wie claude-opus-5, claude-sonnet-5 oder claude-haiku-4-5" >&2
  echo "— nur Kleinbuchstaben, Ziffern und Bindestriche, keine Punkte." >&2
  exit 1
fi

echo "== 1/4: Key in die systemd-Unit =="
# Bestehende Environment-Zeilen behalten, ANTHROPIC_* ersetzen bzw. ergänzen.
sed -i '/^Environment=ANTHROPIC_/d' "$UNIT"
sed -i "/^ExecStart=/a Environment=ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY\nEnvironment=ANTHROPIC_MODEL=$ANTHROPIC_MODEL" "$UNIT"
chmod 600 "$UNIT"

echo "== 2/4: nginx-Routen =="
# Beide Sites brauchen die Route: die oeffentliche fuer Kunden, die Heimnetz-Site
# (Port 8080) damit Jan im Backend testen kann, ohne die Kundenseite anzufassen.
if [ "$NUR_BACKEND" -eq 1 ]; then SITES=("$SITE_LOKAL"); else SITES=("$SITE" "$SITE_LOKAL"); fi
for site in "${SITES[@]}"; do
  [ -f "$site" ] || { echo "   $site fehlt, uebersprungen."; continue; }
  # /api/model ist oeffentlich: Foto + Beschreibung -> Moderation -> Modell. Der groessere
  # Body-Deckel ist noetig, weil das base64-kodierte Bild mitkommt; ohne ihn antwortet
  # nginx mit 413, bevor der Dienst die Anfrage ueberhaupt sieht.
  if grep -q '/api/model' "$site"; then
    echo "   $(basename "$site"): /api/model existiert schon, uebersprungen."
  else
    sed -i '/location \/api\/send-mail/i\    location = /api/model {\n        proxy_pass http://127.0.0.1:8181/model;\n        client_max_body_size 12m;\n        proxy_read_timeout 120s;\n    }\n' "$site"
    echo "   $(basename "$site"): /api/model ergaenzt."
  fi
done

# /api/scad bleibt bewusst auf die Heimnetz-Site beschraenkt, auch beim vollen Rollout:
# dahinter wird generierter OpenSCAD-Code auf dem Pi ausgefuehrt. Das gehoert nicht
# an einen oeffentlich erreichbaren Endpunkt.
if [ -f "$SITE_LOKAL" ]; then
  if grep -q '/api/scad' "$SITE_LOKAL"; then
    echo "   backend-lokal: /api/scad existiert schon, uebersprungen."
  else
    sed -i '/location \/api\/send-mail/i\    location = /api/scad {\n        proxy_pass http://127.0.0.1:8181/scad;\n    }\n' "$SITE_LOKAL"
    echo "   backend-lokal: /api/scad ergaenzt."
  fi
fi
nginx -t

echo "== 3/4: Seiten in die Webroots =="

# impressum.html enthaelt im Repo nur Platzhalter — Name und Anschrift stehen bewusst nicht
# im oeffentlichen GitHub-Repo, sondern in einer 0600-Datei auf dem Pi. Hier werden sie beim
# Ausliefern eingesetzt. Ohne Fragment bricht der Deploy ab: eine Seite ohne Impressum nach
# § 5 TMG darf nicht live gehen.
FRAG="/home/${SUDO_USER:-jan}/.config/druckauftrag/impressum.html.frag"
if [ ! -r "$FRAG" ]; then
  echo "FEHLER: $FRAG fehlt — ohne Impressumsangaben wird nicht ausgeliefert." >&2
  exit 1
fi
python3 - "$REPO/impressum.html" "$FRAG" "$WEBROOT/impressum.html" <<'PYEOF'
import re, sys
vorlage, frag, ziel = sys.argv[1], sys.argv[2], sys.argv[3]
f = open(frag).read()
tmg  = f.split("<!-- TMG -->")[1].split("<!-- MSTV -->")[0].strip()
mstv = f.split("<!-- MSTV -->")[1].strip()
s = open(vorlage).read()
for marke, inhalt in (("TMG", tmg), ("MSTV", mstv)):
    muster = r"    <!-- PLATZHALTER-%s:[^>]*-->\n    <p>Angaben werden beim Ausliefern eingesetzt\.</p>" % marke
    s, n = re.subn(muster, lambda _m: inhalt, s, count=1)
    if n != 1:
        sys.exit("Platzhalter %s nicht gefunden — Impressum nicht ausgeliefert." % marke)
open(ziel, "w").write(s)
print("   impressum.html mit Angaben aus dem Fragment ausgeliefert.")
PYEOF

[ -d "$WEBROOT_LOKAL" ] && cp "$REPO/backend.html" "$WEBROOT_LOKAL/backend.html"
if [ "$NUR_BACKEND" -eq 1 ]; then
  echo "   index.html übersprungen (--nur-backend)."
else
  cp "$REPO/index.html" "$WEBROOT/index.html"
fi

echo "== 4/4: Dienste neu laden =="
systemctl daemon-reload
systemctl restart druckauftrag-backup
systemctl reload nginx

echo
if [ "$NUR_BACKEND" -eq 1 ]; then
  echo "Fertig — ABER NUR IM HEIMNETZ."
  echo "Die öffentliche Seite drucken.luetje.me ist unverändert: keine /api/model-Route,"
  echo "alte index.html im Webroot. Kunden sehen den Knopf nicht."
  echo "Wenn es passt, dasselbe Skript ohne --nur-backend noch einmal laufen lassen."
  echo
  echo "Ausprobieren: http://$(hostname -I | awk '{print $1}'):8080/"
else
  echo "Fertig. Öffentliche Seite und Heimnetz-Backend sind beide aktualisiert."
  echo
  # Ohne X-Backup-Secret antwortet der Dienst mit 403 — der Wert steht im ausgelieferten
  # index.html, ist also kein Geheimnis, muss aber mitgeschickt werden.
  SEC=$(sed -n 's/^const BACKUP_SECRET = "\(.*\)";/\1/p' "$REPO/index.html")
  echo "Kurztest (erzeugt ein Modell, kostet einen API-Aufruf):"
  echo "  curl -s -X POST https://drucken.luetje.me/api/model \\"
  echo "    -H 'content-type: application/json' -H 'X-Backup-Secret: $SEC' \\"
  echo "    -d '{\"description\":\"Distanzhuelse aussen 20 mm innen 8 mm 15 mm hoch\"}'"
fi
