# FreeJ2ME Web Bridge API

## Auth

- `POST /api/register` JSON `{ "username": "abc", "password": "1234" }`
- `POST /api/login` JSON `{ "username": "abc", "password": "1234" }`
- `POST /api/logout` JSON `{}`
- `GET /api/me` returns `{ user }`

Login sets cookie `fj2me_sid`. Same-origin or reverse-proxy is recommended.

## Upload game

- `POST /upload` multipart form field `jar`

Returns:

```json
{
  "success": true,
  "gameHash": "sha1...",
  "dataDir": "...freej2me_data/users/<user>/games/<hash>/runtime"
}
```

## WebSocket

Connect to server root WebSocket. Binary messages are video or audio.

Text messages server -> client:

- `config`: `{ width, height, scale, videoCodec, imageQuality }`
- `auth`: `{ user, gameHash }` or `{ noGame: true }`
- `audio-status`

Text messages client -> server:

```json
{ "type": "key", "state": "D", "key": 0 }
{ "type": "key", "state": "U", "key": 0 }
{ "type": "touch", "state": "D", "x": 10, "y": 10 }
```

## Video binary codecs

Server config sends `videoCodec`:

- `rgba`: 4 bytes per pixel RGBA
- `rgb565`: 2 bytes per pixel, little-endian RGB565
- `rgb332`: 1 byte per pixel RGB332

Client should use `width * height` from `config` to decode.

## Audio binary packets

Audio packets start with magic `FJ2A`.

- Format packet: `FJ2A` + type `1` + sampleRate uint32BE + channels + bits + signed + bigEndian
- PCM packet: `FJ2A` + type `2` + length uint32BE + PCM bytes
