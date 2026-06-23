#!/usr/bin/env bash
set -e

# Auto profile runner:
# - local  : ưu tiên độ mượt trên localhost:3000
# - remote : ưu tiên băng thông cho Codespaces / tunnel
# Có thể override bằng env trước khi chạy, ví dụ:
#   TRANSPORT_PROFILE=remote VIDEO_CODEC=webp ./run-codespace-best.sh

if [ -d /usr/lib/jvm/java-11-openjdk-amd64 ]; then
  export JAVA_HOME=/usr/lib/jvm/java-11-openjdk-amd64
  export JAVA_PATH=$JAVA_HOME
fi

if [ -n "$CODESPACES" ] || [ -n "$GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN" ] || [ -n "$GITPOD_WORKSPACE_ID" ]; then
  export TRANSPORT_PROFILE=${TRANSPORT_PROFILE:-remote}
else
  export TRANSPORT_PROFILE=${TRANSPORT_PROFILE:-local}
fi

# Optional sharp install check. Comment out if you want no auto install.
node -e "require('sharp')" >/dev/null 2>&1 || npm install sharp

export AUDIO_PIPE=${AUDIO_PIPE:-1}
export SOUND=${SOUND:-1}
export TARGET_FPS=${TARGET_FPS:-30}
export WS_COMPRESSION=${WS_COMPRESSION:-0}
export MAX_UPLOAD_MB=${MAX_UPLOAD_MB:-30}
export MAX_USER_STORAGE_MB=${MAX_USER_STORAGE_MB:-300}
export UPLOAD_RETENTION_HOURS=${UPLOAD_RETENTION_HOURS:-12}
export NO_CLIENT_SHUTDOWN_MS=${NO_CLIENT_SHUTDOWN_MS:-5000}
export AUDIO_ADAPTIVE_BUFFER=${AUDIO_ADAPTIVE_BUFFER:-1}
export ADAPTIVE_STREAMING=${ADAPTIVE_STREAMING:-1}
export ADAPTIVE_LEVELS=${ADAPTIVE_LEVELS:-100}
export ADAPTIVE_WINDOW_MS=${ADAPTIVE_WINDOW_MS:-1000}
export ADAPTIVE_RECOVER_WINDOWS=${ADAPTIVE_RECOVER_WINDOWS:-3}

if command -v ffmpeg >/dev/null 2>&1; then
  export FFMPEG_PATH=${FFMPEG_PATH:-ffmpeg}
  export AUDIO_CODEC=${AUDIO_CODEC:-opus}
else
  export AUDIO_CODEC=${AUDIO_CODEC:-pcm}
fi

if [ "$TRANSPORT_PROFILE" = "remote" ]; then
  export VIDEO_CODEC=${VIDEO_CODEC:-webp}
  export WEBP_QUALITY=${WEBP_QUALITY:-48}
  export WEBP_EFFORT=${WEBP_EFFORT:-0}
  export STREAM_SCALE=${STREAM_SCALE:-1}
  export MAX_FPS=${MAX_FPS:-20}
  export AUDIO_PACKET_MS=${AUDIO_PACKET_MS:-60}
  export AUDIO_START_BUFFER_MS=${AUDIO_START_BUFFER_MS:-180}
  export CLIENT_AUDIO_MIN_BUFFER_MS=${CLIENT_AUDIO_MIN_BUFFER_MS:-120}
  export CLIENT_AUDIO_MAX_BUFFER_MS=${CLIENT_AUDIO_MAX_BUFFER_MS:-420}
  export OPUS_BITRATE=${OPUS_BITRATE:-64k}
else
  # localhost / LAN same-machine: ưu tiên giảm CPU decode + giữ audio ổn định
  export VIDEO_CODEC=${VIDEO_CODEC:-rgb565}
  export STREAM_SCALE=${STREAM_SCALE:-1}
  export MAX_FPS=${MAX_FPS:-30}
  export AUDIO_PACKET_MS=${AUDIO_PACKET_MS:-40}
  export AUDIO_START_BUFFER_MS=${AUDIO_START_BUFFER_MS:-110}
  export CLIENT_AUDIO_MIN_BUFFER_MS=${CLIENT_AUDIO_MIN_BUFFER_MS:-70}
  export CLIENT_AUDIO_MAX_BUFFER_MS=${CLIENT_AUDIO_MAX_BUFFER_MS:-260}
  export OPUS_BITRATE=${OPUS_BITRATE:-96k}
fi

echo [run] TRANSPORT_PROFILE=$TRANSPORT_PROFILE ADAPTIVE_STREAMING=$ADAPTIVE_STREAMING ADAPTIVE_LEVELS=$ADAPTIVE_LEVELS VIDEO_CODEC=$VIDEO_CODEC AUDIO_CODEC=$AUDIO_CODEC MAX_FPS=$MAX_FPS AUDIO_PACKET_MS=$AUDIO_PACKET_MS
node server.js
