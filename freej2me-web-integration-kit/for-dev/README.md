# For Dev: FreeJ2ME Headless Web Core

Thư mục này dành cho dev **không muốn dùng UI/login/keymap mặc định** của bridge.

Mục tiêu:

```txt
Bridge core quản lý:
- nhận JAR
- chạy FreeJ2ME instance
- xuất hình/audio qua WebSocket
- lưu save riêng theo externalUserId + gameHash
- nhận input dạng key index/touch từ hệ thống bên ngoài

Web/app của dev quản lý:
- đăng nhập/user/token của họ
- giao diện upload/chọn game
- layout màn hình/canvas CSS
- map phím của họ
- nút ảo/gamepad riêng
- truyền tuỳ chỉnh width/height/videoCodec/fps/... vào bridge
```

## Files

```txt
for-dev/server/headless-core-server.js   Server core không UI/login
for-dev/client/headless-client.js        SDK client tối giản để nhận màn/audio + gửi input
for-dev/docs/PROTOCOL.md                 API/WS protocol
for-dev/examples/custom-ui.html          Ví dụ web tự quản UI/keymap
```

## Chạy core server

Copy `headless-core-server.js` vào project bridge, hoặc chạy riêng trong cùng thư mục có `config.json`/`freej2me-plus`.

```powershell
$env:BRIDGE_TOKEN="dev-secret"
$env:PORT="3100"
node headless-core-server.js
```

Nếu không set `BRIDGE_TOKEN`, server vẫn chạy nhưng không khuyến nghị public.

## Flow tích hợp

1. Web của dev login user theo hệ thống của họ.
2. Web lấy `externalUserId` từ backend của họ, ví dụ `user_123`.
3. Web gọi bridge:

```http
POST /api/instances
X-Bridge-Token: dev-secret
multipart/form-data:
  jar=<game.jar>
  externalUserId=user_123
  width=320
  height=240
  videoCodec=rgb565
  maxFps=30
```

4. Bridge trả:

```json
{
  "instanceId": "i_xxx",
  "gameHash": "sha1...",
  "wsPath": "/ws/i_xxx"
}
```

5. Web mở WebSocket `/ws/i_xxx`.
6. Web nhận binary frame/audio và tự vẽ canvas.
7. Web tự map phím rồi gửi input:

```json
{ "type": "key", "state": "D", "key": 0 }
{ "type": "key", "state": "U", "key": 0 }
```

## Màn hình 320x240 / 240x320 / custom

Dev truyền width/height khi tạo instance:

```txt
width=320 height=240  # landscape
width=240 height=320  # portrait
width=176 height=208  # old Nokia
```

Bridge xuất config qua WS:

```json
{ "type":"config", "width":320, "height":240, "videoCodec":"rgb565" }
```

Dev tự CSS scale canvas theo ý họ.

## Save riêng

Save nằm theo:

```txt
freej2me_data/external/<externalUserId>/games/<gameHash>/runtime
```

Nếu dev truyền cùng `externalUserId` + cùng JAR thì save sẽ dùng lại.
Nếu user khác hoặc game khác thì save tách riêng.

## Lưu ý về `headless-core-server.js`

File này hiện là bản reference dựa trên server bridge mới nhất đã chạy ổn, có sẵn UI fallback.
Khi dùng cho hệ thống khác, dev có thể:

1. Chạy server này như service riêng.
2. Không dùng route `/` UI mặc định.
3. Tích hợp qua REST/WebSocket theo `docs/PROTOCOL.md` hoặc dùng iframe nếu muốn nhanh.

Nếu muốn bản core thuần không route UI, có thể tách class `EmulatorSession` và các route upload/ws từ file này.

### Headless API đã có sẵn

`headless-core-server.js` có sẵn:

```txt
POST   /api/instances
GET    /api/instances/:id
DELETE /api/instances/:id
WS     /ws/:instanceId
```

Lưu ý bản đầu này dùng runtime config theo process cho width/height. Nếu cần mỗi instance một màn hình khác nhau cùng lúc, chạy nhiều core service trên port khác nhau hoặc tách per-instance config sâu hơn trong `EmulatorSession`.
