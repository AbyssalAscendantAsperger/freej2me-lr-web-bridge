/******************************************************************************
 * FreeJ2ME-Plus Web Bridge - V10 Multi-user Login + Per-user Save + Performance
 *
 * V10 includes:
 * - V9-style performance: per-client latest-frame rendering patch, lower logging,
 *   per-session backpressure dropping, no duplicate frame skipping by default.
 * - JSON DB login/register/logout.
 * - One emulator process per logged-in user/game session.
 * - Per-user/per-game dataDir: freej2me_data/users/<userId>/games/<sha1>/runtime
 * - AudioPipe v2/v2-debug support through stderr FJ2A packets.
 *
 * Drop this file over server.js.
 *****************************************************************************/

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const http = require('http');
const net = require('net');
const WebSocket = require('ws');
let OpusScript = null;
try { OpusScript = require('opusscript'); } catch (e) { /* optional */ }
let sharp = null;
try { sharp = require('sharp'); } catch (e) { /* optional: VIDEO_CODEC=webp will fallback if missing */ }
let helmet = null, cors = null, expressRateLimit = null, systeminformation = null;
try { helmet = require('helmet'); } catch(e) {}
try { cors = require('cors'); } catch(e) {}
try { expressRateLimit = require('express-rate-limit'); } catch(e) {}
try { systeminformation = require('systeminformation'); } catch(e) {}

// =================== CONFIG ===================
function loadConfig() {
  const configPath = path.join(__dirname, 'config.json');
  let fileConfig = {};
  if (fs.existsSync(configPath)) {
    try { fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8')); }
    catch (e) { console.warn('[Config] Lỗi đọc config.json:', e.message); }
  }

  function resolvePath(p) {
    if (!p) return null;
    if (path.isAbsolute(p)) return p;
    return path.resolve(__dirname, p);
  }

  function isGitLfsPointerFile(filePath) {
    try {
      if (!filePath || !fs.existsSync(filePath)) return false;
      const st = fs.statSync(filePath);
      if (!st.isFile() || st.size > 1024) return false;
      const head = fs.readFileSync(filePath, 'utf8').slice(0, 200);
      return head.includes('git-lfs.github.com/spec');
    } catch (e) {
      return false;
    }
  }

  function pickExistingJar(candidates) {
    const existing = [];
    for (const candidate of candidates) {
      try {
        if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) existing.push(candidate);
      } catch (e) {}
    }
    if (!existing.length) return null;
    const actual = existing.find(candidate => !isGitLfsPointerFile(candidate));
    return actual || existing[0];
  }

  function resolveFreej2meJar(p) {
    const sharedCandidates = [
      'freej2me-lr.jar',
      'freej2me-lr-shared.jar',
      'freej2me-lr-server.jar',
    ];
    const audioCandidates = [
      'freej2me-lr-audiopipe-v2-debug.jar',
      'freej2me-lr-audiopipe-v2.jar',
      'freej2me-lr-audiopipe.jar',
      'freej2me-lr-audiopipe-v1.jar',
    ];
    const allCandidates = [...sharedCandidates, ...audioCandidates];
    const resolved = resolvePath(p);
    if (!resolved) return path.resolve(__dirname, './freej2me-lr.jar');
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        const picked = pickExistingJar(allCandidates.map(name => path.join(resolved, name)));
        if (picked) return picked;
        return path.join(resolved, 'freej2me-lr.jar');
      }

      const dir = path.dirname(resolved);
      const base = path.basename(resolved);
      const siblingCandidates = [resolved, ...allCandidates.filter(name => name !== base).map(name => path.join(dir, name))];
      const picked = pickExistingJar(siblingCandidates);
      if (picked) return picked;
    } catch (e) {}
    return resolved;
  }

  function intConfig(envName, fileValue, fallback) {
    const envValue = process.env[envName];
    if (envValue !== undefined && envValue !== '') {
      const n = parseInt(envValue, 10);
      if (!Number.isNaN(n)) return n;
    }
    if (fileValue !== undefined && fileValue !== null && fileValue !== '') {
      const n = parseInt(fileValue, 10);
      if (!Number.isNaN(n)) return n;
    }
    return fallback;
  }

  function boolConfig(envName, fileValue, fallback) {
    const envValue = process.env[envName];
    const v = envValue !== undefined ? envValue : fileValue;
    if (v === undefined || v === null || v === '') return fallback;
    return String(v) !== '0' && String(v).toLowerCase() !== 'false';
  }

  function normalizeJavaCandidate(candidate) {
    if (!candidate) return null;
    const resolved = resolvePath(candidate);
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        const exe = process.platform === 'win32' ? 'java.exe' : 'java';
        const inBin = path.join(resolved, 'bin', exe);
        if (fs.existsSync(inBin)) return inBin;
        const direct = path.join(resolved, exe);
        if (fs.existsSync(direct)) return direct;
      }
    } catch (e) {}
    return resolved;
  }

  function findJavaInPath() {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    try {
      const r = spawnSync(cmd, ['java'], { encoding: 'utf8', windowsHide: true });
      if (r.status === 0 && r.stdout) {
        const first = r.stdout.split(/\r?\n/).map(x => x.trim()).filter(Boolean)[0];
        if (first) return first;
      }
    } catch (e) {}
    return process.platform === 'win32' ? 'java.exe' : 'java';
  }

  function resolveJavaPath() {
    // Priority:
    // 1. JAVA_PATH env: can be executable OR JDK/JRE home directory.
    // 2. config.json javaPath: can be executable OR JDK/JRE home directory.
    // 3. JAVA_HOME env.
    // 4. PATH lookup (which java / where java).
    const envJava = normalizeJavaCandidate(process.env.JAVA_PATH);
    if (envJava) return envJava;

    const configured = normalizeJavaCandidate(fileConfig.javaPath);
    if (configured) {
      // Linux cannot run bundled Windows java.exe. Fall through to JAVA_HOME/PATH.
      if (!(process.platform !== 'win32' && configured.toLowerCase().endsWith('.exe'))) return configured;
    }

    const javaHome = normalizeJavaCandidate(process.env.JAVA_HOME);
    if (javaHome) return javaHome;

    return findJavaInPath();
  }

  function resolveTransportProfile() {
    const raw = String(process.env.TRANSPORT_PROFILE || fileConfig.transportProfile || 'auto').toLowerCase();
    if (raw === 'auto') {
      if (process.env.CODESPACES || process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || process.env.GITPOD_WORKSPACE_ID || process.env.RENDER || process.env.RAILWAY_ENVIRONMENT) return 'remote';
      return 'local';
    }
    if (raw === 'remote' || raw === 'balanced' || raw === 'local') return raw;
    return 'local';
  }

  const transportProfile = resolveTransportProfile();
  const profileDefaults = {
    local: {
      targetFps: 30,
      maxFps: 30,
      streamScale: 1,
      imageQuality: 100,
      videoCodec: 'webp',
      webpQuality: 100,
      audioPacketMs: 40,
      audioStartBufferMs: 110,
      audioMinBufferMs: 70,
      audioMaxBufferMs: 260,
      audioCodec: 'opus',
      opusBitrate: '96k',
      wsCompression: false,
    },
    balanced: {
      targetFps: 30,
      maxFps: 24,
      streamScale: 1,
      imageQuality: 90,
      videoCodec: 'webp',
      webpQuality: 90,
      audioPacketMs: 50,
      audioStartBufferMs: 140,
      audioMinBufferMs: 90,
      audioMaxBufferMs: 320,
      audioCodec: 'opus',
      opusBitrate: '80k',
      wsCompression: false,
    },
    remote: {
      targetFps: 30,
      maxFps: 20,
      streamScale: 1,
      imageQuality: 80,
      videoCodec: 'webp',
      webpQuality: 80,
      audioPacketMs: 60,
      audioStartBufferMs: 180,
      audioMinBufferMs: 120,
      audioMaxBufferMs: 420,
      audioCodec: 'opus',
      opusBitrate: '64k',
      wsCompression: false,
    },
  };
  const profile = profileDefaults[transportProfile] || profileDefaults.local;
  const targetFps = intConfig('TARGET_FPS', fileConfig.targetFps ?? fileConfig.maxFps, profile.targetFps);

  return {
    javaPath: resolveJavaPath(),
    freej2meJar: process.env.FREEJ2ME_LR_JAR ? resolveFreej2meJar(process.env.FREEJ2ME_LR_JAR) : resolveFreej2meJar(fileConfig.freej2meJar),
    transportProfile,
    port: intConfig('PORT', fileConfig.port, 3000),

    width: intConfig('SCREEN_WIDTH', fileConfig.width, 240),
    height: intConfig('SCREEN_HEIGHT', fileConfig.height, 320),
    rotate: intConfig('ROTATE', fileConfig.rotate, 0),
    phoneType: intConfig('PHONE_TYPE', fileConfig.phoneType, 0),
    fps: intConfig('FPS', undefined, targetFps),
    sound: intConfig('SOUND', fileConfig.sound, 1),

    maxFps: intConfig('MAX_FPS', fileConfig.maxFps, profile.maxFps),
    streamScale: Math.max(1, intConfig('STREAM_SCALE', fileConfig.streamScale, profile.streamScale)),
    // V15 video compression without native deps:
    // IMAGE_QUALITY >= 90 => rgba 32-bit, >= 45 => rgb565 16-bit, <45 => rgb332 8-bit.
    // Or set VIDEO_CODEC=rgba|rgb565|rgb332 explicitly.
    imageQuality: Math.max(1, Math.min(100, intConfig('IMAGE_QUALITY', fileConfig.imageQuality, profile.imageQuality))),
    videoCodec: String(process.env.VIDEO_CODEC || fileConfig.videoCodec || profile.videoCodec).toLowerCase(),
    webpQuality: Math.max(1, Math.min(100, intConfig('WEBP_QUALITY', fileConfig.webpQuality, profile.webpQuality))),
    webpEffort: Math.max(0, Math.min(6, intConfig('WEBP_EFFORT', fileConfig.webpEffort, 0))),
    maxWsBufferedAmount: intConfig('MAX_WS_BUFFERED', fileConfig.maxWsBufferedAmount, transportProfile === 'local' ? 1024 * 1024 : 512 * 1024),
    wsCompression: boolConfig('WS_COMPRESSION', fileConfig.wsCompression, profile.wsCompression),
    audioPipe: boolConfig('AUDIO_PIPE', fileConfig.audioPipe, true),
    audioAdaptiveBuffer: boolConfig('AUDIO_ADAPTIVE_BUFFER', fileConfig.audioAdaptiveBuffer, true),

    frameResyncLog: boolConfig('FRAME_RESYNC_LOG', fileConfig.frameResyncLog, false),
    audioDebugLog: boolConfig('AUDIO_DEBUG_LOG', fileConfig.audioDebugLog, false),
    // V24: gom PCM audio thành packet lớn hơn để giảm WebSocket overhead và jitter.
    audioPacketMs: Math.max(10, Math.min(120, intConfig('AUDIO_PACKET_MS', fileConfig.audioPacketMs, profile.audioPacketMs))),
    audioStartBufferMs: Math.max(40, Math.min(500, intConfig('AUDIO_START_BUFFER_MS', fileConfig.audioStartBufferMs, profile.audioStartBufferMs))),
    clientAudioMinBufferMs: Math.max(40, Math.min(500, intConfig('CLIENT_AUDIO_MIN_BUFFER_MS', fileConfig.clientAudioMinBufferMs, profile.audioMinBufferMs))),
    clientAudioMaxBufferMs: Math.max(80, Math.min(1000, intConfig('CLIENT_AUDIO_MAX_BUFFER_MS', fileConfig.clientAudioMaxBufferMs, profile.audioMaxBufferMs))),
    // Opus over websocket via opusscript (no external ffmpeg dependency).
    audioCodec: String(process.env.AUDIO_CODEC || fileConfig.audioCodec || profile.audioCodec).toLowerCase(),
    opusBitrate: String(process.env.OPUS_BITRATE || fileConfig.opusBitrate || profile.opusBitrate),
    adaptiveStreaming: boolConfig('ADAPTIVE_STREAMING', fileConfig.adaptiveStreaming, true),
    adaptiveLevels: Math.max(12, Math.min(100, intConfig('ADAPTIVE_LEVELS', fileConfig.adaptiveLevels, 100))),
    adaptiveWindowMs: Math.max(400, Math.min(5000, intConfig('ADAPTIVE_WINDOW_MS', fileConfig.adaptiveWindowMs, 1000))),
    adaptiveRecoverWindows: Math.max(2, Math.min(10, intConfig('ADAPTIVE_RECOVER_WINDOWS', fileConfig.adaptiveRecoverWindows, 3))),
    javaBackendHost: process.env.JAVA_BACKEND_HOST || fileConfig.javaBackendHost || '127.0.0.1',
    javaBackendPort: intConfig('JAVA_BACKEND_PORT', fileConfig.javaBackendPort, 35555),
    javaBackendRestartDelayMs: intConfig('JAVA_BACKEND_RESTART_DELAY_MS', fileConfig.javaBackendRestartDelayMs, 1500),
    javaBackendHandshakeTimeoutMs: intConfig('JAVA_BACKEND_HANDSHAKE_TIMEOUT_MS', fileConfig.javaBackendHandshakeTimeoutMs, 10000),

    maxActiveSessions: intConfig('MAX_ACTIVE_SESSIONS', fileConfig.maxActiveSessions, 8),
    sessionIdleMs: intConfig('SESSION_IDLE_MS', fileConfig.sessionIdleMs, 10 * 60 * 1000),
    noClientShutdownMs: intConfig('NO_CLIENT_SHUTDOWN_MS', fileConfig.noClientShutdownMs, 5000),
    inputIdleShutdownMs: intConfig('INPUT_IDLE_SHUTDOWN_MS', fileConfig.inputIdleShutdownMs, 0),

    // V23 security/resource guard defaults. Safe for public demo; devs can tune by env/config.
    sessionPolicy: String(process.env.SESSION_POLICY || fileConfig.sessionPolicy || 'single').toLowerCase(), // single|multi
    requireLogin: boolConfig('REQUIRE_LOGIN', fileConfig.requireLogin, true),
    maxAccountsPerIp: intConfig('MAX_ACCOUNTS_PER_IP', fileConfig.maxAccountsPerIp, 5),
    maxWsPerIp: intConfig('MAX_WS_PER_IP', fileConfig.maxWsPerIp, 8),
    maxClientsPerInstance: intConfig('MAX_CLIENTS_PER_INSTANCE', fileConfig.maxClientsPerInstance, 2),
    queueMaxSize: intConfig('QUEUE_MAX_SIZE', fileConfig.queueMaxSize, 16),
    startConcurrency: intConfig('START_CONCURRENCY', fileConfig.startConcurrency, Math.max(1, Math.min(2, Math.floor(require('os').cpus().length / 2)))),
    authRateLimit: intConfig('AUTH_RATE_LIMIT', fileConfig.authRateLimit, 20),
    uploadRateLimit: intConfig('UPLOAD_RATE_LIMIT', fileConfig.uploadRateLimit, 6),
    apiRateLimit: intConfig('API_RATE_LIMIT', fileConfig.apiRateLimit, 180),
    wsRateLimit: intConfig('WS_RATE_LIMIT', fileConfig.wsRateLimit, 60),
    rateLimitWindowMs: intConfig('RATE_LIMIT_WINDOW_MS', fileConfig.rateLimitWindowMs, 60 * 1000),
    corsOrigin: process.env.CORS_ORIGIN || fileConfig.corsOrigin || '',

    // V24 storage/quota cleanup.
    maxUploadMb: intConfig('MAX_UPLOAD_MB', fileConfig.maxUploadMb, 50),
    maxUserStorageMb: intConfig('MAX_USER_STORAGE_MB', fileConfig.maxUserStorageMb, 500),
    maxTotalStorageMb: intConfig('MAX_TOTAL_STORAGE_MB', fileConfig.maxTotalStorageMb, 0), // 0 = disabled
    uploadRetentionHours: intConfig('UPLOAD_RETENTION_HOURS', fileConfig.uploadRetentionHours, 24),
    tempRetentionHours: intConfig('TEMP_RETENTION_HOURS', fileConfig.tempRetentionHours, 6),
    cleanupIntervalMs: intConfig('CLEANUP_INTERVAL_MS', fileConfig.cleanupIntervalMs, 10 * 60 * 1000),

    uploadsDir: process.env.UPLOADS_DIR || path.join(__dirname, 'uploads'),
    dataDir: process.env.DATA_DIR || path.join(__dirname, 'freej2me_data'),
    dbPath: process.env.DB_PATH || path.join(__dirname, 'freej2me_data', 'users.json'),
  };
}

