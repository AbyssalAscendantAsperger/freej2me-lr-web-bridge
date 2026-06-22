# Headless Core Protocol

## Auth

Optional header:

```http
X-Bridge-Token: <BRIDGE_TOKEN>
```

Nếu env `BRIDGE_TOKEN` rỗng thì không kiểm tra token.

## REST

### Create instance

`POST /api/instances` multipart/form-data

Fields:

| field | required | default | description |
|---|---:|---|---|
| jar | yes | | JAR/JAD file |
| externalUserId | yes | | ID user do web/app của dev quản lý |
| width | no | 240 | LCD width |
| height | no | 320 | LCD height |
| rotate | no | 0 | 0/1/2/3 |
| phoneType | no | 0 | FreeJ2ME phone type |
| fps | no | 30 | emulator target fps |
| maxFps | no | 30 | stream fps |
| sound | no | 1 | enable game sound |
| audioPipe | no | 1 | enable FJ2A audio pipe |
| streamScale | no | 1 | 1 full, 2 half |
| videoCodec | no | rgb565 | rgba/rgb565/rgb332 |
| imageQuality | no | 65 | used if videoCodec omitted |

Returns:

```json
{
  "success": true,
  "instanceId": "i_...",
  "gameHash": "sha1...",
  "wsPath": "/ws/i_...",
  "dataDir": "..."
}
```

### Delete instance

`DELETE /api/instances/:id`

### Status

`GET /api/instances/:id`

## WebSocket

Connect:

```txt
/ws/<instanceId>?token=<BRIDGE_TOKEN>
```

### Server -> client text

```json
{ "type":"config", "width":320, "height":240, "videoCodec":"rgb565", "imageQuality":65, "scale":1 }
{ "type":"audio-status", "format": { "sampleRate":44100, "channels":2, "bits":16 } }
{ "type":"status", "state":"running" }
```

### Server -> client binary

If starts with `FJ2A`, it is audio packet.
Otherwise it is video frame in codec from config.

Video codecs:

- `rgba`: width*height*4 bytes
- `rgb565`: width*height*2 bytes little-endian
- `rgb332`: width*height bytes

Audio packets:

- `FJ2A` type 1: format
- `FJ2A` type 2: PCM data

### Client -> server text

Key input:

```json
{ "type":"key", "state":"D", "key":0 }
{ "type":"key", "state":"U", "key":0 }
```

Touch:

```json
{ "type":"touch", "state":"D", "x":10, "y":10 }
{ "type":"touch", "state":"M", "x":12, "y":12 }
{ "type":"touch", "state":"U", "x":12, "y":12 }
```

Key index layout FreeJ2ME/libretro:

```txt
0 Up
1 Down
2 Left
3 Right
4 Num9
5 Num7
6 Num0
7 Fire
8 RightSoft
9 LeftSoft
10 Num1
11 Num3
12 *
13 #
14 Num2
15 Num4
16 Num6
17 Num8
18 Num5
19 Clear
```

## V17 session behavior

For the same `externalUserId`, creating a new instance stops older emulator sessions of that user before starting the new one. This prevents stale frames from an old JAR mixing with the new JAR.

If you want multiple games running concurrently for the same user, use different `externalUserId` values, for example:

```txt
user_123_slot_1
user_123_slot_2
```

## Per-instance screen/options

The headless server accepts screen/options in `POST /api/instances` and applies them to that emulator process:

```txt
width, height, rotate, phoneType, fps, maxFps, sound, audioPipe,
streamScale, imageQuality, videoCodec, wsCompression
```
