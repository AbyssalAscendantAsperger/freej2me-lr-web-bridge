# FreeJ2ME Web Integration Kit

Bộ này giúp dev khác nhúng FreeJ2ME web bridge vào website riêng.

## Files

```txt
server/server.js                 Server bridge mới nhất, copy đè vào server.js của project
server/config.example.json        Config mẫu
client/freej2me-embed-client.js   JS SDK cho web cùng origin / reverse proxy
examples/iframe-embed.html        Cách nhúng dễ nhất bằng iframe
examples/sdk-same-origin.html     Ví dụ dùng SDK trực tiếp
nginx/reverse-proxy-example.conf  Ví dụ reverse proxy
```

## Cách tích hợp dễ nhất: iframe

Chạy bridge ở port 3000, trong web khác dùng:

```html
<iframe src="https://your-domain.com/j2me/" allow="autoplay; fullscreen"></iframe>
```

Khuyến nghị reverse proxy bridge về cùng domain để cookie login/save hoạt động tốt.

## Cách tích hợp SDK

Dùng `client/freej2me-embed-client.js` nếu web của bạn cùng origin với bridge hoặc đã reverse proxy.

```html
<script src="/j2me/client/freej2me-embed-client.js"></script>
<canvas id="screen"></canvas>
<script>
const client = new FreeJ2MEEmbedClient({ baseUrl: '/j2me', canvas: '#screen' });
await client.login('user','pass');
client.connect();
</script>
```

Nếu khác domain, cookies + WebSocket có thể bị chặn bởi CORS/SameSite. Iframe hoặc reverse proxy là cách ít lỗi nhất.

## Màn hình 320x240, 240x320 và mọi kích thước khác

Bridge xuất frame theo width/height cấu hình. Client nhận `config` qua WebSocket:

```json
{ "width": 320, "height": 240, "videoCodec": "rgb565" }
```

Vì vậy gần như màn nào cũng hỗ trợ, miễn FreeJ2ME chạy được kích thước đó.

### Chạy landscape 320x240

PowerShell:

```powershell
$env:SCREEN_WIDTH="320"
$env:SCREEN_HEIGHT="240"
$env:TARGET_FPS="30"
$env:MAX_FPS="30"
$env:VIDEO_CODEC="rgb565"
$env:STREAM_SCALE="1"
npm start
```

Hoặc config.json:

```json
{
  "width": 320,
  "height": 240,
  "targetFps": 30,
  "maxFps": 30,
  "videoCodec": "rgb565",
  "imageQuality": 65
}
```

### Chạy portrait 240x320

```json
{ "width": 240, "height": 320 }
```

### Custom 176x208, 360x640, v.v.

```powershell
$env:SCREEN_WIDTH="176"
$env:SCREEN_HEIGHT="208"
npm start
```

Lưu ý: game J2ME cũ có thể tự thiết kế cho một vài kích thước nhất định. Bridge hỗ trợ xuất hình nhiều kích thước, nhưng game có đẹp hay không tùy game.

## Video compression

Không cần native package. Server hỗ trợ:

- `rgba`: đẹp nhất, 32-bit
- `rgb565`: khuyên dùng, giảm 50%
- `rgb332`: nhẹ nhất, giảm 75%, màu giảm rõ

```powershell
$env:VIDEO_CODEC="rgb565"
$env:WS_COMPRESSION="0"
npm start
```

## Save riêng từng user

Server dùng JSON DB ở:

```txt
freej2me_data/users.json
```

Save/runtime theo:

```txt
freej2me_data/users/<userId>/games/<gameHash>/runtime
```

Mỗi user + mỗi game có data riêng, không ảnh hưởng nhau.

## Audio

Dùng `freej2me-lr-audiopipe-v2-debug.jar` hoặc `freej2me-lr-audiopipe-v2.jar` và server sẽ tự ưu tiên file đó nếu đặt cạnh `freej2me-lr.jar`.

```powershell
$env:AUDIO_PIPE="1"
$env:SOUND="1"
npm start
```

## For dev headless integration

Nếu dev khác không muốn dùng UI/login/keymap mặc định, dùng thư mục:

```txt
for-dev/
```

Nó cung cấp headless API:

```txt
POST /api/instances
WS   /ws/:instanceId
```

Dev tự quản login/map phím/canvas, bridge chỉ nhận JAR và xuất frame/audio.

## V21 Sharp WebP + FFmpeg Opus

V21 supports optional `sharp` for WebP video frames and `ffmpeg` for Opus audio.

### Windows

Put ffmpeg here:

```txt
freej2me-lr-web-bridge/tools/ffmpeg.exe
```

Run:

```bat
scripts\run-windows-best.bat
```

### Codespaces/Linux

```bash
sudo apt update
sudo apt install -y openjdk-11-jre-headless ffmpeg
scripts/run-codespace-best.sh
```

### Manual config

```bash
npm install sharp
export VIDEO_CODEC=webp
export WEBP_QUALITY=48
export WEBP_EFFORT=0
export AUDIO_CODEC=opus
export OPUS_BITRATE=64k
export FFMPEG_PATH=ffmpeg
npm start
```

If WebP uses too much CPU, fallback:

```bash
export VIDEO_CODEC=rgb565
export STREAM_SCALE=2
```

## V22 auto shutdown

To avoid emulator processes running forever after a browser tab closes:

```bash
export NO_CLIENT_SHUTDOWN_MS=5000
```

Optional aggressive idle input shutdown:

```bash
export INPUT_IDLE_SHUTDOWN_MS=0
```

Keep input idle disabled unless you really want to kill sessions with no key/touch activity.

## V23 security / queue guard

V23 adds default protection for public demos:

```bash
export SESSION_POLICY=single          # one active login/device per account
export MAX_ACTIVE_SESSIONS=8
export START_CONCURRENCY=1            # Java starts at a time
export QUEUE_MAX_SIZE=16
export MAX_WS_PER_IP=8
export MAX_CLIENTS_PER_INSTANCE=2
export MAX_ACCOUNTS_PER_IP=5
export AUTH_RATE_LIMIT=20
export UPLOAD_RATE_LIMIT=6
export API_RATE_LIMIT=180
export WS_RATE_LIMIT=60
export RATE_LIMIT_WINDOW_MS=60000
export NO_CLIENT_SHUTDOWN_MS=5000
```

Optional packages:

```bash
npm install sharp helmet cors
```

`bull`/Redis is recommended only for multi-server production. The default single-node build uses an in-memory queue to avoid extra services.

## V24 storage/quota cleanup

V24 adds disk protection:

```bash
export MAX_UPLOAD_MB=50
export MAX_USER_STORAGE_MB=500
export MAX_TOTAL_STORAGE_MB=0          # 0 disables global quota
export UPLOAD_RETENTION_HOURS=24
export TEMP_RETENTION_HOURS=6
export CLEANUP_INTERVAL_MS=600000
```

APIs:

```txt
GET  /api/storage        # logged-in user's storage usage
POST /api/admin/cleanup  # logged-in manual cleanup trigger
```

Cleanup removes old temporary uploads and obvious temp/log files. It does **not** delete save/runtime roots aggressively, to avoid destroying player saves.