const CONFIG = loadConfig();
function clampNumber(v, min, max) { return Math.max(min, Math.min(max, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function roundStep(v, step) { return Math.round(v / step) * step; }
if (CONFIG.clientAudioMaxBufferMs < CONFIG.clientAudioMinBufferMs) CONFIG.clientAudioMaxBufferMs = CONFIG.clientAudioMinBufferMs;
if (!['rgba', 'rgb565', 'rgb332', 'webp'].includes(CONFIG.videoCodec)) {
  CONFIG.videoCodec = CONFIG.imageQuality >= 90 ? 'rgba' : (CONFIG.imageQuality >= 45 ? 'rgb565' : 'rgb332');
}
if (CONFIG.videoCodec === 'webp' && !sharp) {
  console.warn('[Video] VIDEO_CODEC=webp nhưng sharp chưa cài được. Fallback rgb565. Chạy: npm install sharp');
  CONFIG.videoCodec = 'rgb565';
}
function probeOpusScriptAvailability() {
  if (!OpusScript) return { available: false, reason: 'module-missing' };
  try {
    return { available: true, reason: 'ok' };
  } catch (e) {
    return { available: false, reason: e.message || 'exception' };
  }
}
function buildAdaptiveProfiles() {
  const count = CONFIG.adaptiveLevels;
  const profiles = [];
  const webpSupported = !!sharp;
  for (let i = 0; i < count; i++) {
    const t = count <= 1 ? 0 : (i / (count - 1));
    const quality = clampNumber(100 - i, 1, 100);
    const maxFps = clampNumber(Math.round(lerp(Math.max(24, CONFIG.maxFps), 14, t)), 14, 60);
    const audioPacketMs = clampNumber(Math.round(lerp(20, 60, t) / 2) * 2, 10, 120);
    const audioStartBufferMs = clampNumber(Math.round(lerp(70, 220, t)), 40, 500);
    const clientAudioMinBufferMs = clampNumber(Math.round(lerp(50, 150, t)), 40, 500);
    const clientAudioMaxBufferMs = clampNumber(Math.round(lerp(140, 420, t)), clientAudioMinBufferMs, 1000);
    const maxWsBufferedAmount = clampNumber(Math.round(lerp(1536 * 1024, 320 * 1024, t)), 128 * 1024, 2 * 1024 * 1024);
    const opusKbps = clampNumber(Math.round(lerp(96, 32, t) / 4) * 4, 32, 128);
    profiles.push({
      level: i,
      label: `Q${quality}`,
      severity: t,
      videoCodec: webpSupported ? 'webp' : 'rgb565',
      imageQuality: quality,
      webpQuality: quality,
      streamScale: 1,
      maxFps,
      audioCodec: OPUS_PROBE.available ? 'opus' : 'pcm',
      opusBitrate: `${opusKbps}k`,
      audioPacketMs,
      audioStartBufferMs,
      clientAudioMinBufferMs,
      clientAudioMaxBufferMs,
      maxWsBufferedAmount,
      wsCompression: false,
    });
  }
  return profiles;
}
const OPUS_PROBE = probeOpusScriptAvailability();
const ADAPTIVE_PROFILES = buildAdaptiveProfiles();
const AUDIO_MAGIC = Buffer.from('FJ2A');
const AUDIO_TYPE_OPUS_FORMAT = 3;
const AUDIO_TYPE_OPUS_PACKET = 4;
const SERVER_LOCK_PATH = path.join(CONFIG.dataDir, `server-${CONFIG.port}.lock.json`);
let wss = null;
let javaBackend = null;
const emulatorSessions = new Map(); // key userId:gameHash -> EmulatorSession
const publicSessionIds = new Map(); // publicId -> EmulatorSession for /audio/:id.webm
const userSessionLocks = new Map();

// =================== UTILS ===================
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function now() { return Date.now(); }
function randomId(prefix = '') { return prefix + crypto.randomBytes(16).toString('hex'); }
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function safeName(s) { return String(s || '').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80); }
function sha1File(filePath) { return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex'); }
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}
function getIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket && req.socket.remoteAddress || 'unknown';
}

const memoryBuckets = new Map();
function memoryRateLimit(key, limit, windowMs) {
  const t = now();
  let b = memoryBuckets.get(key);
  if (!b || t >= b.resetAt) { b = { count: 0, resetAt: t + windowMs }; memoryBuckets.set(key, b); }
  b.count++;
  return { ok: b.count <= limit, count: b.count, resetAt: b.resetAt, retryAfterMs: Math.max(0, b.resetAt - t) };
}
function rateLimitMiddleware(name, limitGetter) {
  return (req, res, next) => {
    const limit = typeof limitGetter === 'function' ? limitGetter(req) : limitGetter;
    const ip = getIp(req);
    const r = memoryRateLimit(`${name}:${ip}`, limit, CONFIG.rateLimitWindowMs);
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - r.count)));
    if (!r.ok) return res.status(429).json({ error: 'rate_limited', retryAfterMs: r.retryAfterMs });
    next();
  };
}

function countOpenWsForIp(ip) {
  if (!wss) return 0;
  let n = 0;
  wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN && ws._ip === ip) n++; });
  return n;
}
async function withUserSessionLock(userId, task) {
  const key = String(userId || '');
  const prev = userSessionLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const chain = prev.then(() => gate);
  userSessionLocks.set(key, chain);
  await prev;
  try { return await task(); }
  finally {
    release();
    if (userSessionLocks.get(key) === chain) userSessionLocks.delete(key);
  }
}
function closeUserSockets(userId, reason = 'session_invalidated') {
  if (!wss) return;
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN && ws._userId === userId) {
      try { ws.send(JSON.stringify({ type: 'error', error: reason })); } catch(e) {}
      try { ws.close(); } catch(e) {}
    }
  });
}

class StartQueue {
  constructor(concurrency, maxSize) { this.concurrency = concurrency; this.maxSize = maxSize; this.running = 0; this.queue = []; }
  add(task) {
    if (this.queue.length + this.running >= this.maxSize) return Promise.reject(new Error('Server queue đầy, thử lại sau'));
    return new Promise((resolve, reject) => { this.queue.push({ task, resolve, reject }); this.pump(); });
  }
  pump() {
    while (this.running < this.concurrency && this.queue.length) {
      const item = this.queue.shift(); this.running++;
      Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => { this.running--; this.pump(); });
    }
  }
  status() { return { running: this.running, queued: this.queue.length, concurrency: this.concurrency, maxSize: this.maxSize }; }
}
const startQueue = new StartQueue(CONFIG.startConcurrency, CONFIG.queueMaxSize);

function dirSizeBytes(dir) {
  let total = 0;
  try {
    if (!fs.existsSync(dir)) return 0;
    const st = fs.statSync(dir);
    if (st.isFile()) return st.size;
    for (const name of fs.readdirSync(dir)) total += dirSizeBytes(path.join(dir, name));
  } catch (e) {}
  return total;
}
function removePathSafe(p) {
  try {
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch (e) { console.warn('[Cleanup] remove failed', p, e.message); return false; }
}
function cleanupUploads() {
  const cutoff = now() - CONFIG.uploadRetentionHours * 3600 * 1000;
  let removed = 0, bytes = 0;
  try {
    if (!fs.existsSync(CONFIG.uploadsDir)) return { removed, bytes };
    for (const name of fs.readdirSync(CONFIG.uploadsDir)) {
      const fp = path.join(CONFIG.uploadsDir, name);
      const st = fs.statSync(fp);
      if (st.mtimeMs < cutoff) { bytes += st.isFile() ? st.size : dirSizeBytes(fp); if (removePathSafe(fp)) removed++; }
    }
  } catch (e) { console.warn('[Cleanup] uploads:', e.message); }
  if (removed) console.log(`[Cleanup] uploads removed=${removed}, bytes=${bytes}`);
  return { removed, bytes };
}
function getUserDataDir(userId) { return path.join(CONFIG.dataDir, 'users', safeName(userId)); }
function getUserStorageBytes(userId) { return dirSizeBytes(getUserDataDir(userId)); }
function enforceUserStorageQuota(userId) {
  if (!CONFIG.maxUserStorageMb || CONFIG.maxUserStorageMb <= 0) return;
  const used = getUserStorageBytes(userId);
  const max = CONFIG.maxUserStorageMb * 1024 * 1024;
  if (used > max) throw new Error(`User storage quota exceeded: ${(used/1024/1024).toFixed(1)}MB / ${CONFIG.maxUserStorageMb}MB`);
}
function enforceTotalStorageQuota() {
  if (!CONFIG.maxTotalStorageMb || CONFIG.maxTotalStorageMb <= 0) return;
  const used = dirSizeBytes(CONFIG.dataDir);
  const max = CONFIG.maxTotalStorageMb * 1024 * 1024;
  if (used > max) throw new Error(`Total storage quota exceeded: ${(used/1024/1024).toFixed(1)}MB / ${CONFIG.maxTotalStorageMb}MB`);
}
function cleanupTempRuntime() {
  // Conservative cleanup: remove obvious temp files/dirs older than TEMP_RETENTION_HOURS, never delete user save runtime root wholesale.
  const cutoff = now() - CONFIG.tempRetentionHours * 3600 * 1000;
  let removed = 0, bytes = 0;
  const candidates = ['tmp', 'temp', 'cache'];
  function walk(dir) {
    try {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        const fp = path.join(dir, name); const st = fs.statSync(fp);
        if (st.isDirectory()) {
          if (candidates.includes(name.toLowerCase()) && st.mtimeMs < cutoff) { bytes += dirSizeBytes(fp); if (removePathSafe(fp)) removed++; }
          else walk(fp);
        } else if ((name.endsWith('.tmp') || name.endsWith('.log')) && st.mtimeMs < cutoff) { bytes += st.size; if (removePathSafe(fp)) removed++; }
      }
    } catch(e) {}
  }
  walk(path.join(CONFIG.dataDir, 'users'));
  if (removed) console.log(`[Cleanup] temp removed=${removed}, bytes=${bytes}`);
  return { removed, bytes };
}
function runStorageCleanup() {
  cleanupUploads(); cleanupTempRuntime();
}


function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.maxAge) parts.push(`Max-Age=${opts.maxAge}`);
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearCookie(res, name) { res.setHeader('Set-Cookie', `${name}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`); }

function shouldCheckExecutablePath(cmd) {
  if (!cmd || cmd === 'java' || cmd === 'java.exe') return false;
  return path.isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\');
}
function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return false; }
}
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function terminateChildProcessTree(proc, label = 'child') {
  if (!proc || !proc.pid) return;
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const pid = proc.pid;
  const exited = new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(true); } };
    proc.once('exit', finish);
    proc.once('close', finish);
    setTimeout(() => { if (!done) resolve(false); }, 4500);
  });

  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      try { proc.kill('SIGTERM'); } catch (e) {}
    }
  } catch (e) {}

  const graceful = await exited;
  if (!graceful && process.platform !== 'win32') {
    try { proc.kill('SIGKILL'); } catch (e) {}
    await Promise.race([exited, wait(1000)]);
  }
  console.log(`[PROC] ${label} pid=${pid} terminated=${!isPidAlive(pid)}`);
}
function parseJavaMajor(versionText) {
  // Handles: 1.8.0_x, 8, 11, 11.0.x, 17.0.x
  const text = String(versionText || '');
  let m = text.match(/version\s+"(\d+)(?:\.(\d+))?/i);
  if (m) {
    const first = parseInt(m[1], 10);
    const second = m[2] ? parseInt(m[2], 10) : 0;
    return first === 1 ? second : first;
  }
  m = text.match(/openjdk version\s+"(\d+)/i) || text.match(/java version\s+"(\d+)/i) || text.match(/openjdk\s+(\d+)/i) || text.match(/java\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : 0;
}

function checkJavaVersion() {
  const r = spawnSync(CONFIG.javaPath, ['-version'], { encoding: 'utf8', windowsHide: true });
  const text = `${r.stdout || ''}\n${r.stderr || ''}`;
  if (r.error) throw new Error(`Không chạy được Java: ${CONFIG.javaPath} (${r.error.message})`);
  const major = parseJavaMajor(text);
  if (!major || major < 8) throw new Error(`Java version phải >= 8. Output: ${text.trim()}`);
  console.log(`[Runtime] Java version OK: ${major}`);
}

function validateRuntimePaths() {
  if (shouldCheckExecutablePath(CONFIG.javaPath) && !fs.existsSync(CONFIG.javaPath)) throw new Error(`Không tìm thấy Java executable: ${CONFIG.javaPath}`);
  checkJavaVersion();
  if (!fs.existsSync(CONFIG.freej2meJar)) throw new Error(`Không tìm thấy freej2me-lr.jar: ${CONFIG.freej2meJar}`);
  const st = fs.statSync(CONFIG.freej2meJar);
  if (st.isDirectory()) throw new Error(`freej2meJar đang trỏ tới THƯ MỤC: ${CONFIG.freej2meJar}`);
  if (st.size < 1024) {
    const head = fs.readFileSync(CONFIG.freej2meJar, 'utf8').slice(0, 80);
    if (head.includes('git-lfs.github.com/spec')) throw new Error(`File ${CONFIG.freej2meJar} đang là Git LFS pointer. Chạy git lfs pull.`);
  }
}

function acquireServerLock() {
  ensureDir(path.dirname(SERVER_LOCK_PATH));
  if (fs.existsSync(SERVER_LOCK_PATH)) {
    try {
      const old = JSON.parse(fs.readFileSync(SERVER_LOCK_PATH, 'utf8'));
      if (old && old.pid && old.pid !== process.pid && isPidAlive(old.pid)) {
        throw new Error(`Server đã chạy sẵn (pid=${old.pid}, port=${old.port || CONFIG.port}). Hãy tắt instance cũ trước khi mở instance mới.`);
      }
    } catch (e) {
      if (String(e.message || '').includes('Server đã chạy sẵn')) throw e;
    }
  }
  fs.writeFileSync(SERVER_LOCK_PATH, JSON.stringify({ pid: process.pid, port: CONFIG.port, startedAt: now(), javaPath: CONFIG.javaPath, jar: CONFIG.freej2meJar }, null, 2));
}

function releaseServerLock() {
  try {
    if (!fs.existsSync(SERVER_LOCK_PATH)) return;
    const current = JSON.parse(fs.readFileSync(SERVER_LOCK_PATH, 'utf8'));
    if (!current || !current.pid || current.pid === process.pid) fs.rmSync(SERVER_LOCK_PATH, { force: true });
  } catch (e) {}
}

let shutdownStarted = false;
async function shutdownServer(signal = 'exit', exitCode = 0) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  try {
    for (const sess of emulatorSessions.values()) await sess.destroySession(`server-${signal}`);
  } catch (e) {
    console.warn('[Shutdown] session stop failed:', e.message);
  }
  try {
    if (javaBackend) await javaBackend.stop(signal);
  } catch (e) {
    console.warn('[Shutdown] java backend stop failed:', e.message);
  }
  releaseServerLock();
  if (signal !== 'exit') process.exit(exitCode);
}

process.on('exit', () => { releaseServerLock(); });
['SIGINT', 'SIGTERM', 'SIGBREAK'].forEach(sig => {
  process.on(sig, () => {
    shutdownServer(sig, 0).catch(e => {
      console.error('[Shutdown]', e);
      releaseServerLock();
      process.exit(1);
    });
  });
});
process.on('uncaughtException', (err) => {
  try { console.error('uncaughtException:', err); } catch (e) {}
  shutdownServer('uncaughtException', 1).catch(() => {
    releaseServerLock();
    process.exit(1);
  });
});


// =================== JSON DB AUTH ===================
class JsonDB {
  constructor(filePath) { this.filePath = filePath; this.data = { users: {}, sessions: {} }; this.load(); }
  load() {
    ensureDir(path.dirname(this.filePath));
    if (fs.existsSync(this.filePath)) {
      try { this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); }
      catch (e) { console.warn('[DB] Lỗi đọc DB, tạo DB mới:', e.message); }
    }
    this.data.users ||= {}; this.data.sessions ||= {};
    this.save();
  }
  save() { fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2)); }
  publicUser(user) { return user ? { id: user.id, username: user.username, createdAt: user.createdAt } : null; }
  register(username, password, ip = 'unknown') {
    username = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9_.-]{3,32}$/.test(username)) throw new Error('Username 3-32 ký tự, chỉ a-z 0-9 _ . -');
    if (!password || String(password).length < 4) throw new Error('Password tối thiểu 4 ký tự');
    if (this.data.users[username]) throw new Error('Username đã tồn tại');
    const ipCount = Object.values(this.data.users).filter(u => u.createdIp === ip).length;
    if (CONFIG.maxAccountsPerIp > 0 && ipCount >= CONFIG.maxAccountsPerIp) throw new Error('IP này đã tạo quá nhiều tài khoản');
    const salt = crypto.randomBytes(16).toString('hex');
    const user = { id: randomId('u_'), username, salt, passwordHash: sha256(salt + ':' + password), createdAt: now(), createdIp: ip };
    this.data.users[username] = user; this.save(); return user;
  }
  login(username, password) {
    username = String(username || '').trim().toLowerCase();
    const user = this.data.users[username];
    if (!user || user.passwordHash !== sha256(user.salt + ':' + password)) throw new Error('Sai username hoặc password');
    if (CONFIG.sessionPolicy === 'single') this.invalidateUserSessions(user.id);
    const sid = randomId('sid_');
    this.data.sessions[sid] = { userId: user.id, username: user.username, createdAt: now(), expiresAt: now() + 30 * 24 * 3600 * 1000 };
    this.save(); return { sid, user };
  }
  invalidateUserSessions(userId) { for (const [sid, sess] of Object.entries(this.data.sessions)) if (sess.userId === userId) delete this.data.sessions[sid]; }
  logout(sid) { if (sid && this.data.sessions[sid]) { delete this.data.sessions[sid]; this.save(); } }
  getUserBySession(sid) {
    const sess = this.data.sessions[sid];
    if (!sess || sess.expiresAt < now()) { if (sid) delete this.data.sessions[sid]; return null; }
    return Object.values(this.data.users).find(u => u.id === sess.userId) || null;
  }
}
const db = new JsonDB(CONFIG.dbPath);
function requireUser(req, res) {
  const sid = parseCookies(req).fj2me_sid;
  const user = db.getUserBySession(sid);
  if (!user && res) res.status(401).json({ error: 'Bạn cần đăng nhập' });
  return user;
}

