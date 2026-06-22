# Headless Core Protocol V21

## REST create instance

`POST /api/instances` multipart/form-data, optional `X-Bridge-Token`.

Fields:

```txt
jar required
externalUserId required
width height rotate phoneType fps maxFps sound audioPipe
streamScale imageQuality videoCodec webpQuality webpEffort wsCompression
audioCodec opusBitrate
```

Video codecs:

```txt
rgba   raw RGBA
rgb565 raw RGB565 little endian
rgb332 raw RGB332
webp   WebP image frame, requires npm install sharp
```

Audio:

```txt
opus   HTTP /audio/:sessionId.webm, requires ffmpeg
pcm    WebSocket FJ2A PCM fallback
```

## WebSocket

`/ws/:instanceId?token=...`

Server text:

```json
{ "type":"config", "width":320, "height":240, "videoCodec":"webp", "webpQuality":48 }
{ "type":"auth", "gameHash":"...", "audioUrl":"/audio/s_xxx.webm", "audioCodec":"opus" }
```

Server binary:

- if starts `FJ2A`: audio PCM fallback packet
- otherwise: video frame according to `videoCodec`

Client text input:

```json
{ "type":"key", "state":"D", "key":0 }
{ "type":"key", "state":"U", "key":0 }
{ "type":"touch", "state":"D", "x":10, "y":10 }
```
