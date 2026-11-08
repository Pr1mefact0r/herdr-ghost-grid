#!/usr/bin/env bash
# Installs Ghost Grid into Herdr: theme, layouts "ghost-grid" + "ghost-grid-plain",
# background, the "daemons" mod, the ctrl-shift-d demo key, and makes it the default.
# Existing files are never overwritten without --force.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
DST="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
FORCE=0; [ "${1:-}" = "--force" ] && FORCE=1
[ -d "$DST" ] || { echo "✗ $DST fehlt – Herdr einmal starten, dann nochmal"; exit 1; }

files=(layouts/ghost-grid.json layouts/ghost-grid.svg layouts/ghost-grid-plain.json layouts/ghost-grid-plain.svg
       themes/ghost-grid.json backgrounds/ghost-grid.jpg mods/daemons/main.js mods/daemons/stage.js mods/daemons/mod.json)
for f in "${files[@]}"; do
  if [ -e "$DST/$f" ] && [ $FORCE -eq 0 ] && ! cmp -s "$SRC/$f" "$DST/$f"; then
    echo "✗ $DST/$f already exists and differs – use --force to overwrite"; exit 1
  fi
done
for f in "${files[@]}"; do mkdir -p "$DST/$(dirname "$f")"; cp "$SRC/$f" "$DST/$f"; echo "✓ $f"; done

python3 - "$DST" <<'PY'
import json, os, sys
d = sys.argv[1]
k = os.path.join(d, "keys.json")
keys = json.load(open(k)) if os.path.exists(k) else {}
sec = keys.setdefault("layout:ghost-grid", {})
if sec.get("ctrl-shift-d") not in (None, "daemons.demo", "daemons.demo-meeting"):
    print("! ctrl-shift-d is already taken in layout ghost-grid – left unchanged")
else:
    sec["ctrl-shift-d"] = "daemons.demo-meeting"; json.dump(keys, open(k, "w"), indent=2, ensure_ascii=False); print("✓ keys.json: ctrl-shift-d → demo meeting")
s = os.path.join(d, "settings.json")
st = json.load(open(s)) if os.path.exists(s) else {}
st["theme"] = "ghost-grid"; json.dump(st, open(s, "w"), indent=2); print("✓ settings.json: theme ghost-grid")
PY

if command -v herdr-app >/dev/null; then
  herdr-app check "$DST/mods/daemons" 2>/dev/null | tail -1 || true
  herdr-app do layout.switch '{"name":"ghost-grid"}' >/dev/null 2>&1 && echo "✓ layout ghost-grid active" || echo "→ Herdr is not running: switch to Ghost Grid with ctrl-shift-l next time"
fi
fc-list : family 2>/dev/null | grep -i 'hack' >/dev/null || echo "! Schrift 'Hack' fehlt (sudo apt install fonts-hack) – sonst nimmt Herdr JetBrains Mono"