// =================== STDOUT READER ===================
class StdoutReader {
  constructor(stream) {
    this.stream = stream; this.buffer = Buffer.alloc(0); this.pending = []; this.ended = false;
    stream.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this._process(); });
    stream.on('end', () => { this.ended = true; this._process(); });
    stream.on('error', err => { this.pending.forEach(p => p.reject(err)); this.pending = []; });
  }
  _process() {
    while (this.pending.length > 0) {
      const req = this.pending[0];
      if (req.type === 'line') {
        const idx = this.buffer.indexOf('\n');
        if (idx !== -1) { this.pending.shift(); const line = this.buffer.slice(0, idx + 1).toString('utf8'); this.buffer = this.buffer.slice(idx + 1); req.resolve(line); }
        else if (this.ended) { this.pending.shift(); if (this.buffer.length) { const line = this.buffer.toString('utf8'); this.buffer = Buffer.alloc(0); req.resolve(line); } else req.reject(new Error('Stream ended while waiting for line')); }
        else break;
      } else if (req.type === 'bytes') {
        if (this.buffer.length >= req.size) { this.pending.shift(); const data = this.buffer.slice(0, req.size); this.buffer = this.buffer.slice(req.size); req.resolve(data); }
        else if (this.ended) { this.pending.shift(); req.reject(new Error('Stream ended before reading enough bytes')); }
        else break;
      }
    }
  }
  readLine() { return new Promise((resolve, reject) => { this.pending.push({ type: 'line', resolve, reject }); this._process(); }); }
  readBytes(size) { return new Promise((resolve, reject) => { this.pending.push({ type: 'bytes', size, resolve, reject }); this._process(); }); }
  prepend(data) { this.buffer = Buffer.concat([data, this.buffer]); this._process(); }
}

// =================== PROTOCOL ===================
function getEncodingJvmArg(encodingName) {
  const mapping = { 'ISO-8859-1': 'ISO_8859_1', 'ISO_8859_1': 'ISO_8859_1', 'Shift_JIS': 'Shift_JIS', 'EUC-KR': 'EUC_KR', 'EUC_KR': 'EUC_KR' };
  return `-Dfile.encoding=${mapping[encodingName] || encodingName || 'ISO_8859_1'}`;
}
function buildArgs() {
  const s = {
    width: CONFIG.width, height: CONFIG.height, rotate: CONFIG.rotate, phoneType: CONFIG.phoneType, fps: CONFIG.fps, sound: CONFIG.sound,
    useCustomMidi: 0, dumpAudioStreams: 0, minLogLevel: 2, noAlphaOnBlankImages: 1, maskIndex: 1,
    compatFantasyZoneFix: 0, compatTranslateToOriginOnReset: 0, useCustomTextFont: 0, fontSizeOffset: 0, dumpGraphicsObjects: 0,
    deleteTemporaryKJXFiles: 1, M3GRenderUntexturedPolygons: 0, M3GRenderWireframe: 0, unlockFramerateHack: 0,
    compatImmediateRepaints: 0, compatOverridePlatformChecks: 1, compatSiemensFriendlyDrawing: 0, halfResM3GRaster: 0,
    DoJaVersion: 200, compatIgnoreVolumeChanges: 0, halfResMCV3Raster: 0, MCV3NoLighting: 0, compatMCV3HorizontalFovFix: 0,
    MCV3ShowHeapUsage: 0, MCV3ShowTimeMetrics: 0,
  };
  return [s.width, s.height, s.rotate, s.phoneType, s.fps, s.sound, s.useCustomMidi, s.dumpAudioStreams, s.minLogLevel, s.noAlphaOnBlankImages, s.maskIndex, s.compatFantasyZoneFix, s.compatTranslateToOriginOnReset, s.useCustomTextFont, s.fontSizeOffset, s.dumpGraphicsObjects, s.deleteTemporaryKJXFiles, s.M3GRenderUntexturedPolygons, s.M3GRenderWireframe, s.unlockFramerateHack, s.compatImmediateRepaints, s.compatOverridePlatformChecks, s.compatSiemensFriendlyDrawing, s.halfResM3GRaster, s.DoJaVersion, s.compatIgnoreVolumeChanges, s.halfResMCV3Raster, s.MCV3NoLighting, s.compatMCV3HorizontalFovFix, s.MCV3ShowHeapUsage, s.MCV3ShowTimeMetrics].map(String);
}

function waitForProcessExitOrError(proc) {
  return new Promise((_, reject) => {
    proc.once('error', reject);
    proc.once('exit', (code, signal) => reject(new Error(`Emulator thoát trước khi READY (code=${code}, signal=${signal || 'none'})`)));
  });
}
function waitMs(ms, message) { return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)); }

// =================== SINGLE JAVA BACKEND + EMULATOR SESSION ===================
class JavaBackend {
  constructor() {
    this.process = null;
    this.ready = false;
    this.shouldRun = false;
    this.startPromise = null;
    this.restartTimer = null;
    this.restartAttempt = 0;
    this.sessions = new Set();
  }

  registerSession(session) { this.sessions.add(session); }
  unregisterSession(session) { this.sessions.delete(session); }

  async waitUntilReady(timeoutMs = CONFIG.javaBackendHandshakeTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.process && this.process.exitCode !== null) throw new Error('Java backend exited before ready');
      const ok = await new Promise((resolve) => {
        const socket = net.createConnection({ host: CONFIG.javaBackendHost, port: CONFIG.javaBackendPort }, () => {
          socket.destroy();
          resolve(true);
        });
        socket.on('error', () => resolve(false));
      });
      if (ok) return true;
      await wait(250);
    }
    throw new Error(`Timeout waiting Java backend on ${CONFIG.javaBackendHost}:${CONFIG.javaBackendPort}`);
  }

  async ensureRunning() {
    if (this.ready && this.process && this.process.exitCode === null) return true;
    if (this.startPromise) return this.startPromise;
    this.shouldRun = true;
    this.startPromise = (async () => {
      validateRuntimePaths();
      if (!this.process || this.process.exitCode !== null) {
        const jarBuf = fs.readFileSync(CONFIG.freej2meJar);
        if (!jarBuf.includes(Buffer.from('FreeJ2MEManager'))) {
          throw new Error(`File ${CONFIG.freej2meJar} bị thiếu lớp FreeJ2MEManager! Hãy build lại bằng ant.`);
        }
        const maxSess = CONFIG.maxConcurrentSessions || 5000;
        const args = ['-Djava.awt.headless=true', `-Dfreej2me.maxConcurrentSessions=${maxSess}`, ...(CONFIG.audioPipe ? ['-Dfreej2me.audioPipe=1'] : []), '-cp', CONFIG.freej2meJar, 'org.recompile.freej2me.transport.WebSocketMain', String(CONFIG.javaBackendPort)];
        console.log(`[JavaBackend] spawn: ${CONFIG.javaPath} ${args.join(' ')}`);
        this.process = spawn(CONFIG.javaPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: path.dirname(CONFIG.freej2meJar) });
        this.ready = false;
        this.process.stdout.on('data', chunk => {
          const text = chunk.toString('utf8').trim();
          if (text) console.log(`[JavaBackend stdout] ${text}`);
        });
        this.process.stderr.on('data', chunk => {
          const text = chunk.toString('utf8').trim();
          if (text) console.error(`[JavaBackend stderr] ${text}`);
        });
        this.process.on('exit', (code, signal) => {
          console.warn(`[JavaBackend] exited code=${code} signal=${signal || 'none'}`);
          this.ready = false;
          this.startPromise = null;
          const oldProc = this.process;
          this.process = null;
          for (const session of this.sessions) session.onBackendProcessExit(code, signal);
          if (this.shouldRun) this.scheduleRestart();
          if (oldProc) oldProc.removeAllListeners();
        });
        this.process.on('error', (err) => {
          console.error('[JavaBackend] process error:', err.message);
        });
      }
      await this.waitUntilReady();
      this.ready = true;
      this.restartAttempt = 0;
      console.log(`[JavaBackend] ready on ws://${CONFIG.javaBackendHost}:${CONFIG.javaBackendPort}`);
      return true;
    })();
    try { return await this.startPromise; }
    finally { if (this.ready) this.startPromise = null; }
  }

  scheduleRestart() {
    if (this.restartTimer || !this.shouldRun) return;
    this.restartAttempt++;
    const delay = Math.min(15000, CONFIG.javaBackendRestartDelayMs * Math.pow(2, Math.min(this.restartAttempt - 1, 4)));
    console.warn(`[JavaBackend] scheduling restart in ${delay}ms`);
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      try {
        await this.ensureRunning();
        for (const session of this.sessions) session.onBackendAvailable();
      } catch (e) {
        console.error('[JavaBackend] restart failed:', e.message);
        this.scheduleRestart();
      }
    }, delay);
  }

  async stop(reason = 'shutdown') {
    this.shouldRun = false;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    this.ready = false;
    const proc = this.process;
    this.process = null;
    this.startPromise = null;
    if (proc) await terminateChildProcessTree(proc, `java-backend/${reason}`);
  }
}

class EmulatorSession {
  constructor({ user, gameHash, jarPath }) {
    this.user = user; this.userId = user.id; this.username = user.username; this.gameHash = gameHash; this.jarPath = jarPath;
    this.key = `${this.userId}:${gameHash}`;
    this.publicId = randomId('s_');
    this.backendSessionId = `sess_${safeName(this.userId)}_${safeName(gameHash)}`;
    publicSessionIds.set(this.publicId, this);
    this.clients = new Set();
    this.audioHttpClients = new Set();
    this.opusEncoder = null;
    this.opusTargetRate = 48000;
    this.opusPendingPcm = Buffer.alloc(0);
    this.opusInputRate = 0;
    this.opusChannels = 1;
    this.opusFrameDurationMs = 20;
    this.profileLevel = 0;
    this.profile = ADAPTIVE_PROFILES[0] || null;
    this.opusAudioEnabled = !!(this.profile && this.profile.audioCodec === 'opus' && OPUS_PROBE.available);
    this.isRunning = false;
    this.backendWs = null;
    this.backendConnected = false;
    this.backendConnectPromise = null;
    this.backendReconnectTimer = null;
    this.frameRequestTimer = null;
    this.closing = false;
    this.clientForcedAudioMode = null;
    this.desiredEncoding = 'ISO_8859_1';
    this.emuFrameWidth = CONFIG.width; this.emuFrameHeight = CONFIG.height;
    this.streamOutWidth = Math.floor(CONFIG.width / CONFIG.streamScale); this.streamOutHeight = Math.floor(CONFIG.height / CONFIG.streamScale);
    this.currentAudioFormat = null;
    this.audioStats = { formatPackets: 0, pcmPackets: 0, pcmBytes: 0, lastFormatAt: 0, lastPcmAt: 0 };
    this.videoStats = { framesRead: 0, framesSent: 0, lastFrameAt: 0, dropEvents: 0, dropWindows: 0, stableWindows: 0, lastAdaptiveAt: now(), lastAdaptiveBumpAt: 0 };
    this.audioPcmChunks = [];
    this.audioPcmBytes = 0;
    this.audioFlushTimer = null;
    this.lastActivity = now();
    this.lastVisualProfileChangeAt = 0;
    this.visualProfile = null;
    this.dataDir = path.join(CONFIG.dataDir, 'users', safeName(this.userId), 'games', gameHash, 'runtime');
    ensureDir(this.dataDir);
    this.applyAdaptiveProfile(0, 'init');
  }

