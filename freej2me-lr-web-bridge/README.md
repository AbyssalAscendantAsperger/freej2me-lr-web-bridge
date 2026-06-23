# FreeJ2ME-LR-Web-Bridge với tích hợp freej2me-web (CheerpJ)

> **Mở rộng mới:** Cho phép launcher của [freej2me-web](https://github.com/zb3/freej2me-web) (CheerpJ WASM) **ấn nút trên game → chạy thẳng vào Node.js serverside**, không qua CheerpJ. Game WASM của freej2me-web vẫn hoạt động bình thường, hoàn toàn không bị ảnh hưởng.

---

## 1. Tổng quan

`freej2me-lr-web-bridge` là Node.js server chạy emulator [freej2me-lr](https://github.com/zb3/freej2me) (fork libretro) serverside và stream video/audio về client qua WebSocket.

**Mở rộng mới (`fj2me-bridge.js` + `fj2me-web-bridge-client.js`):**

| Phía | File | Vai trò |
|------|------|---------|
| Node.js | `fj2me-bridge.js` | Mount thêm các API `/bridge/fj2meweb/...` + `/bridge/api` (PHP-style), quản lý BridgeEmulatorSession cho mỗi gameId, hỗ trợ MySQL/phpMyAdmin optional. |
| freej2me-web (client) | `public/fj2me-web-bridge-client.js` | Nhúng vào `index.html` (thêm nút **☁ Bridge** cho mỗi game) và `run.html` (khi `?bridge=1` thì thay CheerpJ rendering bằng WebSocket stream từ Node.js). |
| Tool | `tools/integrate-fj2me-web.js` | Tự động patch `index.html` + `run.html` của freej2me-web để include bridge client. |

**Luồng tích hợp:**

```
┌─────────── freej2me-web (CheerpJ WASM) ───────────┐
│  launcher (index.html): thấy nút "☁ Bridge"       │
│   └─ ấn nút → pushGameToBridge(appId)             │
│       ├─ đọc JAR từ /files/<appId>/app.jar         │
│       ├─ đọc settings từ /files/<appId>/config/..  │
│       └─ POST /bridge/fj2meweb/push-game           │
│                                                   │
│  run.html (khi ?bridge=1):                         │
│   └─ BridgeStreamClient kết nối WS                │
│       └─ vẽ binary frames từ Node.js lên canvas    │
└─────────────────────┬─────────────────────────────┘
                      │  HTTP / WS
                      ▼
┌─────────── Node.js server.js + fj2me-bridge.js ───┐
│  /bridge/fj2meweb/push-game   ← nhận JAR + settings│
│  /bridge/fj2meweb/launch/:id  ← spawn emulator     │
│  /bridge/fj2meweb/stream/:id  ← WebSocket stream   │
│  /bridge/fj2meweb/settings/:id                    │
│  /bridge/fj2meweb/list                            │
│  /bridge/fj2meweb/compat/:id                      │
│  /bridge/api (PHP-style envelope)                  │
│                                                   │
│  BridgeEmulatorSession:                           │
│   ├─ spawn java -jar freej2me-lr.jar              │
│   ├─ đọc frames từ stdout (FE marker + RGB24)     │
│   ├─ đọc audio từ stderr (FJ2A packets)           │
│   └─ broadcast frames qua WebSocket               │
└───────────────────────────────────────────────────┘
```

Game WASM (CheerpJ) của freej2me-web **vẫn chạy bình thường** — đây là tích hợp opt-in, người dùng ấn nút "☁ Bridge" mới qua Node.js. Lý do dùng Node.js thay vì CheerpJ: M3G 3D, Mascot Capsule, MIDI nặng, JAR > 1.5MB… thường chạy kém trên CheerpJ WASM, bridge serverside cho hiệu năng ổn định hơn.

---

## 2. Yêu cầu

- **Node.js 18+** và **npm**.
- **Java 8+** (JDK/JRE). Trên Windows có thể dùng `jdk8u492-b09-jre/bin/java.exe` đi kèm. Trên Linux/macOS dùng `java` từ PATH hoặc `JAVA_HOME`.
- **freej2me-lr.jar** (libretro fork của freej2me): clone https://github.com/zb3/freej2me, build và lấy `freej2me-lr.jar`. Đặt cùng cấp thư mục với `server.js` hoặc trỏ `freej2meJar` trong config.json.
- **ffmpeg** (optional, cho audio Opus stream): `apt install ffmpeg` hoặc tải `tools/ffmpeg.exe` trên Windows.
- **sharp** (optional, cho video WebP): `npm install sharp`.
- **mysql2** (chỉ khi muốn dùng MySQL thay JSON DB): `npm install mysql2`.

Đường dẫn mặc định (tính từ thư mục bridge):

```
../jdk8u492-b09-jre/bin/java.exe   ← Java
../freej2me-plus/freej2me-lr.jar   ← JAR
```

Có thể override qua `config.json` (`javaPath`, `freej2meJar`) hoặc biến môi trường `JAVA_PATH`, `FREEJ2ME_LR_JAR`.

---

## 3. Cài đặt nhanh

```bash
cd freej2me-lr-web-bridge
npm install
# (tuỳ chọn) cài thêm sharp và/hoặc mysql2
npm install sharp mysql2
# Sửa config.json nếu cần (đường dẫn java, jar, port...)
node server.js
```

Mở `http://localhost:3000` — sẽ thấy UI login/upload của server.js gốc.

---

## 4. Cấu hình (`config.json`)

File `config.json` gốc đã có sẵn các field `javaPath`, `freej2meJar`, `width`, `height`, `phoneType`, `rotate`, `fps`, `sound`, `maxFps`, `port`. **Mở rộng mới** thêm 2 section:

### 4.1. `bridge` — tích hợp với freej2me-web

```json
"bridge": {
  "enabled": true,
  "publicUrl": "",
  "sharedSecret": "",
  "protocol": "ws",
  "autoFallbackOnCheerpjCrash": false,
  "phpApiEnabled": true,
  "phpApiPath": "/bridge/api",
  "corsOrigins": [],
  "streamScale": 1,
  "videoCodec": "",
  "imageQuality": 65,
  "audioCodec": "opus",
  "gamesDir": "./freej2me_data/bridge_games",
  "keepUploadsDays": 30,
  "mysql": {
    "enabled": false,
    "host": "localhost",
    "port": 3306,
    "user": "freej2me_user",
    "password": "",
    "database": "freej2me_bridge",
    "charset": "utf8mb4"
  },
  "phpCompat": {
    "enabled": true,
    "acceptPhpSessionCookie": true,
    "phpSessionCookieName": "PHPSESSID",
    "responseEnvelope": "php"
  }
}
```

- `enabled`: bật/tắt toàn bộ bridge (server.js sẽ không mount routes nếu false).
- `publicUrl`: URL public của Node.js bridge (vd: `https://fj2me.example.com`). Nếu để trống, server tự detect từ `Host` header.
- `sharedSecret`: token chia sẻ giữa freej2me-web và Node.js. Cấu hình cả 2 phía để bảo mật.
- `corsOrigins`: danh sách origin cho phép (vd: `["https://zb3.github.io", "https://yourdomain.com"]`).
- `gamesDir`: thư mục lưu JAR đẩy từ freej2me-web.
- `keepUploadsDays`: tự dọn JAR cũ sau N ngày không dùng.
- `mysql`: nếu `enabled: true` thì dùng MySQL thay JSON DB. Tự tạo 3 table: `bridge_games`, `bridge_configs`, `bridge_sessions`. Quản lý qua phpMyAdmin dễ dàng.
- `phpCompat`: response kiểu PHP API (`{ success, data, error, meta }`) để web hosting PHP tương thích.

### 4.2. `perGame` — cấu hình riêng cho từng game

```json
"perGame": {
  "mygameid": {
    "width": 240,
    "height": 320,
    "phoneType": 1,
    "fps": 60,
    "sound": 1,
    "rotate": 0,
    "maxFps": 60,
    "streamScale": 1,
    "videoCodec": "rgba",
    "imageQuality": 90,
    "jvmArgs": ["-Xmx256m"]
  }
}
```

Khi freej2me-web đẩy game sang bridge, Node.js sẽ:
1. Load config mặc định (root config.json).
2. Merge với `perGame[<gameId>]`.
3. Merge với settings client gửi (từ CheerpJ `settings.conf`).
4. Áp dụng cuối cùng khi spawn emulator.

**Ưu tiên:** client settings > `perGame` > defaults. `config.json` cho phép chỉnh sửa nhanh để game chạy mượt hơn mà không cần sửa client.

---

## 5. Tích hợp với freej2me-web (CheerpJ)

### 5.1. Clone freej2me-web

```bash
git clone https://github.com/zb3/freej2me-web.git
cd freej2me-web/web
```

Đảm bảo serve được local: `npx serve -u web` (hoặc dùng HTTP server hỗ trợ `Range` header, vd Apache, Nginx, IIS).

### 5.2. Chạy tool tự patch

```bash
# Từ thư mục freej2me-lr-web-bridge
node tools/integrate-fj2me-web.js /path/to/freej2me-web/web \
    --bridge-url=https://fj2me.example.com \
    --secret=mysecrettoken
```

Tool sẽ:
1. Copy `public/fj2me-web-bridge-client.js` vào `freej2me-web/web/`.
2. Patch `index.html` — chèn `<script src="fj2me-web-bridge-client.js">` trước `src/launcher.js`. Tự backup `.bak`.
3. Patch `run.html` — chèn tương tự trước `src/main.js`. Tự backup `.bak`.
4. Inject `window.FJ2ME_BRIDGE_CONFIG` với `bridgeServerUrl` + `secretValue` bạn cung cấp.

**Revert:**
```bash
node tools/integrate-fj2me-web.js /path/to/freej2me-web/web --revert
```

### 5.3. Hoặc patch thủ công

Mở `freej2me-web/web/index.html`, **trước** dòng `<script type="module" src="src/launcher.js"></script>`, thêm:

```html
<script>
  window.FJ2ME_BRIDGE_CONFIG = {
    enabled: true,
    bridgeServerUrl: 'https://fj2me.example.com',
    secretValue: 'mysecrettoken'
  };
</script>
<script src="fj2me-web-bridge-client.js"></script>
```

Làm tương tự cho `freej2me-web/web/run.html`, **trước** `<script type="module" src="src/main.js"></script>`.

Copy file `public/fj2me-web-bridge-client.js` từ bridge vào `freej2me-web/web/`.

### 5.4. Sử dụng

1. Mở `http://localhost:3000` (hoặc freej2me-web URL nếu bridge ở origin khác) → login → upload game như bình thường (dùng UI server.js gốc) — đây là game chạy qua Node.js mặc định.

2. Hoặc mở freej2me-web launcher → thấy nút **☁ Bridge** trên mỗi game → ấn → JAR + settings đẩy sang Node.js → redirect sang `run.html?app=<id>&bridge=1&gameId=<hash>`.

3. `run.html` detect `bridge=1` → load `BridgeStreamClient` → kết nối WebSocket `wss://.../bridge/fj2meweb/stream/<gameId>` → nhận binary frames → vẽ lên `canvas#display` (CheerpJ **không chạy** game đó).

4. Bàn phím / touch / mouse từ web → forward sang Node.js qua WS → emulator xử lý → trả frames.

5. Audio FJ2A (PCM hoặc Opus) → phát qua Web Audio API hoặc `<audio>` element.

**Game WASM (CheerpJ) của freej2me-web không bị ảnh hưởng** — chỉ khi ấn nút "☁ Bridge" thì mới đi qua Node.js.

---

## 6. API Endpoints

### 6.1. JSON-style (cho JS client, freej2me-web-bridge-client.js dùng các API này)

| Method | Path | Mô tả |
|--------|------|-------|
| `POST` | `/bridge/fj2meweb/push-game` | Đẩy JAR + settings từ freej2me-web. Body JSON: `{ appId, name, jarBase64, settings, appProperties, systemProperties }`. Response: `{ success, data: { gameId, appId, name, settings, streamUrl } }`. |
| `GET`  | `/bridge/fj2meweb/list` | Liệt kê game đã đẩy. |
| `GET`  | `/bridge/fj2meweb/launch/:gameId` | Spawn emulator cho game. |
| `GET`  | `/bridge/fj2meweb/settings/:gameId` | Lấy config hiện tại. |
| `POST` | `/bridge/fj2meweb/settings/:gameId` | Update config. Sẽ restart session đang chạy. |
| `GET`  | `/bridge/fj2meweb/compat/:gameId` | Gợi ý nên dùng bridge không. |
| `DELETE` | `/bridge/fj2meweb/game/:gameId` | Xoá game + JAR. |
| WS    | `/bridge/fj2meweb/stream/:gameId` | Stream binary frames + JSON events. |

### 6.2. PHP-style (cho web hosting PHP, phpMyAdmin)

`POST /bridge/api` với body `{ action: ... }`:

```json
// Ping
{ "action": "ping" }
// → { "success": true, "data": { "pong": true, "bridgeVersion": "1.0.0" }, ... }

// List
{ "action": "list" }
// → { "success": true, "data": { "games": [...], "count": N } }

// Get
{ "action": "get", "gameId": "abc123" }
// → { "success": true, "data": { gameId, appId, name, jarSha1, ... } }

// Launch
{ "action": "launch", "gameId": "abc123" }
// → { "success": true, "data": { gameId, status: "launching", streamUrl } }

// Delete
{ "action": "delete", "gameId": "abc123" }
// → { "success": true, "data": { gameId, deleted: true } }
```

Response envelope (giống PHP REST API phổ biến):
```json
{
  "success": true,
  "data": { ... },
  "error": null,
  "meta": { "server": "fj2me-bridge", "ts": 1729876543 }
}
```

### 6.3. WebSocket protocol (`/bridge/fj2meweb/stream/:gameId`)

**Server → Client (binary):**
- RGB frames (RGB332/RGB565/RGBA hoặc WebP tùy config).
- Audio FJ2A packets: header `FJ2A` + type 1 (format) hoặc type 2 (PCM data).

**Server → Client (JSON):**
- `{ type: 'hello', gameId, appId }` — khi kết nối.
- `{ type: 'config', width, height, codec, scale }` — khi emulator set canvas size.
- `{ type: 'audio-format', format: { sampleRate, channels, bits, ... }, codec: 'pcm'|'opus' }`.
- `{ type: 'audio-status', audioUrl: '/audio/<sid>.webm', codec, ... }` — nếu Opus.
- `{ type: 'status', state: 'running'|'exited'|'error', gameId }`.

**Client → Server (JSON):**
- `{ type: 'key', key: <int>, state: 'D'|'U' }` — nhấn/nhả phím (codeMap giống freej2me-web).
- `{ type: 'touch', state: 'D'|'M'|'U', x, y }` — touch/mouse.
- `{ type: 'ping', ts }` — heartbeat (server trả `{ type: 'pong' }`).

---

## 7. PHP/MySQL Hosting tương thích

### 7.1. Dùng MySQL làm DB (qua phpMyAdmin)

1. Tạo database trong phpMyAdmin: `freej2me_bridge` với user `freej2me_user`.
2. Trong `config.json`:
   ```json
   "bridge": {
     "mysql": {
       "enabled": true,
       "host": "localhost",
       "port": 3306,
       "user": "freej2me_user",
       "password": "your_password",
       "database": "freej2me_bridge",
       "charset": "utf8mb4"
     }
   }
   ```
3. `npm install mysql2`.
4. Restart server. Khi init, server sẽ tự tạo 3 table:
   - `bridge_games` (game_id PK, app_id, name, jar_sha1, jar_size, created_at, last_launch, launch_count, jar_path).
   - `bridge_configs` (game_id PK, config_json MEDIUMTEXT, updated_at).
   - `bridge_sessions` (sid PK, game_id, user_id, created_at, last_activity).

Quản lý qua phpMyAdmin bình thường. Sửa config của game nào thì vào table `bridge_configs`, chỉnh JSON trong cột `config_json`.

### 7.2. Chia sẻ session với PHP site

Nếu web hosting PHP của bạn đã có login (vd forum, account), cho phép bridge dùng chung `PHPSESSID`:

```json
"bridge": {
  "phpCompat": {
    "enabled": true,
    "acceptPhpSessionCookie": true,
    "phpSessionCookieName": "PHPSESSID",
    "responseEnvelope": "php"
  }
}
```

Khi đó user đã login PHP có thể gọi `/bridge/api` mà không cần login lại ở bridge. Lưu ý: cần cấu hình `corsOrigins` để cho phép domain PHP gọi bridge.

### 7.3. Gọi từ PHP code

```php
<?php
// Trong PHP site, sau khi user login.
$ch = curl_init('https://fj2me.example.com/bridge/api');
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode([
  'action' => 'list'
]));
curl_setopt($ch, CURLOPT_HTTPHEADER, [
  'Content-Type: application/json',
  'Cookie: PHPSESSID=' . session_id(),  // chia sẻ session với Node.js
]);
$resp = json_decode(curl_exec($ch), true);
if ($resp['success']) {
  foreach ($resp['data']['games'] as $g) {
    echo "<li>" . htmlspecialchars($g['name']) . "</li>";
  }
}
```

---

## 8. Ví dụ curl

Xem file `examples/curl-examples.sh` để chạy tất cả ví dụ tự động:

```bash
bash examples/curl-examples.sh ./game.jar
```

Hoặc chạy từng lệnh:

```bash
# Push game (JAR file)
GAMEID=$(curl -s -X POST http://localhost:3000/bridge/fj2meweb/push-game \
  -H 'Content-Type: application/json' \
  -d "{\"appId\":\"mygame\",\"name\":\"My Game\",\"jarBase64\":\"$(base64 -w0 game.jar)\",\"settings\":{\"phone\":\"Nokia\",\"width\":\"240\",\"height\":\"320\",\"sound\":\"on\"}}" \
  | jq -r '.data.gameId')

echo "gameId=$GAMEID"

# Launch
curl -s "http://localhost:3000/bridge/fj2meweb/launch/$GAMEID" | jq

# List
curl -s http://localhost:3000/bridge/fj2meweb/list | jq '.data.games[] | {gameId, name, appId, lastLaunch}'

# PHP-style API
curl -s -X POST http://localhost:3000/bridge/api \
  -H 'Content-Type: application/json' \
  -d '{"action":"list"}' | jq

# Update per-game config
curl -s -X POST "http://localhost:3000/bridge/fj2meweb/settings/$GAMEID" \
  -H 'Content-Type: application/json' \
  -d '{"fps":30,"maxFps":30,"videoCodec":"rgb565"}' | jq

# Delete game
curl -s -X DELETE "http://localhost:3000/bridge/fj2meweb/game/$GAMEID" | jq
```

---

## 9. Troubleshooting

| Lỗi | Nguyên nhân / Cách xử lý |
|-----|---------------------------|
| `Không tìm thấy Java executable` | Kiểm tra `config.json.javaPath` hoặc `JAVA_PATH`. Trên Linux nếu trỏ `.exe` Windows thì server tự fallback PATH. |
| `Không tìm thấy freej2me-lr.jar` | `freej2meJar` trỏ tới file hoặc thư mục chứa JAR. Server tự tìm `freej2me-lr-audiopipe-v2*.jar` hoặc `freej2me-lr.jar`. |
| `unauthorized` từ `/bridge/...` | `bridge.sharedSecret` không khớp `secretValue` trong `FJ2ME_BRIDGE_CONFIG` của freej2me-web. |
| `not logged in` khi kết nối WS | `CONFIG.requireLogin = true` và cookie `fj2me_sid` không hợp lệ. Đăng nhập lại trên `/`. |
| Game không chạy, màn hình đen | Kiểm tra log server (`[bridge:<gameId>]`), xem `[bridge-jar-stdout]` có `+READY` không. Nếu không → emulator không load được game. Thử đổi `perGame.<id>.phoneType` hoặc `width/height`. |
| FPS thấp / giật | Giảm `videoCodec` xuống `rgb332` (8-bit) hoặc `rgb565` (16-bit), tăng `streamScale` (vd `2`), giảm `maxFps`. |
| Audio không nghe | Bấm vào trang trước (unlock AudioContext). Kiểm tra `audioPipe: true` trong config và `bridge.audioCodec`. Cần `ffmpeg` cho Opus. |
| `mysql init failed` | MySQL config sai. Kiểm tra host/user/password/database. Đảm bảo `mysql2` đã cài. |
| `Cannot start ffmpeg` | Không có ffmpeg hoặc `ffmpegPath` sai. Đặt `tools/ffmpeg` (hoặc `tools/ffmpeg.exe`) hoặc `apt install ffmpeg`. |

---

## 10. Cấu trúc thư mục

```
freej2me-lr-web-bridge/
├── README.md                            # File này - hướng dẫn đầy đủ
├── config.json                          # Cấu hình (đã mở rộng section bridge + perGame)
├── server.js                            # Node.js server chính (đã patch mount bridge)
├── fj2me-bridge.js                      # ★ MODULE MỚI: tất cả extension APIs (1 file JS)
├── package.json
├── public/
│   ├── index.html                       # UI login + upload (server.js patch inline)
│   └── fj2me-web-bridge-client.js       # ★ MODULE MỚI: file JS nhúng vào freej2me-web (CheerpJ)
├── tools/
│   ├── integrate-fj2me-web.js           # ★ MODULE MỚI: tool auto-patch freej2me-web
│   ├── run-codespace-best.sh            # Script khởi chạy (Codespaces)
│   ├── run-windows-best.bat             # Script khởi chạy (Windows)
│   └── ffmpeg.exe (optional)            # Local ffmpeg cho Opus
├── examples/
│   ├── curl-examples.sh                 # ★ MODULE MỚI: ví dụ curl từng API
│   └── fj2me-bridge-api.php             # ★ MODULE MỚI: PHP API client cho web hosting PHP
├── freej2me_data/                       # Runtime data
│   ├── users.json                       # Auth DB (server.js gốc)
│   ├── bridge.json                      # ★ MODULE MỚI: bridge game registry (nếu không dùng MySQL)
│   └── bridge_games/<gameId>/           # ★ MODULE MỚI: JAR + runtime per game
└── uploads/                             # Upload tạm từ server.js gốc
```

**Các file mới (★)** theo yêu cầu "file mở rộng phải nằm ở `freej2me-lr-web-bridge/`, config.json và các API mở rộng cũng vậy (cho chung vào 1 tệp js)":
- `fj2me-bridge.js` - **tất cả extension APIs gom vào 1 file JS duy nhất**.
- `config.json` - mở rộng section `bridge` (cấu hình bridge) và `perGame` (config riêng từng game).
- `public/fj2me-web-bridge-client.js` - file JS để nhúng vào `freej2me-web` (thêm nút Bridge trong launcher + detect bridge=1 trong run.html).
- `tools/integrate-fj2me-web.js` - tool Node.js tự động patch `freej2me-web` để include bridge client.
- `examples/` - các ví dụ sử dụng API (curl + PHP).

---

## 11. Đường dẫn nhanh

- Repo chính: `freej2me-lr-web-bridge/`
- Source freej2me-lr (libretro Java): https://github.com/zb3/freej2me
- Source freej2me-web (CheerpJ web): https://github.com/zb3/freej2me-web
- API bridge base: `http://localhost:3000/bridge/fj2meweb/`
- API PHP-style: `http://localhost:3000/bridge/api`
- WebSocket stream: `ws://localhost:3000/bridge/fj2meweb/stream/<gameId>`

---

## 12. License

MIT (kế thừa từ `freej2me-lr-web-bridge` gốc).
