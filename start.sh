#!/bin/bash
# NIGHT OPS — start the game server and open a public link to share.
cd "$(dirname "$0")"

echo ""
echo "  starting NIGHT OPS…"
pkill -f "node .*night-ops/server.js" 2>/dev/null
pkill -f "cloudflared tunnel --url http://localhost:8080" 2>/dev/null
sleep 0.5

node server.js &
NODE_PID=$!
sleep 1

echo "  opening public link (this takes ~10 seconds)…"
cloudflared tunnel --url http://localhost:8080 --no-autoupdate 2>&1 | \
while read -r line; do
  echo "$line" | grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1 | while read -r url; do
    echo ""
    echo "  ============================================================"
    echo "    SHARE THIS LINK:  $url"
    echo "  ============================================================"
    echo ""
  done
done

kill $NODE_PID 2>/dev/null