  touch() { this.lastActivity = now(); }
  getCurrentProfile() { return this.profile || ADAPTIVE_PROFILES[0]; }
  maybeApplyVisualProfile(targetProfile, reason) {
    const nowTs = now();
    if (!this.visualProfile) {
      this.visualProfile = { videoCodec: targetProfile.videoCodec, streamScale: targetProfile.streamScale };
      this.lastVisualProfileChangeAt = nowTs;
      return true;
    }
    const currentKey = `${this.visualProfile.videoCodec}:${this.visualProfile.streamScale}`;
    const targetKey = `${targetProfile.videoCodec}:${targetProfile.streamScale}`;
    if (currentKey === targetKey) return false;
    const targetRank = targetProfile.severity;
    const currentRank = (this.profile && typeof this.profile.severity === 'number') ? this.profile.severity : 0;
    const isDegradeVisual = targetRank > currentRank;
    if (isDegradeVisual) {
      this.visualProfile = { videoCodec: targetProfile.videoCodec, streamScale: targetProfile.streamScale };
      this.lastVisualProfileChangeAt = nowTs;
      return true;
    }
    const holdMs = 5000;
    const enoughStable = this.videoStats.stableWindows >= Math.max(CONFIG.adaptiveRecoverWindows * 3, 6);
    if (nowTs - this.lastVisualProfileChangeAt >= holdMs && enoughStable) {
      this.visualProfile = { videoCodec: targetProfile.videoCodec, streamScale: targetProfile.streamScale };
      this.lastVisualProfileChangeAt = nowTs;
      return true;
    }
    return false;
  }
  applyAdaptiveProfile(level, reason = 'manual') {
    const max = ADAPTIVE_PROFILES.length - 1;
    const nextLevel = clampNumber(level, 0, max);
    const prevProfile = this.profile;
    const target = ADAPTIVE_PROFILES[nextLevel] || ADAPTIVE_PROFILES[0];
    this.profileLevel = nextLevel;
    const visualChanged = this.maybeApplyVisualProfile(target, reason);
    this.profile = Object.assign({}, target, this.visualProfile ? { videoCodec: this.visualProfile.videoCodec, streamScale: this.visualProfile.streamScale } : {});
    this.opusAudioEnabled = !!(this.profile && this.profile.audioCodec === 'opus' && OPUS_PROBE.available);
    if (!this.opusAudioEnabled) this.stopOpusEncoder();
    else if (this.currentAudioFormat) this.startOpusEncoder();
    if (this.isRunning) this.startFramePump();
    if (!prevProfile || prevProfile.level !== target.level || reason !== 'init' || visualChanged) {
      console.log(`[ADAPT ${this.username}] ${reason} -> level=${target.level + 1}/${ADAPTIVE_PROFILES.length} video=${this.profile.videoCodec}@${this.profile.streamScale} targetVideo=${target.videoCodec}@${target.streamScale} fps=${this.profile.maxFps} audio=${this.profile.audioCodec}${this.opusAudioEnabled ? ':' + this.profile.opusBitrate : ''}`);
      if (this.clients.size > 0) {
        this.broadcastConfig();
        this.broadcastJson(this.getAudioStatus({ event: 'adaptive-profile', adaptiveLevel: target.level, adaptiveCount: ADAPTIVE_PROFILES.length, visualChanged, videoCodec: this.profile.videoCodec, streamScale: this.profile.streamScale }));
      }
    }
  }
  noteAdaptiveWindow(hadDrops) {
    if (!CONFIG.adaptiveStreaming || ADAPTIVE_PROFILES.length <= 1) return;
    if (hadDrops) {
      this.videoStats.dropWindows++;
      this.videoStats.stableWindows = 0;
      const nowTs = now();
      if (ADAPTIVE_PROFILES.length >= 50) {
        if (nowTs - this.videoStats.lastAdaptiveBumpAt >= 120 && this.profileLevel < ADAPTIVE_PROFILES.length - 1) {
          this.videoStats.lastAdaptiveBumpAt = nowTs;
          this.applyAdaptiveProfile(this.profileLevel + 1, `drop-hit-${this.videoStats.dropWindows}`);
        }
      } else if (this.profileLevel < ADAPTIVE_PROFILES.length - 1) {
        this.applyAdaptiveProfile(this.profileLevel + 1, `drop-window-${this.videoStats.dropWindows}`);
      }
      return;
    }
    this.videoStats.stableWindows++;
    if (this.videoStats.stableWindows >= CONFIG.adaptiveRecoverWindows) {
      this.videoStats.stableWindows = 0;
      if (this.profileLevel > 0) this.applyAdaptiveProfile(this.profileLevel - 1, 'recover');
    }
  }
  maybeEvaluateAdaptiveWindow() {
    if (!CONFIG.adaptiveStreaming) return;
    const nowTs = now();
    if (nowTs - this.videoStats.lastAdaptiveAt < CONFIG.adaptiveWindowMs) return;
    const hadDrops = this.videoStats.dropEvents > 0;
    this.videoStats.lastAdaptiveAt = nowTs;
    this.videoStats.dropEvents = 0;
    this.noteAdaptiveWindow(hadDrops);
  }
  buildRawCommand(cmd, value) {
    const b = Buffer.alloc(5);
    b[0] = cmd & 0xFF;
    b.writeInt32BE(value, 1);
    return b;
  }
  sendPacket(buf) {
    if (this.backendWs && this.backendWs.readyState === WebSocket.OPEN) {
      this.backendWs.send(buf, { binary: true, compress: false });
      return true;
    }
    return false;
  }
  sendKeyDown(keyIndex) { return this.sendPacket(this.buildRawCommand(3, keyIndex)); }
  sendKeyUp(keyIndex) { return this.sendPacket(this.buildRawCommand(2, keyIndex)); }
  sendMouse(cmd, x, y) {
    const b = Buffer.alloc(5);
    b[0] = cmd;
    b[1] = (x >> 8) & 255; b[2] = x & 255; b[3] = (y >> 8) & 255; b[4] = y & 255;
    return this.sendPacket(b);
  }
  sendFrameRequest() { return this.sendPacket(Buffer.from([15, 0, 0, 0, 0])); }

  broadcast(data, opts = {}) { for (const ws of this.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data, opts); }
  broadcastJson(obj) { this.broadcast(JSON.stringify(obj)); }
  shouldUseOpus() { return !!(this.opusAudioEnabled && this.clientForcedAudioMode !== 'pcm' && OPUS_PROBE.available); }
  getAdvertisedAudioCodec() { return this.shouldUseOpus() ? 'opus' : 'pcm'; }
  getCurrentAudioUrl() { return null; }
  makeAudioFormatPacketFromCurrent() {
    if (!this.currentAudioFormat) return null;
    const packet = Buffer.allocUnsafe(13);
    packet.write('FJ2A', 0, 4, 'ascii');
    packet[4] = 1;
    packet.writeUInt32BE(this.currentAudioFormat.sampleRate || 44100, 5);
    packet[9] = this.currentAudioFormat.channels || 1;
    packet[10] = this.currentAudioFormat.bits || 16;
    packet[11] = this.currentAudioFormat.signed ? 1 : 0;
    packet[12] = this.currentAudioFormat.bigEndian ? 1 : 0;
    return packet;
  }
  setClientAudioMode(mode = 'auto', reason = 'client') {
    const normalized = String(mode || 'auto').toLowerCase() === 'pcm' ? 'pcm' : null;
    const before = this.getAdvertisedAudioCodec();
    this.clientForcedAudioMode = normalized;
    const after = this.getAdvertisedAudioCodec();
    if (before === after) return;
    if (after === 'opus') {
      if (this.currentAudioFormat) this.startOpusEncoder();
    } else {
      this.stopOpusEncoder();
      const fmt = this.makeAudioFormatPacketFromCurrent();
      if (fmt) this.broadcast(fmt, { binary: true, compress: false });
    }
    this.broadcastJson(this.getAudioStatus({ event: 'audio-mode', reason, audioCodec: after, audioUrl: this.getCurrentAudioUrl() }));
  }
  debugAdaptiveDrop(amount, reason = 'debug-drop') {
    const delta = Math.max(1, Math.abs(amount | 0));
    this.videoStats.stableWindows = 0;
    this.applyAdaptiveProfile(this.profileLevel + delta, `${reason}+${delta}`);
  }
  debugAdaptiveReset(reason = 'debug-reset') {
    this.videoStats.stableWindows = 0;
    this.applyAdaptiveProfile(0, reason);
  }
  getClientAudioTuning() {
    const p = this.getCurrentProfile();
    return {
      transportProfile: CONFIG.transportProfile,
      audioAdaptiveBuffer: CONFIG.audioAdaptiveBuffer,
      audioPacketMs: p.audioPacketMs,
      audioStartBufferMs: p.audioStartBufferMs,
      clientAudioMinBufferMs: p.clientAudioMinBufferMs,
      clientAudioMaxBufferMs: p.clientAudioMaxBufferMs,
      audioCodec: this.getAdvertisedAudioCodec(),
      adaptiveLevel: this.profileLevel,
      adaptiveCount: ADAPTIVE_PROFILES.length,
    };
  }
  getAudioStatus(extra = {}) { return { type: 'audio-status', enabled: CONFIG.audioPipe, format: this.currentAudioFormat, opusScriptAvailable: OPUS_PROBE.available, ...this.audioStats, ...this.getClientAudioTuning(), ...extra }; }
  getStreamDimensions(width = this.emuFrameWidth, height = this.emuFrameHeight) {
    const scale = Math.max(1, (this.getCurrentProfile().streamScale || 1) | 0);
    return { width: Math.max(1, Math.floor(width / scale)), height: Math.max(1, Math.floor(height / scale)) };
  }
  broadcastConfig() {
    const p = this.getCurrentProfile();
    const d = this.getStreamDimensions();
    this.streamOutWidth = d.width; this.streamOutHeight = d.height;
    this.broadcastJson({ type: 'config', width: d.width, height: d.height, scale: p.streamScale, videoCodec: p.videoCodec, imageQuality: p.imageQuality, webpQuality: p.webpQuality, opusScriptAvailable: OPUS_PROBE.available, ...this.getClientAudioTuning() });
  }

  cancelNoClientShutdown() {
    if (this.noClientTimer) clearTimeout(this.noClientTimer);
    this.noClientTimer = null;
  }

  scheduleNoClientShutdown(reason = 'no clients') {
    this.cancelNoClientShutdown();
    if (CONFIG.noClientShutdownMs <= 0) return;
    this.noClientTimer = setTimeout(() => {
      if (this.clients.size === 0) {
        console.log(`[SESSION ${this.username}] auto shutdown: ${reason}, idle ${CONFIG.noClientShutdownMs}ms`);
        this.cleanupProcess('no-clients');
        emulatorSessions.delete(this.key);
        if (this.publicId) publicSessionIds.delete(this.publicId);
      }
    }, CONFIG.noClientShutdownMs);
  }

  startDeadlockWatchdog() {
    if (this.deadlockWatchdogTimer) return;
    this.lastBackendFrameAt = Date.now();
    this.deadlockWatchdogTimer = setInterval(() => {
      if (!this.isRunning || !this.backendConnected || this.closing) return;
      if (this.clients && this.clients.size > 0) {
        const elapsed = Date.now() - (this.lastBackendFrameAt || Date.now());
        if (elapsed > 15000) {
          console.warn(`[WATCHDOG ${this.username}] Deadlock detected (15s no frames). Restarting backend session...`);
          this.scheduleBackendReconnect('deadlock-watchdog');
        }
      }
    }, 5000);
  }

  startInputIdleWatchdog() {
    if (this.inputIdleTimer || CONFIG.inputIdleShutdownMs <= 0) return;
    this.inputIdleTimer = setInterval(() => {
      if (!this.isRunning || this.clients.size === 0) return;
      if (now() - this.lastInputAt >= CONFIG.inputIdleShutdownMs) {
        console.log(`[SESSION ${this.username}] input idle shutdown after ${CONFIG.inputIdleShutdownMs}ms`);
        this.broadcastJson({ type: 'status', state: 'input-idle-shutdown' });
        this.cleanupProcess('input-idle');
        emulatorSessions.delete(this.key);
        if (this.publicId) publicSessionIds.delete(this.publicId);
      }
    }, Math.max(1000, Math.min(CONFIG.inputIdleShutdownMs, 5000)));
  }

  markInputActivity() {
    this.lastInputAt = now();
    this.touch();
  }

  addClient(ws) {
    this.touch();
    this.cancelNoClientShutdown();
    detachClientFromOtherSessions(ws, this);
    if (CONFIG.maxClientsPerInstance > 0 && this.clients.size >= CONFIG.maxClientsPerInstance) { try { ws.send(JSON.stringify({ type: 'error', error: 'too_many_clients_for_instance' })); } catch(e) {} try { ws.close(); } catch(e) {} return; }
    this.clients.add(ws);
    ws._emuSession = this;
    console.log(`[SESSION ${this.username}] client bound game=${this.gameHash} clients=${this.clients.size}`);
    const p = this.getCurrentProfile();
    ws.send(JSON.stringify({ type: 'auth', user: { id: this.userId, username: this.username }, gameHash: this.gameHash, sessionId: this.publicId, audioUrl: this.getCurrentAudioUrl(), audioCodec: this.getAdvertisedAudioCodec() }));
    ws.send(JSON.stringify({ type: 'status', state: this.isRunning ? 'running' : 'binding', gameHash: this.gameHash }));
    ws.send(JSON.stringify({ type: 'config', width: this.streamOutWidth, height: this.streamOutHeight, scale: p.streamScale, videoCodec: p.videoCodec, imageQuality: p.imageQuality, webpQuality: p.webpQuality, opusScriptAvailable: OPUS_PROBE.available, ...this.getClientAudioTuning() }));
    ws.send(JSON.stringify(this.getAudioStatus({ event: 'connect' })));
    ws.on('close', () => {
      this.clients.delete(ws);
      this.touch();
      if (this.clients.size === 0) this.scheduleNoClientShutdown('last websocket closed');
    });
  }

