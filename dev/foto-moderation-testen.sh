#!/usr/bin/env bash
# Testet, ob /api/model ein Foto akzeptiert oder ablehnt — ohne etwas zu speichern.
# Aufruf:  bash dev/foto-moderation-testen.sh /pfad/zum/foto.jpg ["Beschreibung"]
set -euo pipefail

BILD="${1:-}"
BESCHR="${2:-Bitte dieses Teil drucken}"
[ -r "$BILD" ] || { echo "Bild nicht gefunden: $BILD" >&2; exit 1; }

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SEC=$(sed -n 's/^const BACKUP_SECRET = "\(.*\)";/\1/p' "$REPO/index.html")

case "$BILD" in
  *.png)  MT=image/png ;;
  *.jpg|*.jpeg) MT=image/jpeg ;;
  *.webp) MT=image/webp ;;
  *.gif)  MT=image/gif ;;
  *) echo "Nur JPG/PNG/WebP/GIF" >&2; exit 1 ;;
esac

python3 - "$BILD" "$MT" "$BESCHR" "$SEC" <<'PYEOF'
import base64, json, sys, urllib.request, urllib.error
bild, mt, beschr, sec = sys.argv[1:5]
data = base64.b64encode(open(bild,"rb").read()).decode()
req = urllib.request.Request("https://drucken.luetje.me/api/model",
    json.dumps({"description":beschr,"image":{"media_type":mt,"data":data}}).encode(),
    {"content-type":"application/json","X-Backup-Secret":sec})
try:
    d = json.load(urllib.request.urlopen(req, timeout=90))
except urllib.error.HTTPError as e:
    d = json.load(e)
if d.get("ok"):
    print("ANGENOMMEN — es wurde ein Modell erzeugt.")
    print("  ", d.get("reason",""))
else:
    print("ABGELEHNT")
    print("   Kategorie:", d.get("kategorie","(keine)"))
    print("   Meldung:  ", d.get("error",""))
PYEOF
