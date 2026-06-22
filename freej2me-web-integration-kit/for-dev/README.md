# For Dev: FreeJ2ME Headless Web Core V21

Dành cho dev **không muốn dùng UI/login/keymap mặc định**.

Core quản lý:

- nhận JAR/JAD/KJX
- chạy FreeJ2ME instance
- xuất video qua WebSocket: `rgba`, `rgb565`, `rgb332`, hoặc `webp` nếu cài `sharp`
- xuất audio qua HTTP Opus/WebM nếu có `ffmpeg`, fallback PCM WebSocket
- save riêng theo `externalUserId + gameHash`
- nhận input chuẩn key/touch
- Java autodetect Linux/Windows, Java home, version >= 8

Dev quản lý:

- login/user/token của hệ thống riêng
- UI/canvas/CSS
- map phím/gamepad/nút ảo
- chọn màn hình, codec, fps, bitrate

## Chạy core

Linux/Codespaces:

```bash
sudo apt update
sudo apt install -y openjdk-11-jre-headless ffmpeg
npm install sharp
export BRIDGE_TOKEN=dev-secret
export JAVA_HOME=/usr/lib/jvm/java-11-openjdk-amd64
export JAVA_PATH=$JAVA_HOME
export PORT=3100
node for-dev/server/headless-core-server.js
```

Windows:

```bat
npm install sharp
set BRIDGE_TOKEN=dev-secret
set FFMPEG_PATH=tools\ffmpeg.exe
node for-dev\server\headless-core-server.js
```

## Tạo instance

```http
POST /api/instances
X-Bridge-Token: dev-secret
multipart/form-data:
  jar=<game.jar>
  externalUserId=user_123
  width=320
  height=240
  videoCodec=webp
  webpQuality=48
  webpEffort=0
  audioCodec=opus
  opusBitrate=64k
  maxFps=20
```

Response:

```json
{
  "success": true,
  "instanceId": "i_xxx",
  "gameHash": "sha1...",
  "wsPath": "/ws/i_xxx",
  "audioUrl": "/audio/s_xxx.webm",
  "config": {
    "width": 320,
    "height": 240,
    "videoCodec": "webp",
    "audioCodec": "opus"
  }
}
```

## Connect

```txt
/ws/<instanceId>?token=dev-secret
```

Audio Opus stream:

```txt
/audio/<sessionId>.webm
```

Nếu dev dùng `headless-client.js`, SDK tự decode video và play audio.

## Key index

```txt
0 Up, 1 Down, 2 Left, 3 Right, 7 Fire, 8 RightSoft, 9 LeftSoft,
12 *, 13 #, 6 Num0, 10 Num1, 14 Num2, 11 Num3, 15 Num4,
18 Num5, 16 Num6, 5 Num7, 17 Num8, 4 Num9, 19 Clear
```

## Session behavior

Cùng `externalUserId` tạo instance mới sẽ stop instance cũ để tránh frame/audio cũ lẫn game mới.
Muốn nhiều slot đồng thời, dùng external id khác:

```txt
user_123_slot_1
user_123_slot_2
```

## V22 auto shutdown

Core now stops emulator instances when the last WebSocket client disconnects.

Config:

```bash
export NO_CLIENT_SHUTDOWN_MS=5000      # default: kill emulator 5s after last tab closes
export INPUT_IDLE_SHUTDOWN_MS=0        # default disabled. If set, kills connected idle players too.
```

For public demos, keep `NO_CLIENT_SHUTDOWN_MS=5000`. Be careful with `INPUT_IDLE_SHUTDOWN_MS=5000` because cutscenes/menus without input may be killed.

## Security/quota recommendations for dev integration

When exposing the headless core publicly, configure limits:

```bash
export BRIDGE_TOKEN=long-random-secret
export MAX_ACTIVE_SESSIONS=8
export MAX_CLIENTS_PER_INSTANCE=1
export MAX_WS_PER_IP=8
export QUEUE_MAX_SIZE=16
export START_CONCURRENCY=1
export NO_CLIENT_SHUTDOWN_MS=5000
```

For multi-server production, put this core behind your own auth gateway and use Redis/Bull or your platform queue. For a single VPS, the built-in in-memory session limits are usually enough.

## V24 storage/quota config for dev

Recommended for public headless deployment:

```bash
export MAX_UPLOAD_MB=30
export MAX_USER_STORAGE_MB=300
export MAX_TOTAL_STORAGE_MB=0
export UPLOAD_RETENTION_HOURS=12
export TEMP_RETENTION_HOURS=6
export CLEANUP_INTERVAL_MS=600000
```

The cleanup is conservative: it removes old upload files and temp/log files, not permanent save roots.