  countReadyClients() {
    const p = this.getCurrentProfile();
    let n = 0;
    for (const ws of this.clients) if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= p.maxWsBufferedAmount) n++;
    return n;
  }

  async convertRgb24ToVideoBuffer(rgb24, width, height) {
    const p = this.getCurrentProfile();
    const scale = Math.max(1, (p.streamScale || 1) | 0);
    const outWidth = scale <= 1 ? width : Math.max(1, Math.floor(width / scale));
    const outHeight = scale <= 1 ? height : Math.max(1, Math.floor(height / scale));
    const codec = p.videoCodec;

    if (codec === 'webp' && sharp) {
      const raw = Buffer.allocUnsafe(outWidth * outHeight * 3);
      let dst = 0;
      for (let y = 0; y < outHeight; y++) {
        const srcRow = (y * scale * width) * 3;
        for (let x = 0; x < outWidth; x++) {
          const src = srcRow + (x * scale * 3);
          raw[dst++] = rgb24[src];
          raw[dst++] = rgb24[src + 1];
          raw[dst++] = rgb24[src + 2];
        }
      }
      return await sharp(raw, { raw: { width: outWidth, height: outHeight, channels: 3 } })
        .webp({ quality: p.webpQuality, effort: CONFIG.webpEffort, smartSubsample: false })
        .toBuffer();
    }

    if (codec === 'rgb332') {
      const out = Buffer.allocUnsafe(outWidth * outHeight);
      let dst = 0;
      for (let y = 0; y < outHeight; y++) {
        const srcRow = (y * scale * width) * 3;
        for (let x = 0; x < outWidth; x++) {
          const src = srcRow + (x * scale * 3);
          const r = rgb24[src], g = rgb24[src + 1], b = rgb24[src + 2];
          out[dst++] = (r & 0xE0) | ((g & 0xE0) >> 3) | (b >> 6);
        }
      }
      return out;
    }

    if (codec === 'rgb565') {
      const out = Buffer.allocUnsafe(outWidth * outHeight * 2);
      let dst = 0;
      for (let y = 0; y < outHeight; y++) {
        const srcRow = (y * scale * width) * 3;
        for (let x = 0; x < outWidth; x++) {
          const src = srcRow + (x * scale * 3);
          const r = rgb24[src], g = rgb24[src + 1], b = rgb24[src + 2];
          const v = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
          out[dst++] = v & 0xFF;
          out[dst++] = (v >> 8) & 0xFF;
        }
      }
      return out;
    }

    const out = Buffer.allocUnsafe(outWidth * outHeight * 4);
    let dst = 0;
    for (let y = 0; y < outHeight; y++) {
      const srcRow = (y * scale * width) * 3;
      for (let x = 0; x < outWidth; x++) {
        const src = srcRow + (x * scale * 3);
        out[dst++] = rgb24[src];
        out[dst++] = rgb24[src + 1];
        out[dst++] = rgb24[src + 2];
        out[dst++] = 255;
      }
    }
    return out;
  }

  getOpusFrameDurationMs() {
    const packetMs = this.getCurrentProfile().audioPacketMs || 20;
    if (packetMs >= 50) return 60;
    if (packetMs >= 30) return 40;
    return 20;
  }

  makeAudioOpusFormatPacket() {
    const f = this.currentAudioFormat || { channels: 1 };
    const h = Buffer.allocUnsafe(13);
    h.write('FJ2A', 0, 4, 'ascii');
    h[4] = AUDIO_TYPE_OPUS_FORMAT;
    h.writeUInt32BE(this.opusTargetRate, 5);
    h[9] = f.channels || 1;
    h[10] = 16;
    h[11] = 1;
    h[12] = 0;
    return h;
  }

  makeAudioOpusPacket(payload) {
    const h = Buffer.allocUnsafe(9);
    h.write('FJ2A', 0, 4, 'ascii');
    h[4] = AUDIO_TYPE_OPUS_PACKET;
    h.writeUInt32BE(payload.length, 5);
    return Buffer.concat([h, payload]);
  }

  pcmBufferToUint16ArrayLE(buffer) {
    const samples = new Uint16Array(buffer.length >> 1);
    for (let i = 0, j = 0; i < samples.length; i++, j += 2) samples[i] = buffer.readUInt16LE(j);
    return samples;
  }

  resamplePcmS16LE(buffer, channels, inputRate, outputRate, outputSamplesPerChannel) {
    if (inputRate === outputRate) return Buffer.from(buffer);
    const inputSamplesPerChannel = Math.floor(buffer.length / (channels * 2));
    const out = Buffer.allocUnsafe(outputSamplesPerChannel * channels * 2);
    for (let ch = 0; ch < channels; ch++) {
      for (let i = 0; i < outputSamplesPerChannel; i++) {
        const srcPos = (i * inputRate) / outputRate;
        const idx0 = Math.min(inputSamplesPerChannel - 1, Math.floor(srcPos));
        const idx1 = Math.min(inputSamplesPerChannel - 1, idx0 + 1);
        const frac = srcPos - idx0;
        const s0 = buffer.readInt16LE((idx0 * channels + ch) * 2);
        const s1 = buffer.readInt16LE((idx1 * channels + ch) * 2);
        const mixed = Math.max(-32768, Math.min(32767, Math.round(s0 + (s1 - s0) * frac)));
        out.writeInt16LE(mixed, (i * channels + ch) * 2);
      }
    }
    return out;
  }

  startOpusEncoder() {
    const p = this.getCurrentProfile();
    if (!OPUS_PROBE.available || !this.shouldUseOpus() || !this.currentAudioFormat || this.opusEncoder) return;
    const f = this.currentAudioFormat;
    if (f.bits !== 16 || !f.signed) {
      console.warn(`[AUDIO ${this.username}] Opus fallback: unsupported PCM format`, f);
      this.opusAudioEnabled = false;
      return;
    }
    try {
      this.opusChannels = Math.max(1, f.channels || 1);
      this.opusInputRate = f.sampleRate || 44100;
      this.opusFrameDurationMs = this.getOpusFrameDurationMs();
      this.opusPendingPcm = Buffer.alloc(0);
      this.opusEncoder = new OpusScript(this.opusTargetRate, this.opusChannels, OpusScript.Application.AUDIO);
      this.opusEncoder.setBitrate(parseInt(String(p.opusBitrate).replace(/k$/i, ''), 10) * 1000 || 96000);
      console.log(`[AUDIO ${this.username}] starting opusscript opus ${p.opusBitrate}: rate=${this.opusTargetRate} ch=${this.opusChannels} frame=${this.opusFrameDurationMs}ms`);
    } catch (e) {
      console.warn(`[AUDIO ${this.username}] opusscript init failed: ${e.message}; fallback PCM websocket`);
      this.opusAudioEnabled = false;
      this.opusEncoder = null;
    }
  }

  encodePendingOpusFrames() {
    if (!this.opusEncoder || !this.currentAudioFormat) return;
    const inRate = this.opusInputRate || this.currentAudioFormat.sampleRate || 44100;
    const channels = this.opusChannels || 1;
    const outSamples = Math.round(this.opusTargetRate * this.opusFrameDurationMs / 1000);
    const inSamples = Math.max(1, Math.round(inRate * this.opusFrameDurationMs / 1000));
    const inBytes = inSamples * channels * 2;
    while (this.opusPendingPcm.length >= inBytes) {
      const chunk = this.opusPendingPcm.slice(0, inBytes);
      this.opusPendingPcm = this.opusPendingPcm.slice(inBytes);
      const pcm = this.resamplePcmS16LE(chunk, channels, inRate, this.opusTargetRate, outSamples);
      const pcm16 = this.pcmBufferToUint16ArrayLE(pcm);
      const encoded = Buffer.from(this.opusEncoder.encode(pcm16, outSamples));
      this.broadcast(this.makeAudioOpusPacket(encoded), { binary: true, compress: false });
    }
  }

  writeOpusPcm(payload) {
    if (!this.shouldUseOpus()) return false;
    this.startOpusEncoder();
    if (!this.opusEncoder) return false;
    this.opusPendingPcm = Buffer.concat([this.opusPendingPcm, Buffer.from(payload)]);
    this.encodePendingOpusFrames();
    return true;
  }

  addAudioHttpClient(res) {
    return false;
  }

  stopOpusEncoder() {
    if (this.opusEncoder) {
      try { this.opusEncoder.delete(); } catch (e) {}
    }
    this.opusEncoder = null;
    this.opusPendingPcm = Buffer.alloc(0);
  }

  makeAudioPcmPacket(payload) {
    const h = Buffer.allocUnsafe(9);
    h.write('FJ2A', 0, 4, 'ascii');
    h[4] = 2;
    h.writeUInt32BE(payload.length, 5);
    return Buffer.concat([h, payload]);
  }

  audioBytesPerMs() {
    const f = this.currentAudioFormat;
    if (!f || !f.sampleRate || !f.channels || !f.bits) return 4096;
    return Math.max(1, Math.ceil(f.sampleRate * f.channels * (f.bits / 8) / 1000));
  }

  flushAudioPcm() {
    if (this.audioFlushTimer) { clearTimeout(this.audioFlushTimer); this.audioFlushTimer = null; }
    if (!this.audioPcmBytes || this.audioPcmChunks.length === 0) return;
    const payload = this.audioPcmChunks.length === 1 ? this.audioPcmChunks[0] : Buffer.concat(this.audioPcmChunks, this.audioPcmBytes);
    this.audioPcmChunks = [];
    this.audioPcmBytes = 0;
    const packet = this.makeAudioPcmPacket(payload);
    this.broadcast(packet, { binary: true, compress: false });
  }

  queueAudioPcm(payload) {
    const p = this.getCurrentProfile();
    if (!payload || payload.length <= 0) return;
    this.audioPcmChunks.push(Buffer.from(payload));
    this.audioPcmBytes += payload.length;
    const targetBytes = this.audioBytesPerMs() * p.audioPacketMs;
    if (this.audioPcmBytes >= targetBytes) {
      this.flushAudioPcm();
      return;
    }
    if (!this.audioFlushTimer) {
      this.audioFlushTimer = setTimeout(() => this.flushAudioPcm(), p.audioPacketMs);
    }
  }

  buildBackendConfig() {
    return {
      sessionId: this.backendSessionId,
      dataDir: path.resolve(this.dataDir),
      jar: path.resolve(this.jarPath),
      encoding: this.desiredEncoding || 'ISO_8859_1',
      width: CONFIG.width,
      height: CONFIG.height,
      rotate: CONFIG.rotate,
      phone: CONFIG.phoneType,
      fps: CONFIG.fps,
      sound: CONFIG.sound,
      midi: 0,
      dumpAudio: 0,
      logLevel: 2,
      noAlpha: 1,
      backlight: 1,
      fantasyZone: 0,
      transToOrigin: 0,
      textFont: 0,
      fontOffset: 0,
      dumpGraphics: 0,
      deleteKJX: 1,
      M3GUntextured: 0,
      M3GWireframe: 0,
      fpsHack: 0,
      immediateRepaints: 0,
      overridePlatform: 1,
      siemensFriendly: 0,
      M3GHalfRes: 0,
      DoJaVersion: 200,
      ignoreVolume: 0,
      MCV3HalfRes: 0,
      MCV3NoLight: 0,
      MCV3HFOV: 0,
      MCV3Heap: 0,
      MCV3Time: 0,
      fontOffset2: 0,
    };
  }

  startFramePump() {
    const p = this.getCurrentProfile();
    if (this.frameRequestTimer) clearInterval(this.frameRequestTimer);
    const interval = Math.max(25, Math.floor(1000 / Math.max(1, p.maxFps || 30)));
    this.frameRequestTimer = setInterval(() => {
      if (!this.backendConnected) return;
      if (this.clients.size === 0) return;
      this.sendFrameRequest();
      this.maybeEvaluateAdaptiveWindow();
    }, interval);
    this.sendFrameRequest();
  }

  stopFramePump() {
    if (this.frameRequestTimer) clearInterval(this.frameRequestTimer);
    this.frameRequestTimer = null;
  }

  onBackendProcessExit(code, signal) {
    this.backendConnected = false;
    this.isRunning = false;
    this.stopFramePump();
    this.broadcastJson({ type: 'status', state: 'java-backend-down', reason: `${code}:${signal || 'none'}` });
  }

  onBackendAvailable() {
    if (!this.closing) this.scheduleBackendReconnect('backend-available');
  }

  scheduleBackendReconnect(reason = 'backend-reconnect') {
    if (this.closing) return;
    if (this.backendReconnectTimer) return;
    this.broadcastJson({ type: 'status', state: 'backend-reconnecting', reason, gameHash: this.gameHash });
    this.backendReconnectTimer = setTimeout(async () => {
      this.backendReconnectTimer = null;
      try {
        await this.connectBackend();
      } catch (e) {
        console.warn(`[SESSION ${this.username}] reconnect failed:`, e.message);
        this.scheduleBackendReconnect('retry');
      }
    }, Math.max(500, CONFIG.javaBackendRestartDelayMs));
  }

  async closeBackendConnection(reason = 'close') {
    this.backendConnected = false;
    this.isRunning = false;
    this.stopFramePump();
    const ws = this.backendWs;
    this.backendWs = null;
    this.backendConnectPromise = null;
    if (this.backendReconnectTimer) { clearTimeout(this.backendReconnectTimer); this.backendReconnectTimer = null; }
    if (ws) {
      try { ws.removeAllListeners(); ws.close(); } catch (e) {}
      if (ws.readyState !== WebSocket.CLOSED) {
        await new Promise(resolve => {
          const done = () => resolve();
          ws.once('close', done);
          setTimeout(() => { try { ws.terminate(); } catch (e) {} resolve(); }, 1000);
        });
      }
    }
  }

  async connectBackend() {
    if (this.closing) return false;
    if (this.backendConnected && this.backendWs && this.backendWs.readyState === WebSocket.OPEN) return true;
    if (this.backendConnectPromise) return this.backendConnectPromise;
    this.backendConnectPromise = (async () => {
      await javaBackend.ensureRunning();
      await this.closeBackendConnection('reconnect');
      ensureDir(this.dataDir);
      console.log(`[EMU ${this.username}] connect backend session=${this.backendSessionId} dataDir=${this.dataDir}`);
      const url = `ws://${CONFIG.javaBackendHost}:${CONFIG.javaBackendPort}`;
      const ws = new WebSocket(url, { handshakeTimeout: CONFIG.javaBackendHandshakeTimeoutMs, perMessageDeflate: false });
      this.backendWs = ws;
      await new Promise((resolve, reject) => {
        const fail = (err) => reject(err || new Error('backend ws failed'));
        ws.once('open', resolve);
        ws.once('error', fail);
        ws.once('close', () => fail(new Error('backend ws closed before open')));
      });
      ws.on('message', (data, isBinary) => {
        try {
          if (isBinary) {
            const packet = Buffer.isBuffer(data) ? data : Buffer.from(data);
            if (packet.length >= 4 && packet.slice(0, 4).equals(AUDIO_MAGIC)) this.handleBackendAudioPacket(packet);
            else if (packet.length >= 16 && packet[0] === 0xFE) { this.lastBackendFrameAt = Date.now(); this.handleBackendFramePacket(packet).catch(e => console.error(`[FRAME ${this.username}]`, e.message)); }
          } else {
            const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
            if (text) {
              console.log(`[JavaBackend msg ${this.username}] ${text}`);
              try {
                const msg = JSON.parse(text);
                if (msg.error) {
                  this.broadcastJson({ type: 'status', state: 'backend-error', error: msg.error });
                  if (msg.flightRecorder) {
                    try {
                      const dumpDir = path.join(this.dataDir, 'crash_blackbox_logs');
                      if (!fs.existsSync(dumpDir)) fs.mkdirSync(dumpDir, { recursive: true });
                      const dumpFile = path.join(dumpDir, `blackbox_${Date.now()}.json`);
                      fs.writeFileSync(dumpFile, JSON.stringify(msg, null, 2));
                      console.log(`[BLACKBOX] Saved crash flight recorder history to ${dumpFile}`);
                    } catch(ex) {}
                  }
                }
              } catch (e) {}
            }
          }
        } catch (e) {
          console.error(`[SESSION ${this.username}] backend message error:`, e.message);
        }
      });
      ws.on('close', () => {
        if (this.backendWs === ws) this.backendWs = null;
        this.backendConnected = false;
        this.isRunning = false;
        this.stopFramePump();
        if (!this.closing) this.scheduleBackendReconnect('ws-close');
      });
      ws.on('error', (err) => {
        console.warn(`[SESSION ${this.username}] backend ws error:`, err.message);
      });
      ws.send(JSON.stringify(this.buildBackendConfig()));
      this.backendConnected = true;
      this.isRunning = true;
      this.lastInputAt = now();
      this.startInputIdleWatchdog();
      this.startDeadlockWatchdog();
      this.broadcastConfig();
      this.broadcastJson({ type: 'status', state: 'running', gameHash: this.gameHash, backend: 'single-java' });
      this.startFramePump();
      setTimeout(() => { if (this.isRunning && CONFIG.audioPipe && this.audioStats.formatPackets === 0) this.broadcastJson(this.getAudioStatus({ event: 'timeout-no-audio', warning: 'no FJ2A audio packet after 5s' })); }, 5000);
      return true;
    })();
    try { return await this.backendConnectPromise; }
    finally { this.backendConnectPromise = null; }
  }

  handleBackendAudioPacket(packet) {
    const type = packet[4];
    if (type === 1) {
      if (packet.length < 13) return;
      this.currentAudioFormat = { sampleRate: packet.readUInt32BE(5), channels: packet[9], bits: packet[10], signed: packet[11] !== 0, bigEndian: packet[12] !== 0 };
      this.audioStats.formatPackets++; this.audioStats.lastFormatAt = now();
      this.flushAudioPcm();
      this.stopOpusEncoder();
      this.opusAudioEnabled = !!(this.getCurrentProfile().audioCodec === 'opus' && OPUS_PROBE.available);
      console.log(`[AUDIO ${this.username}] Format:`, this.currentAudioFormat);
      if (!this.shouldUseOpus()) this.broadcast(packet, { binary: true, compress: false });
      this.broadcastJson(this.getAudioStatus({ event: 'format', audioCodec: this.getAdvertisedAudioCodec(), audioUrl: this.getCurrentAudioUrl() }));
      if (this.shouldUseOpus()) this.startOpusEncoder();
      return;
    }
    if (type === 2) {
      if (packet.length < 9) return;
      const len = packet.readUInt32BE(5);
      if (len > 1024 * 1024 || 9 + len > packet.length) return;
      const payload = Buffer.from(packet.slice(9, 9 + len));
      this.audioStats.pcmPackets++; this.audioStats.pcmBytes += len; this.audioStats.lastPcmAt = now();
      if (this.audioStats.pcmPackets === 1 || this.audioStats.pcmPackets % 1000 === 0) console.log(`[AUDIO ${this.username}] PCM packets=${this.audioStats.pcmPackets}, bytes=${this.audioStats.pcmBytes}, codec=${this.getAdvertisedAudioCodec()}, coalesce=${this.getCurrentProfile().audioPacketMs}ms`);
      if (!this.writeOpusPcm(payload)) this.queueAudioPcm(payload);
    }
  }

  async handleBackendFramePacket(packet) {
    if (packet.length < 16) return;
    const p = this.getCurrentProfile();
    const header = packet.slice(0, 16);
    const width = (header[1] << 8) | header[2];
    const height = (header[3] << 8) | header[4];
    const frameSize = width * height * 3;
    if (header[14] === 1) {
      const enc = ['ISO_8859_1', 'Shift_JIS', 'EUC_KR'][header[15]] || 'ISO_8859_1';
      console.log(`[SESSION ${this.username}] encoding restart requested -> ${enc}`);
      this.desiredEncoding = enc;
      this.scheduleBackendReconnect('encoding-restart');
      return;
    }
    if (width <= 0 || height <= 0 || frameSize <= 0 || packet.length < 16 + frameSize) return;
    this.emuFrameWidth = width; this.emuFrameHeight = height;
    const dims = this.getStreamDimensions(width, height);
    if (dims.width !== this.streamOutWidth || dims.height !== this.streamOutHeight) this.broadcastConfig();
    this.videoStats.framesRead++;
    this.videoStats.lastFrameAt = now();
    if (this.clients.size === 0) return;
    if (this.countReadyClients() <= 0) {
      this.videoStats.dropEvents++;
      this.maybeEvaluateAdaptiveWindow();
      return;
    }
    const rgb24 = packet.slice(16, 16 + frameSize);
    const videoBuf = await this.convertRgb24ToVideoBuffer(rgb24, width, height);
    let sentAny = false;
    let hadDrop = false;
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        if (ws.bufferedAmount <= p.maxWsBufferedAmount) {
          ws.send(videoBuf, { binary: true, compress: p.wsCompression });
          this.videoStats.framesSent++;
          sentAny = true;
        } else {
          hadDrop = true;
        }
      }
    }
    if (!sentAny || hadDrop) this.videoStats.dropEvents++;
    this.maybeEvaluateAdaptiveWindow();
  }

  async destroySession(reason = 'cleanup') {
    this.closing = true;
    this.cancelNoClientShutdown();
    if (this.inputIdleTimer) { clearInterval(this.inputIdleTimer); this.inputIdleTimer = null; }
    if (this.deadlockWatchdogTimer) { clearInterval(this.deadlockWatchdogTimer); this.deadlockWatchdogTimer = null; }
    this.flushAudioPcm();
    this.stopOpusEncoder();
    if (this.audioFlushTimer) { clearTimeout(this.audioFlushTimer); this.audioFlushTimer = null; }
    await this.closeBackendConnection(reason);
    if (javaBackend) javaBackend.unregisterSession(this);
  }

  cleanupProcess(reason = 'cleanup') {
    this.destroySession(reason).catch(e => console.warn(`[SESSION ${this.username}] destroySession failed:`, e.message));
  }

  async start(encodingName) {
    this.desiredEncoding = encodingName || this.desiredEncoding || 'ISO_8859_1';
    this.closing = false;
    if (javaBackend) javaBackend.registerSession(this);
    await this.connectBackend();
  }
}

