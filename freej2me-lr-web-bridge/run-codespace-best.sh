#!/usr/bin/env bash
set -e

# Best practical config for GitHub Codespaces / remote tunnels.
# Install deps once if needed:
#   sudo apt update && sudo apt install -y openjdk-11-jre-headless ffmpeg
#   npm install sharp

if [ -d /usr/lib/jvm/java-11-openjdk-amd64 ]; then
  export JAVA_HOME=/usr/lib/jvm/java-11-openjdk-amd64
  export JAVA_PATH=$JAVA_HOME
fi

# Optional sharp install check. Comment out if you want no auto install.
node -e "require('sharp')" >/dev/null 2>&1 || npm install sharp

export AUDIO_PIPE=1
export SOUND=1
export AUDIO_CODEC=opus
export OPUS_BITRATE=${OPUS_BITRATE:-64k}
export FFMPEG_PATH=${FFMPEG_PATH:-ffmpeg}

# WebP: best bandwidth through Codespaces. If CPU too high, switch VIDEO_CODEC=rgb565 STREAM_SCALE=2.
export VIDEO_CODEC=${VIDEO_CODEC:-webp}
export WEBP_QUALITY=${WEBP_QUALITY:-48}
export WEBP_EFFORT=${WEBP_EFFORT:-0}
export STREAM_SCALE=${STREAM_SCALE:-1}
export TARGET_FPS=${TARGET_FPS:-30}
export MAX_FPS=${MAX_FPS:-20}
export WS_COMPRESSION=${WS_COMPRESSION:-0}
export AUDIO_PACKET_MS=${AUDIO_PACKET_MS:-60}
export MAX_UPLOAD_MB=${MAX_UPLOAD_MB:-30}
export MAX_USER_STORAGE_MB=${MAX_USER_STORAGE_MB:-300}
export UPLOAD_RETENTION_HOURS=${UPLOAD_RETENTION_HOURS:-12}
export NO_CLIENT_SHUTDOWN_MS=${NO_CLIENT_SHUTDOWN_MS:-5000}

npm start
