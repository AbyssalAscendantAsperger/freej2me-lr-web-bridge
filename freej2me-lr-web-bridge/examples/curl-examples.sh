#!/usr/bin/env bash
# ============================================================================
# examples/curl-examples.sh
#
# Ví dụ sử dụng API bridge bằng curl. Chạy: bash examples/curl-examples.sh
# Server mặc định ở http://localhost:3000.
# ============================================================================

set -e
BASE="${BRIDGE_BASE:-http://localhost:3000}"
SECRET="${BRIDGE_SECRET:-}"  # nếu bridge.sharedSecret đã set thì điền vào
GAME_JAR="${1:-./game.jar}"  # đường dẫn tới file JAR, mặc định ./game.jar

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
cyan()  { printf '\033[36m%s\033[0m\n' "$*"; }

curl_bridge() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-s -X "$method" "$BASE$path" -H 'Content-Type: application/json')
  if [[ -n "$SECRET" ]]; then args+=(-H "X-Bridge-Secret: $SECRET"); fi
  if [[ -n "$body" ]]; then args+=(--data "$body"); fi
  curl "${args[@]}"
}

section() { cyan "\n=== $* ==="; }

section "1. Ping (PHP-style API)"
curl_bridge POST /bridge/api '{"action":"ping"}' | head -c 300; echo

section "2. Push game từ file JAR"
if [[ ! -f "$GAME_JAR" ]]; then
  red "Không tìm thấy file JAR: $GAME_JAR"
  red "Cách dùng: bash curl-examples.sh /path/to/game.jar"
  exit 1
fi
B64=$(base64 -w0 "$GAME_JAR")
APPID=$(basename "$GAME_JAR" .jar | tr 'A-Z' 'a-z' | tr -c 'a-z0-9.-' '_')
PUSH_BODY=$(cat <<EOF
{
  "appId": "$APPID",
  "name": "$(basename "$GAME_JAR")",
  "jarBase64": "$B64",
  "settings": { "phone": "Nokia", "width": "240", "height": "320", "sound": "on", "rotate": "off" }
}
EOF
)
PUSH_RESP=$(curl_bridge POST /bridge/fj2meweb/push-game "$PUSH_BODY")
echo "$PUSH_RESP" | head -c 500; echo
GAMEID=$(echo "$PUSH_RESP" | sed -n 's/.*"gameId":"\([^"]*\)".*/\1/p')
green "gameId = $GAMEID"

section "3. List tất cả game"
curl_bridge GET /bridge/fj2meweb/list | head -c 500; echo

section "4. Lấy config của game $GAMEID"
curl_bridge GET "/bridge/fj2meweb/settings/$GAMEID" | head -c 500; echo

section "5. Cập nhật config (fps=30, codec=rgb565)"
curl_bridge POST "/bridge/fj2meweb/settings/$GAMEID" '{"fps":30,"maxFps":30,"videoCodec":"rgb565"}' | head -c 500; echo

section "6. Kiểm tra compat"
curl_bridge GET "/bridge/fj2meweb/compat/$GAMEID" | head -c 300; echo

section "7. Launch (spawn emulator)"
curl_bridge GET "/bridge/fj2meweb/launch/$GAMEID" | head -c 500; echo

section "8. PHP-style: list games"
curl_bridge POST /bridge/api '{"action":"list"}' | head -c 500; echo

section "9. PHP-style: get 1 game"
curl_bridge POST /bridge/api "{\"action\":\"get\",\"gameId\":\"$GAMEID\"}" | head -c 500; echo

section "10. PHP-style: launch"
curl_bridge POST /bridge/api "{\"action\":\"launch\",\"gameId\":\"$GAMEID\"}" | head -c 500; echo

section "11. Kết nối WebSocket để stream frames"
green "wsURL = $BASE/bridge/fj2meweb/stream/$GAMEID"
green "Dùng wscat:"
green "  npm install -g wscat"
green "  wscat -c ws://localhost:3000/bridge/fj2meweb/stream/$GAMEID"
green "Sau đó gửi:"
green '  {"type":"ping"}'
green '  {"type":"key","key":7,"state":"D"}'
green '  {"type":"touch","state":"D","x":120,"y":160}'
green "Frames nhận về dạng binary (RGB565/RGBA) hoặc FJ2A audio packet."

section "12. Cleanup - xoá game"
curl_bridge DELETE "/bridge/fj2meweb/game/$GAMEID" | head -c 300; echo

green "\nDone!"