function getOrCreateSession(user, gameHash, jarPath) {
  const key = `${user.id}:${gameHash}`;
  let sess = emulatorSessions.get(key);
  if (!sess) { sess = new EmulatorSession({ user, gameHash, jarPath }); emulatorSessions.set(key, sess); }
  else { sess.jarPath = jarPath; }
  return sess;
}
function getActiveSessionForUser(userId) {
  let best = null;
  for (const sess of emulatorSessions.values()) if (sess.userId === userId && (!best || sess.lastActivity > best.lastActivity)) best = sess;
  return best;
}

function detachClientFromOtherSessions(ws, keepSession) {
  for (const sess of emulatorSessions.values()) {
    if (sess !== keepSession && sess.clients && sess.clients.has(ws)) sess.clients.delete(ws);
  }
}

async function stopOtherSessionsForUser(userId, keepKey = null) {
  for (const [key, sess] of Array.from(emulatorSessions.entries())) {
    if (sess.userId === userId && key !== keepKey) {
      console.log(`[SESSION] stop old session user=${sess.username} game=${sess.gameHash}`);
      for (const ws of Array.from(sess.clients)) {
        sess.clients.delete(ws);
        if (ws._emuSession === sess) ws._emuSession = null;
      }
      await sess.destroySession('replace');
      emulatorSessions.delete(key);
    }
  }
}
function cleanupIdleSessions() {
  const t = now();
  for (const [key, sess] of emulatorSessions.entries()) {
    if (sess.clients.size === 0 && t - sess.lastActivity > CONFIG.sessionIdleMs) { console.log('[SESSION] cleanup idle', key); sess.cleanupProcess(); emulatorSessions.delete(key); }
  }
}
setInterval(cleanupIdleSessions, 60_000);

