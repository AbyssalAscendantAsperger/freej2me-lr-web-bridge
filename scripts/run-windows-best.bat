@echo off
REM Best practical Windows config. Put ffmpeg.exe in .\tools\ffmpeg.exe
REM Optional: npm install sharp

set AUDIO_PIPE=1
set SOUND=1
set AUDIO_CODEC=opus
set OPUS_BITRATE=64k
set FFMPEG_PATH=%~dp0..\tools\ffmpeg.exe

REM WebP needs: npm install sharp
REM If CPU high or sharp missing, change VIDEO_CODEC=rgb565
set VIDEO_CODEC=webp
set WEBP_QUALITY=55
set WEBP_EFFORT=0
set STREAM_SCALE=1
set TARGET_FPS=30
set MAX_FPS=24
set WS_COMPRESSION=0
set AUDIO_PACKET_MS=60

node -e "require('sharp')" >nul 2>nul
if errorlevel 1 (
  echo sharp is not installed. Installing sharp...
  npm install sharp
)

npm start
