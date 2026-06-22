# For Dev: FreeJ2ME Headless Web Core

Thư mục này dành cho dev **không muốn dùng UI/login/keymap mặc định** của bridge.

Core quản lý:

- nhận JAR/JAD
- chạy FreeJ2ME instance
- xuất hình/audio qua WebSocket
- save riêng theo `externalUserId + gameHash`
- nhận input chuẩn key/touch
- per-instance tuỳ chỉnh width/height/fps/videoCodec/streamScale/audioPipe

Web/app của dev quản lý:

- login/user/token của họ
- giao diện upload/chọn game
- canvas/layout/CSS
- map phím/nút ảo/gamepad
- truyền `externalUserId` và tuỳ chỉnh vào core

## Files

```txt
for-dev/server/headless-core-server.js
for-dev/client/headless-client.js
for-dev/docs/PROTOCOL.md
for-dev/examples/custom-ui.html
```

## V17 có ảnh hưởng gì đến kit?

Có, theo hướng tốt hơn:

- Khi dev tạo instance mới cho cùng `externalUserId`, core dừng emulator cũ của user đó để tránh frame cũ/mới lẫn nhau.
- WebSocket chỉ thuộc về đúng 1 emulator session.
- Java auto-detect tốt hơn trên Linux: `JAVA_PATH`, `JAVA_HOME`, `which java`, check version >= 8.
- Headless API đã nhận per-instance options như `width=320&height=240&videoCodec=rgb565`.

## Chạy core server

```powershell
$env:BRIDGE_TOKEN="dev-secret"
$env:PORT="3100"
node for-dev/server/headless-core-server.js
```

Linux:

```bash
export BRIDGE_TOKEN=dev-secret
export PORT=3100
node for-dev/server/headless-core-server.js
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
  videoCodec=rgb565
  streamScale=1
  maxFps=30
```

Response:

```json
{
  "success": true,
  "instanceId": "i_xxx",
  "gameHash": "sha1...",
  "wsPath": "/ws/i_xxx",
  "config": { "width": 320, "height": 240, "videoCodec": "rgb565" }
}
```

## Kết nối WebSocket

```txt
/ws/i_xxx?token=dev-secret
```

## Save riêng

```txt
freej2me_data/users/ext_<externalUserId>/games/<gameHash>/runtime
```

## Màn hình

Dev truyền `width`/`height` khi tạo instance:

```txt
320x240 landscape
240x320 portrait
176x208 old Nokia
360x640 touch
```

Core xuất đúng `config.width/config.height`, dev tự scale canvas.