// =================== HTML PATCH ===================
function getPatchedIndexHtml() {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');

  const loginBox = `
  <style id="v16-ui-style">
    body.v16-login-mode {
      background:
        radial-gradient(circle at 20% 15%, rgba(72, 187, 120, .18), transparent 28%),
        radial-gradient(circle at 85% 10%, rgba(66, 153, 225, .16), transparent 30%),
        linear-gradient(180deg, #0b1117 0%, #111 70%);
    }
    #login-box.v16-card {
      width: min(560px, calc(100vw - 24px));
      margin: 18px auto 16px;
      padding: 22px;
      border-radius: 18px;
      background: rgba(22, 28, 36, .92);
      border: 1px solid rgba(255,255,255,.10);
      box-shadow: 0 18px 60px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.06);
      backdrop-filter: blur(10px);
      text-align: left;
    }
    .v16-brand { display:flex; gap:14px; align-items:center; margin-bottom:14px; }
    .v16-logo {
      width:52px; height:52px; border-radius:16px;
      background: linear-gradient(135deg, #28d17c, #1593ff);
      display:grid; place-items:center; font-weight:900; color:#06110b;
      box-shadow: 0 10px 30px rgba(40,209,124,.25);
    }
    .v16-title { font-size:22px; font-weight:800; color:#fff; line-height:1.1; }
    .v16-subtitle { color:#9fb0c2; font-size:13px; margin-top:4px; }
    .v16-form { display:grid; gap:10px; margin-top:16px; }
    .v16-row { display:grid; grid-template-columns: 1fr 1fr; gap:10px; }
    #login-box input {
      width:100%; padding:12px 13px; border-radius:12px;
      border:1px solid rgba(255,255,255,.12); outline:none;
      background:#0b1117; color:#fff; font-size:15px;
    }
    #login-box input:focus { border-color:#28d17c; box-shadow:0 0 0 3px rgba(40,209,124,.14); }
    .v16-actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:4px; }
    #login-box button {
      padding:11px 14px; border:0; border-radius:12px; cursor:pointer;
      color:#fff; font-weight:700; transition: transform .08s, filter .15s;
    }
    #login-box button:active { transform: translateY(1px); }
    #btn-login { background:linear-gradient(135deg,#15a85a,#24c875) !important; }
    #btn-register { background:#263241 !important; }
    #btn-logout { background:#812323 !important; }
    .v16-hint { color:#8fa0b2; font-size:12px; margin-top:12px; line-height:1.5; }
    #status { margin-top:10px; }
    #upload-area {
      border:1px solid rgba(255,255,255,.10);
      box-shadow:0 10px 36px rgba(0,0,0,.25);
    }
    @media (max-width:560px) { .v16-row { grid-template-columns:1fr; } #login-box.v16-card{padding:16px;} }
  </style>
  <div id="login-box" class="v16-card">
    <div class="v16-brand">
      <div class="v16-logo">J2ME</div>
      <div>
        <div class="v16-title">FreeJ2ME Web Cloud</div>
        <div class="v16-subtitle">Đăng nhập để tạo máy ảo, lưu save riêng và chơi game Java trên web.</div>
      </div>
    </div>
    <div id="me-label" class="v16-subtitle">Vui lòng đăng nhập hoặc đăng ký để bắt đầu</div>
    <div class="v16-form">
      <div class="v16-row">
        <input id="login-user" placeholder="Tên đăng nhập" autocomplete="username">
        <input id="login-pass" placeholder="Mật khẩu" type="password" autocomplete="current-password">
      </div>
      <div class="v16-actions">
        <button id="btn-login">Đăng nhập</button>
        <button id="btn-register">Tạo tài khoản</button>
        <button id="btn-logout" style="display:none">Đăng xuất</button>
      </div>
    </div>
    <div class="v16-hint">Mỗi tài khoản có save riêng theo từng game. Bạn có thể upload JAR sau khi đăng nhập.</div>
  </div>`;
  html = html.replace('<div id="status" class="connecting">Đang kết nối...</div>', '<script src="/opusscript.bundle.js"></script>\n<div id="status" class="connecting">Đang kết nối...</div>\n' + loginBox + '\n  <button id="audio-toggle" style="margin:0 0 10px;padding:8px 14px;border:0;border-radius:18px;background:#333;color:#fff;cursor:pointer;display:none">🔇 Bật âm thanh</button>\n  <style id="v11-controls-guard">#controls{display:none !important;}</style>\n  <style id="v12-login-first">#upload-area,#screen-container,#controls,#help{display:none !important;}</style>');

  const patchedKeyMap = `const keyMap = {
      'w': 0, 'W': 0, 's': 1, 'S': 1, 'a': 2, 'A': 2, 'd': 3, 'D': 3,
      'ArrowUp': 0, 'ArrowDown': 1, 'ArrowLeft': 2, 'ArrowRight': 3,
      'q': 9, 'Q': 9, 'e': 8, 'E': 8,
      'Enter': 7, 'NumpadEnter': 7, ' ': 7, 'Escape': 19, 'Backspace': 19,
      '0': 6, 'Numpad0': 6, '1': 10, 'Numpad1': 10, '2': 14, 'Numpad2': 14, '3': 11, 'Numpad3': 11,
      '4': 15, 'Numpad4': 15, '5': 18, 'Numpad5': 18, '6': 16, 'Numpad6': 16,
      '7': 5, 'Numpad7': 5, '8': 17, 'Numpad8': 17, '9': 4, 'Numpad9': 4,
      'z': 12, 'Z': 12, '*': 12, 'NumpadMultiply': 12, 'c': 13, 'C': 13, '#': 13,
    };`;
  html = html.replace(/const keyMap = \{[\s\S]*?\n    \};/, patchedKeyMap);
  html = html.replace(/const keyIndex = keyMap\[e\.key\];/g, 'const keyIndex = keyMap[e.key] ?? keyMap[e.code];');

  const injected = `
    // ===== V10 AUTH + AUDIO + PERF PATCH =====
    const meLabel = document.getElementById('me-label');
    const loginUser = document.getElementById('login-user');
    const loginPass = document.getElementById('login-pass');
    const btnLogin = document.getElementById('btn-login');
    const btnRegister = document.getElementById('btn-register');
    const btnLogout = document.getElementById('btn-logout');
    const audioToggle = document.getElementById('audio-toggle');
    const adaptiveDebugEl = document.getElementById('adaptive-debug');
    const adaptiveButtonsEl = document.getElementById('adaptive-buttons');
    const controlsEl = document.getElementById('controls');
    const uploadAreaEl = document.getElementById('upload-area');
    const screenContainerEl = document.getElementById('screen-container');
    const helpEl = document.getElementById('help');
    const v11ControlsGuard = document.getElementById('v11-controls-guard');
    const v12LoginFirst = document.getElementById('v12-login-first');
    let gameLoaded = false;
    let shouldConnectWs = false;
    let wsReconnectTimer = null;
    let wsConnecting = false;
    function reconnectWsSoon(delay = 250) {
      if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
      wsReconnectTimer = setTimeout(() => {
        if (!shouldConnectWs) return;
        try { if (ws && ws.readyState !== WebSocket.CLOSED) ws.close(); } catch(e) {}
        ws = null;
        wsConnecting = false;
        connect();
      }, delay);
    }
    function setGameUiVisible(show) {
      gameLoaded = !!show;
      if (v11ControlsGuard) v11ControlsGuard.disabled = !!show;
      if (controlsEl) controlsEl.style.display = show ? 'grid' : 'none';
      if (show) { try { canvas.focus(); } catch(e) {} }
    }
    function setLoggedInUi(show) {
      document.body.classList.toggle('v16-login-mode', !show);
      if (v12LoginFirst) v12LoginFirst.disabled = !!show;
      if (uploadAreaEl) uploadAreaEl.style.display = show ? '' : 'none';
      if (screenContainerEl) screenContainerEl.style.display = show ? '' : 'none';
      if (helpEl) helpEl.style.display = show ? '' : 'none';
      if (audioToggle) audioToggle.style.display = show ? '' : 'none';
      if (adaptiveDebugEl) adaptiveDebugEl.style.display = show ? '' : 'none';
      if (adaptiveButtonsEl) adaptiveButtonsEl.style.display = show ? 'flex' : 'none';
      if (loginUser) loginUser.style.display = show ? 'none' : '';
      if (loginPass) loginPass.style.display = show ? 'none' : '';
      if (btnLogin) btnLogin.style.display = show ? 'none' : '';
      if (btnRegister) btnRegister.style.display = show ? 'none' : '';
      if (!show) setGameUiVisible(false);
    }
    setLoggedInUi(false);
    setGameUiVisible(false);
    let currentUser = null;
    async function api(path, body) { const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? {'Content-Type':'application/json'} : {}, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(()=>({})); if(!r.ok) throw new Error(j.error || r.statusText); return j; }
    async function refreshMe() {
      try { const j = await api('/api/me'); currentUser = j.user; } catch(e) { currentUser = null; }
      meLabel.textContent = currentUser ? ('Đăng nhập: ' + currentUser.username) : 'Vui lòng đăng nhập hoặc đăng ký để bắt đầu';
      btnLogout.style.display = currentUser ? '' : 'none';
      setLoggedInUi(!!currentUser);
      shouldConnectWs = !!currentUser;
      if (!currentUser) setStatus('Vui lòng đăng nhập', 'connecting');
    }
    btnLogin.onclick = async () => { try { setGameUiVisible(false); await api('/api/login', { username: loginUser.value, password: loginPass.value }); await refreshMe(); if(ws) ws.close(); setTimeout(connect, 100); } catch(e) { alert(e.message); } };
    btnRegister.onclick = async () => { try { setGameUiVisible(false); await api('/api/register', { username: loginUser.value, password: loginPass.value }); await api('/api/login', { username: loginUser.value, password: loginPass.value }); await refreshMe(); if(ws) ws.close(); setTimeout(connect, 100); } catch(e) { alert(e.message); } };
    btnLogout.onclick = async () => { shouldConnectWs = false; setLoggedInUi(false); await api('/api/logout', {}); await refreshMe(); if(ws) ws.close(); };
    [loginUser, loginPass].forEach(el => el && el.addEventListener('keydown', e => { if (e.key === 'Enter') btnLogin.click(); }));
    refreshMe().then(() => { if (currentUser) setTimeout(connect, 100); });

    let audioCtx = null, audioUnlocked = false, audioMuted = false, audioNextTime = 0;
    let audioFormat = { sampleRate: 48000, channels: 2, bits: 16, signed: true, bigEndian: false };
    let opusAudioUrl = null;
    let opusAudioEl = null;
    let opusDecoder = null;
    let opusSampleRate = 48000;
    let opusChannels = 1;
    let videoCodec = 'rgba';
    let imageQuality = 100;
    let transportProfile = 'local';
    let audioAdaptiveBuffer = true;
    let adaptiveLevel = 0, adaptiveCount = 1;
    let audioCodecMode = 'pcm';
    let opusScriptAvailable = false;
    let audioPacketMs = 40;
    let audioStartBufferSec = 0.11;
    let audioMinBufferSec = 0.07;
    let audioMaxBufferSec = 0.26;
    let audioTargetBufferSec = audioStartBufferSec;
    let audioUnderruns = 0, audioStablePackets = 0, audioDroppedPackets = 0;
    function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
    function setAudioButton(t, title) { if(audioToggle){ audioToggle.textContent=t; if(title) audioToggle.title=title; } }
    function sendDebugAdaptive(mode, amount){ if(!isConnected || !ws || ws.readyState !== WebSocket.OPEN) return; ws.send(JSON.stringify({ type:'debugAdaptive', mode, amount })); }
    function sendAudioMode(mode, reason){ if(!isConnected || !ws || ws.readyState !== WebSocket.OPEN) return; ws.send(JSON.stringify({ type:'audioMode', mode, reason })); }
    if(adaptiveButtonsEl){
      const defs = [10,20,30,50,100];
      defs.forEach((n) => {
        const btn = document.createElement('button');
        btn.textContent = 'Drop +' + n;
        btn.style.cssText = 'padding:6px 10px;border:0;border-radius:10px;background:#5a2b2b;color:#fff;cursor:pointer';
        btn.onclick = () => sendDebugAdaptive('drop', n);
        adaptiveButtonsEl.appendChild(btn);
      });
      const resetBtn = document.createElement('button');
      resetBtn.textContent = 'Reset level';
      resetBtn.style.cssText = 'padding:6px 10px;border:0;border-radius:10px;background:#245a2b;color:#fff;cursor:pointer';
      resetBtn.onclick = () => sendDebugAdaptive('reset', 0);
      adaptiveButtonsEl.appendChild(resetBtn);
      const pcmBtn = document.createElement('button');
      pcmBtn.textContent = 'Force PCM';
      pcmBtn.style.cssText = 'padding:6px 10px;border:0;border-radius:10px;background:#23485a;color:#fff;cursor:pointer';
      pcmBtn.onclick = () => sendAudioMode('pcm', 'debug-force-pcm');
      adaptiveButtonsEl.appendChild(pcmBtn);
      const autoBtn = document.createElement('button');
      autoBtn.textContent = 'Audio Auto';
      autoBtn.style.cssText = 'padding:6px 10px;border:0;border-radius:10px;background:#3a3a5a;color:#fff;cursor:pointer';
      autoBtn.onclick = () => sendAudioMode('auto', 'debug-audio-auto');
      adaptiveButtonsEl.appendChild(autoBtn);
    }
    function ensureAudioContext(){ if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)({latencyHint:'playback'}); return audioCtx; }
    function browserTestBeep(){ try{ const ctx=ensureAudioContext(); const o=ctx.createOscillator(), g=ctx.createGain(); o.frequency.value=880; g.gain.setValueAtTime(0.001,ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.10,ctx.currentTime+0.015); g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+0.16); o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime+0.18);}catch(e){} }
    function applyAudioTuning(msg){
      if(!msg) return;
      transportProfile = msg.transportProfile || transportProfile || 'local';
      audioAdaptiveBuffer = msg.audioAdaptiveBuffer !== false;
      adaptiveLevel = (msg.adaptiveLevel ?? adaptiveLevel) | 0;
      adaptiveCount = Math.max(1, (msg.adaptiveCount ?? adaptiveCount) | 0);
      opusScriptAvailable = !!msg.opusScriptAvailable;
      audioCodecMode = msg.audioCodec || audioCodecMode || 'pcm';
      audioPacketMs = Math.max(10, Math.min(120, msg.audioPacketMs || audioPacketMs || 40));
      audioStartBufferSec = clamp((msg.audioStartBufferMs || (transportProfile === 'remote' ? 180 : 110)) / 1000, 0.04, 0.50);
      audioMinBufferSec = clamp((msg.clientAudioMinBufferMs || (transportProfile === 'remote' ? 120 : 70)) / 1000, 0.04, 0.50);
      audioMaxBufferSec = clamp((msg.clientAudioMaxBufferMs || (transportProfile === 'remote' ? 420 : 260)) / 1000, audioMinBufferSec, 1.00);
      audioTargetBufferSec = clamp(audioTargetBufferSec || audioStartBufferSec, audioMinBufferSec, audioMaxBufferSec);
    }
    function resetAudioScheduler(){ if(audioCtx) audioNextTime = audioCtx.currentTime + audioTargetBufferSec; }
    let opusProbeTimer = null, opusPlayingConfirmed = false;
    function clearOpusProbe(){ if(opusProbeTimer){ clearTimeout(opusProbeTimer); opusProbeTimer = null; } }
    function requestPcmFallback(reason){ if(audioCodecMode !== 'opus') return; console.warn('Opus fallback -> PCM:', reason); audioCodecMode = 'pcm'; opusAudioUrl = null; stopOpusAudio(); sendAudioMode('pcm', reason); refreshAudioButtonTitle('fallback-pcm ' + reason); }
    function attachOpusEvents(){
      if(!opusAudioEl || opusAudioEl._fj2meEventsAttached) return;
      opusAudioEl._fj2meEventsAttached = true;
      const good = () => { opusPlayingConfirmed = true; clearOpusProbe(); refreshAudioButtonTitle('opus-playing'); };
      const bad = (ev) => { if(audioCodecMode === 'opus') requestPcmFallback('opus-' + ev.type); };
      ['playing','canplay','timeupdate'].forEach(name => opusAudioEl.addEventListener(name, good));
      ['error','stalled','abort','emptied'].forEach(name => opusAudioEl.addEventListener(name, bad));
    }
    function stopOpusDecoder(){ if(opusDecoder && opusDecoder.delete){ try{ opusDecoder.delete(); }catch(e){} } opusDecoder = null; }
    function ensureOpusDecoder(){
      if(audioCodecMode !== 'opus') return null;
      if(typeof window.OpusScript === 'undefined') return null;
      if(opusDecoder && opusDecoder._fjRate === opusSampleRate && opusDecoder._fjChannels === opusChannels) return opusDecoder;
      stopOpusDecoder();
      try {
        opusDecoder = new window.OpusScript(opusSampleRate, opusChannels, window.OpusScript.Application.AUDIO);
        opusDecoder._fjRate = opusSampleRate;
        opusDecoder._fjChannels = opusChannels;
        return opusDecoder;
      } catch(e) {
        console.warn('Opus decoder init failed:', e);
        return null;
      }
    }
    function stopOpusAudio(){ clearOpusProbe(); opusPlayingConfirmed = false; stopOpusDecoder(); if(opusAudioEl){ try{ opusAudioEl.pause(); }catch(e){} try{ opusAudioEl.removeAttribute('src'); opusAudioEl.load(); }catch(e){} } }
    function updateAdaptiveDebug(extra){
      if(!adaptiveDebugEl) return;
      const codec = audioCodecMode || (opusAudioUrl ? 'opus' : 'pcm');
      adaptiveDebugEl.textContent = 'Adaptive level ' + (adaptiveLevel + 1) + '/' + adaptiveCount + ' | video=' + videoCodec + ' q=' + imageQuality + ' | audio=' + codec + ' | packet=' + audioPacketMs + 'ms | drop=' + audioDroppedPackets + ' | underrun=' + audioUnderruns + (extra ? ' | ' + extra : '');
    }
    function refreshAudioButtonTitle(extra){
      const state = audioUnlocked && !audioMuted ? '🔊 Âm thanh: bật' : '🔇 Bật âm thanh';
      const codec = audioCodecMode || (opusAudioUrl ? 'opus' : 'pcm');
      const title = 'codec=' + codec + ' opusScript=' + (opusScriptAvailable ? 'on' : 'off') + ' profile=' + transportProfile + ' ladder=' + (adaptiveLevel + 1) + '/' + adaptiveCount + ' target=' + Math.round(audioTargetBufferSec*1000) + 'ms min=' + Math.round(audioMinBufferSec*1000) + 'ms max=' + Math.round(audioMaxBufferSec*1000) + 'ms packet=' + audioPacketMs + 'ms underrun=' + audioUnderruns + ' drop=' + audioDroppedPackets + (extra ? ' ' + extra : '');
      setAudioButton(state, title);
      updateAdaptiveDebug(extra || 'ready');
    }
    function startOpusAudio(){ if(audioCodecMode !== 'opus') return; const dec = ensureOpusDecoder(); if(!dec){ requestPcmFallback('opus-decoder'); return; } opusPlayingConfirmed = true; clearOpusProbe(); refreshAudioButtonTitle('opus-decoder-ready'); }
    function unlockAudio(){ const ctx=ensureAudioContext(); ctx.resume(); audioUnlocked=true; audioMuted=false; audioTargetBufferSec = clamp(audioTargetBufferSec || audioStartBufferSec, audioMinBufferSec, audioMaxBufferSec); audioNextTime=ctx.currentTime+audioTargetBufferSec; refreshAudioButtonTitle(); browserTestBeep(); if(audioCodecMode === 'opus') startOpusAudio(); }
    audioToggle.onclick = () => { if(!audioUnlocked) unlockAudio(); else { audioMuted=!audioMuted; if(opusAudioEl) opusAudioEl.muted = audioMuted; if(!audioMuted){ resetAudioScheduler(); browserTestBeep(); if(audioCodecMode === 'opus') startOpusAudio(); } refreshAudioButtonTitle(); } };
    function isAudioPacket(u8){ return u8 && u8.length>=5 && u8[0]===0x46 && u8[1]===0x4A && u8[2]===0x32 && u8[3]===0x41; }
    function handleAudioStatus(msg){ applyAudioTuning(msg); if(audioCodecMode === 'opus'){ if(audioUnlocked && !audioMuted) startOpusAudio(); } else { opusAudioUrl = null; stopOpusAudio(); } if(msg.event === 'adaptive-profile'){ console.log('[adaptive]', msg.adaptiveLevel + 1, '/', msg.adaptiveCount, msg); setStatus('Adaptive level ' + (msg.adaptiveLevel + 1) + '/' + msg.adaptiveCount + ' | ' + videoCodec + ' | ' + audioCodecMode, 'connected'); } refreshAudioButtonTitle('fmt='+(msg.formatPackets||0)+' pcm='+(msg.pcmPackets||0)); }
    function scheduleDecodedPcm(sampleRate, channels, pcmBytes){
      if(!audioUnlocked || audioMuted || !audioCtx || !pcmBytes || pcmBytes.length < 2) return true;
      const chs=Math.max(1, channels|0), frames=Math.floor(pcmBytes.length/(2*chs)); if(frames<=0) return true;
      const buf=audioCtx.createBuffer(chs,frames,sampleRate||48000);
      const cd=[]; for(let c=0;c<chs;c++) cd[c]=buf.getChannelData(c); let off=0;
      for(let i=0;i<frames;i++){ for(let c=0;c<chs;c++){ let smp=(pcmBytes[off]|(pcmBytes[off+1]<<8)); if(smp>=0x8000)smp-=0x10000; cd[c][i]=Math.max(-1,Math.min(1,smp/32768)); off+=2; } }
      const nowAudio=audioCtx.currentTime;
      if(!audioNextTime || audioNextTime < nowAudio + 0.02) {
        audioUnderruns++;
        audioStablePackets = 0;
        if(audioAdaptiveBuffer) audioTargetBufferSec = clamp(audioTargetBufferSec + 0.03, audioMinBufferSec, audioMaxBufferSec);
        audioNextTime = nowAudio + audioTargetBufferSec;
      } else if(audioAdaptiveBuffer) {
        const bufferedAhead = audioNextTime - nowAudio;
        if(bufferedAhead < audioMinBufferSec * 0.75) audioTargetBufferSec = clamp(audioTargetBufferSec + 0.015, audioMinBufferSec, audioMaxBufferSec);
        else {
          audioStablePackets++;
          if(audioStablePackets >= Math.max(8, Math.round(240 / audioPacketMs)) && audioTargetBufferSec > audioMinBufferSec) {
            audioTargetBufferSec = clamp(audioTargetBufferSec - 0.005, audioMinBufferSec, audioMaxBufferSec);
            audioStablePackets = 0;
          }
        }
      }
      if(audioNextTime > nowAudio + Math.max(audioMaxBufferSec + 0.15, 0.9)) { audioDroppedPackets++; refreshAudioButtonTitle('drop-backlog'); return true; }
      const src=audioCtx.createBufferSource(); src.buffer=buf; src.connect(audioCtx.destination);
      src.start(audioNextTime); audioNextTime += buf.duration;
      return true;
    }
    function handleAudioPacket(u8){
      if(!isAudioPacket(u8)) return false;
      const type=u8[4]; const dv=new DataView(u8.buffer,u8.byteOffset,u8.byteLength);
      if(type===1 && u8.length>=13){ audioFormat={sampleRate:dv.getUint32(5,false),channels:u8[9]||1,bits:u8[10]||16,signed:u8[11]!==0,bigEndian:u8[12]!==0}; if(audioCtx) resetAudioScheduler(); refreshAudioButtonTitle('format'); return true; }
      if(type===3 && u8.length>=13){ opusSampleRate=dv.getUint32(5,false)||48000; opusChannels=u8[9]||1; if(audioCtx) resetAudioScheduler(); if(audioUnlocked && !audioMuted) startOpusAudio(); refreshAudioButtonTitle('opus-format'); return true; }
      if(type===4){
        const len=dv.getUint32(5,false);
        if(len<=0||9+len>u8.length||audioCodecMode!=='opus') return true;
        const dec = ensureOpusDecoder();
        if(!dec){ requestPcmFallback('opus-decoder-missing'); return true; }
        try {
          const decoded = dec.decode(u8.slice(9,9+len));
          return scheduleDecodedPcm(opusSampleRate, opusChannels, decoded);
        } catch(e) {
          console.warn('Opus decode failed:', e);
          requestPcmFallback('opus-decode');
          return true;
        }
      }
      if(type!==2 || u8.length<9) return true;
      const len=dv.getUint32(5,false);
      if(len<=0||9+len>u8.length||audioFormat.bits!==16) return true;
      return scheduleDecodedPcm(audioFormat.sampleRate||48000, Math.max(1,audioFormat.channels|0), u8.slice(9,9+len));
    }

    // PERF: render latest frame only, reuse ImageData through replacement drawFrame below.
    let latestFrame = null, rafPending = false, reusableImageData = null;
    async function drawWebpFrame(src) {
      const blob = new Blob([src], { type: 'image/webp' });
      const bitmap = await createImageBitmap(blob);
      ctx.drawImage(bitmap, 0, 0, screenWidth, screenHeight);
      bitmap.close && bitmap.close();
      return true;
    }
    function decodeVideoFrameToImageData(src, imageData) {
      const dst = imageData.data;
      const pixels = screenWidth * screenHeight;
      let codec = videoCodec;
      if (codec !== 'webp') {
        if (src.length >= pixels * 4) codec = 'rgba';
        else if (src.length >= pixels * 2) codec = 'rgb565';
        else if (src.length >= pixels) codec = 'rgb332';
      }
      if (codec === 'rgb332') {
        if (src.length < pixels) return false;
        for (let i = 0, j = 0; i < pixels; i++, j += 4) {
          const v = src[i];
          dst[j] = Math.round(((v >> 5) & 7) * 255 / 7);
          dst[j + 1] = Math.round(((v >> 2) & 7) * 255 / 7);
          dst[j + 2] = Math.round((v & 3) * 255 / 3);
          dst[j + 3] = 255;
        }
        return true;
      }
      if (codec === 'rgb565') {
        if (src.length < pixels * 2) return false;
        for (let i = 0, k = 0, j = 0; i < pixels; i++, k += 2, j += 4) {
          const v = src[k] | (src[k + 1] << 8);
          dst[j] = Math.round(((v >> 11) & 31) * 255 / 31);
          dst[j + 1] = Math.round(((v >> 5) & 63) * 255 / 63);
          dst[j + 2] = Math.round((v & 31) * 255 / 31);
          dst[j + 3] = 255;
        }
        return true;
      }
      const expectedSize = pixels * 4;
      if (src.length < expectedSize) return false;
      dst.set(src.subarray(0, expectedSize));
      return true;
    }
    function scheduleDraw(){ if(rafPending) return; rafPending=true; requestAnimationFrame(async()=>{ rafPending=false; if(!latestFrame) return; try { if(videoCodec === 'webp') { await drawWebpFrame(latestFrame); } else { if(!reusableImageData || reusableImageData.width!==screenWidth || reusableImageData.height!==screenHeight) reusableImageData=ctx.createImageData(screenWidth, screenHeight); if(!decodeVideoFrameToImageData(latestFrame, reusableImageData)) return; ctx.putImageData(reusableImageData,0,0); } frameCount++; const n=performance.now(); if(n-lastFpsTime>=1000){ fpsEl.textContent=frameCount+' FPS ['+videoCodec+' q'+imageQuality+']'; frameCount=0; lastFpsTime=n; } } catch(e) { console.warn('draw frame failed', e); } }); }
  `;
  html = html.replace("    const jarInput = document.getElementById('jar-input');", "    const jarInput = document.getElementById('jar-input');\n" + injected);
  html = html.replace('          drawFrame(new Uint8Array(event.data));', '          const u8 = new Uint8Array(event.data);\n          if (!handleAudioPacket(u8)) { latestFrame = u8; scheduleDraw(); }');
  // V24: nhận videoCodec/imageQuality từ config packet. Bản V15 thiếu đoạn này nên client tưởng frame là RGBA và bị đen màn hình.
  html = html.replace(
    '            screenHeight = msg.height;\n            canvas.width = screenWidth;',
    "            screenHeight = msg.height;\n            videoCodec = msg.videoCodec || videoCodec || 'rgba';\n            imageQuality = msg.imageQuality || imageQuality || 100;\n            applyAudioTuning(msg);\n            refreshAudioButtonTitle();\n            canvas.width = screenWidth;"
  );

  // V24: connection guard để tránh kẹt noGame và tránh tạo 2 socket/audio chồng.
  html = html.replace(
    "      ws.onopen = () => {\n        isConnected = true;",
    "      ws.onopen = () => {\n        wsConnecting = false;\n        isConnected = true;"
  );
  html = html.replace(
    "      ws.onclose = () => {\n        isConnected = false;",
    "      ws.onclose = () => {\n        wsConnecting = false;\n        isConnected = false;"
  );

  // V24: không tự WebSocket reconnect khi chưa đăng nhập, để form login/register gõ bình thường.
  html = html.replace('    function connect() {', '    function connect() {\n      if (!shouldConnectWs) return;\n      if (wsConnecting) return;\n      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;\n      wsConnecting = true;');
  html = html.replace('        setTimeout(connect, 2000);', '        if (shouldConnectWs) setTimeout(connect, 2000);');
  html = html.replace('    connect();', '    // V24: connect() được gọi sau khi đăng nhập thành công; không tự connect ở màn hình login.');
  html = html.replace("setStatus(`Đã kết nối - ${screenWidth}x${screenHeight}`, 'connected');\n          }", "setStatus(`Đã kết nối - ${screenWidth}x${screenHeight}`, 'connected');\n          } else if (msg.type === 'audio-status') {\n            handleAudioStatus(msg);\n          } else if (msg.type === 'auth') {\n            if (msg.noGame) {\n              setLoggedInUi(true);\n              setGameUiVisible(false);\n              setStatus('Đã đăng nhập - hãy upload game', 'connected');\n            } else if (msg.gameHash) {\n              setLoggedInUi(true);\n              setGameUiVisible(true);\n              if (msg.audioUrl) { opusAudioUrl = msg.audioUrl; if (audioUnlocked && !audioMuted) startOpusAudio(); }\n            }\n          } else if (msg.type === 'status') {\n            if (msg.state === 'loading') {\n              setGameUiVisible(false);\n              setStatus('Đang tải game mới...', 'connecting');\n              try { ctx.clearRect(0, 0, canvas.width, canvas.height); latestFrame = null; } catch(e) {}\n            } else if (msg.state === 'running') {\n              setLoggedInUi(true);\n            } else if (msg.state === 'no-video-yet') {\n              setStatus('Game đang chạy nhưng chưa có hình - thử VIDEO_CODEC=rgba hoặc xem log server', 'error');\n            }\n          }");
  // V24: ẩn bàn phím ảo trong lúc chưa tải game / đang upload.
  html = html.replace(
    "uploadStatus.textContent = 'Đang upload...';",
    "uploadStatus.textContent = 'Đang upload...';\n      setGameUiVisible(false);"
  );
  // V24: sau upload thành công, reconnect WS để bind vào emulator session mới.
  html = html.replace(
    "uploadStatus.textContent = `Đang chạy: ${file.name}`;",
    "uploadStatus.textContent = `Đang chạy: ${file.name}`;\n          // V24: reconnect an toàn 1 lần để chắc chắn socket bind vào session mới.\n          reconnectWsSoon(250);"
  );

  // V24: Cho phép gõ bình thường trong ô login/register/upload.
  // index.html gốc bắt keydown toàn window và preventDefault với các phím W/A/S/D/Q/E/Z/C/0-9,
  // làm input username/password không gõ được. Chặn input focus trước khi keyMap xử lý.
  const inputGuard = `
    function isTypingTarget(e) {
      const t = e && e.target;
      if (!t) return false;
      const tag = (t.tagName || '').toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
    }
  `;
  html = html.replace('    const pressedKeys = new Set();', inputGuard + '\n    canvas.setAttribute("tabindex", "0");\n    canvas.style.outline = "none";\n    canvas.addEventListener("mousedown", () => { try { canvas.focus(); } catch(e) {} });\n    canvas.addEventListener("touchstart", () => { try { canvas.focus(); } catch(e) {} }, { passive: false });\n    const swallowGameKey = (e) => { if (!gameLoaded || isTypingTarget(e)) return; if (e.ctrlKey || e.metaKey || e.altKey) return; const keyIndex = keyMap[e.key] ?? keyMap[e.code]; if (keyIndex === undefined) return; e.preventDefault(); try { canvas.focus(); } catch(err) {} };\n    document.addEventListener("keydown", swallowGameKey, true);\n    document.addEventListener("keypress", swallowGameKey, true);\n    document.addEventListener("keyup", (e) => { if (!gameLoaded || isTypingTarget(e)) return; if (e.ctrlKey || e.metaKey || e.altKey) return; const keyIndex = keyMap[e.key] ?? keyMap[e.code]; if (keyIndex === undefined) return; e.preventDefault(); }, true);\n    const pressedKeys = new Set();');
  html = html.replace(
    "window.addEventListener('keydown', (e) => {\n      const keyIndex = keyMap[e.key] ?? keyMap[e.code];",
    "window.addEventListener('keydown', (e) => {\n      if (isTypingTarget(e)) return;\n      const keyIndex = keyMap[e.key] ?? keyMap[e.code];"
  );
  html = html.replace(
    "window.addEventListener('keyup', (e) => {\n      const keyIndex = keyMap[e.key] ?? keyMap[e.code];",
    "window.addEventListener('keyup', (e) => {\n      if (isTypingTarget(e)) return;\n      const keyIndex = keyMap[e.key] ?? keyMap[e.code];"
  );
  return html;
}

// =================== WEB SERVER ===================
function startWebServer() {
  const app = express();
  if (helmet) app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  if (cors && CONFIG.corsOrigin) app.use(cors({ origin: CONFIG.corsOrigin === '*' ? true : CONFIG.corsOrigin, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/', rateLimitMiddleware('api', CONFIG.apiRateLimit));
  ensureDir(CONFIG.uploadsDir); ensureDir(CONFIG.dataDir);

  app.get('/api/me', (req, res) => res.json({ user: db.publicUser(requireUser(req, null)) }));
  app.post('/api/register', rateLimitMiddleware('auth-register', CONFIG.authRateLimit), (req, res) => { try { const u = db.register(req.body.username, req.body.password, getIp(req)); res.json({ success: true, user: db.publicUser(u) }); } catch (e) { res.status(400).json({ error: e.message }); } });
  app.post('/api/login', rateLimitMiddleware('auth-login', CONFIG.authRateLimit), async (req, res) => { try { const { sid, user } = db.login(req.body.username, req.body.password); if (CONFIG.sessionPolicy === 'single') { closeUserSockets(user.id, 'logged_in_elsewhere'); await stopOtherSessionsForUser(user.id); } setCookie(res, 'fj2me_sid', sid, { maxAge: 30 * 24 * 3600 }); res.json({ success: true, user: db.publicUser(user), sessionPolicy: CONFIG.sessionPolicy }); } catch (e) { res.status(401).json({ error: e.message }); } });
  app.post('/api/logout', (req, res) => { db.logout(parseCookies(req).fj2me_sid); clearCookie(res, 'fj2me_sid'); res.json({ success: true }); });
  app.get('/api/queue', (req, res) => res.json({ success: true, queue: startQueue.status(), activeSessions: emulatorSessions.size, limits: { maxActiveSessions: CONFIG.maxActiveSessions, maxWsPerIp: CONFIG.maxWsPerIp, maxClientsPerInstance: CONFIG.maxClientsPerInstance } }));
  app.get('/api/storage', (req, res) => {
    const user = requireUser(req, res); if (!user) return;
    const userBytes = getUserStorageBytes(user.id);
    res.json({ success: true, userBytes, userMb: +(userBytes/1024/1024).toFixed(2), maxUserStorageMb: CONFIG.maxUserStorageMb, uploadsBytes: dirSizeBytes(CONFIG.uploadsDir), totalDataBytes: dirSizeBytes(CONFIG.dataDir) });
  });
  app.post('/api/admin/cleanup', (req, res) => { const user = requireUser(req, res); if (!user) return; runStorageCleanup(); res.json({ success: true }); });

  const storage = multer.diskStorage({ destination: (req, file, cb) => cb(null, CONFIG.uploadsDir), filename: (req, file, cb) => cb(null, `game_${Date.now()}_${Math.random().toString(36).slice(2)}${path.extname(file.originalname) || '.jar'}`) });
  const upload = multer({ storage, limits: { fileSize: CONFIG.maxUploadMb * 1024 * 1024 } });
  app.post('/upload', rateLimitMiddleware('upload', CONFIG.uploadRateLimit), upload.single('jar'), async (req, res) => {
    const user = requireUser(req, res); if (!user) return;
    if (!req.file) return res.status(400).json({ error: 'Không có file' });
    try {
      const result = await withUserSessionLock(user.id, async () => {
        enforceUserStorageQuota(user.id);
        enforceTotalStorageQuota();
        const jarPath = path.resolve(req.file.path);
        const gameHash = sha1File(jarPath);
        if (emulatorSessions.size >= CONFIG.maxActiveSessions && !getActiveSessionForUser(user.id)) throw new Error('Server đã đạt giới hạn session đang chạy');
        // Serialize per-user upload/session replacement to avoid tearing down the shared backend on rapid re-upload.
        await stopOtherSessionsForUser(user.id, `${user.id}:${gameHash}`);
        const sess = getOrCreateSession(user, gameHash, jarPath);
        if (wss) {
          wss.clients.forEach((ws) => {
            if (ws.readyState === WebSocket.OPEN && ws._userId === user.id) sess.addClient(ws);
          });
        }
        sess.broadcastJson({ type: 'status', state: 'loading', gameHash });
        await sess.start();
        if (wss) {
          wss.clients.forEach((ws) => {
            if (ws.readyState === WebSocket.OPEN && ws._userId === user.id && ws._emuSession !== sess) sess.addClient(ws);
          });
        }
        return { gameHash, dataDir: sess.dataDir };
      });
      res.json({ success: true, gameHash: result.gameHash, jar: req.file.filename, user: db.publicUser(user), dataDir: result.dataDir });
    } catch (e) { if (req.file && req.file.path) removePathSafe(req.file.path); console.error('[Upload]', e); res.status(500).json({ error: e.message }); }
  });

  app.get('/audio/:id.webm', (req, res) => {
    const sess = publicSessionIds.get(req.params.id);
    if (!sess || !sess.isRunning || !sess.shouldUseOpus()) {
      res.status(404).end('audio stream not found');
      return;
    }
    sess.addAudioHttpClient(res);
  });

  app.get(['/', '/index.html'], (req, res) => { try { res.type('html').send(getPatchedIndexHtml()); } catch (e) { console.error('[Web]', e); res.sendFile(path.join(__dirname, 'public', 'index.html')); } });
  app.use(express.static(path.join(__dirname, 'public')));

  const server = http.createServer(app);
  wss = new WebSocket.Server({ server, perMessageDeflate: CONFIG.wsCompression ? { zlibDeflateOptions: { level: 1, memLevel: 7 }, clientNoContextTakeover: true, serverNoContextTakeover: true, threshold: 1024 } : false });
  console.log(`[Stream] mode=single-java profile=${CONFIG.transportProfile}, adaptiveStreaming=${CONFIG.adaptiveStreaming ? 'on' : 'off'}, adaptiveLevels=${ADAPTIVE_PROFILES.length}, adaptiveWindowMs=${CONFIG.adaptiveWindowMs}, recoverWindows=${CONFIG.adaptiveRecoverWindows}, startCodec=${ADAPTIVE_PROFILES[0].videoCodec}/${ADAPTIVE_PROFILES[0].audioCodec}, endCodec=${ADAPTIVE_PROFILES[ADAPTIVE_PROFILES.length - 1].videoCodec}/${ADAPTIVE_PROFILES[ADAPTIVE_PROFILES.length - 1].audioCodec}, sharp=${sharp ? 'on' : 'off'}, opusScript=${OPUS_PROBE.available ? 'on' : 'off:' + OPUS_PROBE.reason}, audioPipe=${CONFIG.audioPipe ? 'on' : 'off'}, maxBuffered=${CONFIG.maxWsBufferedAmount}, noClientShutdownMs=${CONFIG.noClientShutdownMs}, inputIdleShutdownMs=${CONFIG.inputIdleShutdownMs}, sessionPolicy=${CONFIG.sessionPolicy}, queue=${CONFIG.startConcurrency}/${CONFIG.queueMaxSize}, maxUploadMb=${CONFIG.maxUploadMb}, maxUserStorageMb=${CONFIG.maxUserStorageMb}`);
  console.log(`[Auth] JSON DB: ${CONFIG.dbPath}`);
  console.log(`[Runtime] java=${CONFIG.javaPath}`);
  console.log(`[Runtime] sharedJar=${CONFIG.freej2meJar}`);
  console.log(`[Runtime] javaBackend=ws://${CONFIG.javaBackendHost}:${CONFIG.javaBackendPort}`);

  wss.on('connection', (ws, req) => {
    const user = db.getUserBySession(parseCookies(req).fj2me_sid);
    if (!user) { ws.send(JSON.stringify({ type: 'error', error: 'not_logged_in' })); ws.close(); return; }
    ws._userId = user.id;
    const sess = getActiveSessionForUser(user.id);
    if (!sess) {
      const p = ADAPTIVE_PROFILES[0] || { streamScale: CONFIG.streamScale, videoCodec: CONFIG.videoCodec, imageQuality: CONFIG.imageQuality, webpQuality: CONFIG.webpQuality, audioPacketMs: CONFIG.audioPacketMs, audioStartBufferMs: CONFIG.audioStartBufferMs, clientAudioMinBufferMs: CONFIG.clientAudioMinBufferMs, clientAudioMaxBufferMs: CONFIG.clientAudioMaxBufferMs, audioCodec: CONFIG.audioCodec };
      ws.send(JSON.stringify({ type: 'auth', user: db.publicUser(user), noGame: true }));
      ws.send(JSON.stringify({ type: 'config', width: Math.floor(CONFIG.width / p.streamScale), height: Math.floor(CONFIG.height / p.streamScale), scale: p.streamScale, videoCodec: p.videoCodec, imageQuality: p.imageQuality, webpQuality: p.webpQuality, opusScriptAvailable: OPUS_PROBE.available, transportProfile: CONFIG.transportProfile, audioAdaptiveBuffer: CONFIG.audioAdaptiveBuffer, adaptiveLevel: 0, adaptiveCount: ADAPTIVE_PROFILES.length, audioPacketMs: p.audioPacketMs, audioStartBufferMs: p.audioStartBufferMs, clientAudioMinBufferMs: p.clientAudioMinBufferMs, clientAudioMaxBufferMs: p.clientAudioMaxBufferMs, audioCodec: p.audioCodec }));
    }
    else sess.addClient(ws);
    ws.on('message', msg => {
      try {
        const s = ws._emuSession || getActiveSessionForUser(user.id); if (!s) return; s.touch();
        const data = JSON.parse(msg.toString());
        if (data.type === 'key' || data.type === 'touch') s.markInputActivity();
        if (data.type === 'key') { if (data.state === 'D') s.sendKeyDown(data.key); else if (data.state === 'U') s.sendKeyUp(data.key); }
        else if (data.type === 'touch') { let cmd = data.state === 'D' ? 5 : data.state === 'U' ? 4 : data.state === 'M' ? 6 : 0; if (cmd) { if (cmd === 6) { const nowMs = Date.now(); if (nowMs - (s._lastDragAt || 0) < 16) return; s._lastDragAt = nowMs; } const scale = Math.max(1, ((s.getCurrentProfile ? s.getCurrentProfile().streamScale : CONFIG.streamScale) || 1) | 0); const x = data.x < 0 ? data.x : Math.max(0, Math.min(s.emuFrameWidth - 1, Math.floor(data.x * scale))); const y = data.y < 0 ? data.y : Math.max(0, Math.min(s.emuFrameHeight - 1, Math.floor(data.y * scale))); s.sendMouse(cmd, x, y); } }
        else if (data.type === 'audioMode') { s.setClientAudioMode(data.mode, data.reason || 'client'); }
        else if (data.type === 'debugAdaptive') {
          if (String(data.mode || '') === 'reset') s.debugAdaptiveReset('debug-reset');
          else s.debugAdaptiveDrop(parseInt(data.amount || 1, 10) || 1, 'debug-drop');
        }
      } catch (e) { console.error('[WS]', e.message); }
    });
  });

  server.listen(CONFIG.port, '0.0.0.0', () => console.log(`[WebServer] http://localhost:${CONFIG.port}`));
}

// =================== MAIN ===================
async function main() {
  ensureDir(CONFIG.uploadsDir);
  ensureDir(CONFIG.dataDir);
  acquireServerLock();
  validateRuntimePaths();
  javaBackend = new JavaBackend();
  await javaBackend.ensureRunning();
  runStorageCleanup();
  setInterval(runStorageCleanup, CONFIG.cleanupIntervalMs);
  startWebServer();
}
main().catch(err => { console.error('Lỗi nghiêm trọng:', err); releaseServerLock(); process.exit(1); });
