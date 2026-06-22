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
const WebSocket = require('ws');
let sharp = null;
try { sharp = require('sharp'); } catch (e) { /* optional: VIDEO_CODEC=webp will fallback if missing */ }

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

  function resolveFreej2meJar(p) {
    const audioCandidates = [
      'freej2me-lr-audiopipe-v2-debug.jar',
      'freej2me-lr-audiopipe-v2.jar',
      'freej2me-lr-audiopipe.jar',
      'freej2me-lr-audiopipe-v1.jar',
    ];
    const resolved = resolvePath(p);
    if (!resolved) return path.resolve(__dirname, './freej2me-lr.jar');
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        for (const name of audioCandidates) {
          const candidate = path.join(resolved, name);
          if (fs.existsSync(candidate)) return candidate;
        }
        return path.join(resolved, 'freej2me-lr.jar');
      }
      const dir = path.dirname(resolved);
      for (const name of audioCandidates) {
        const candidate = path.join(dir, name);
        if (fs.existsSync(candidate)) return candidate;
      }
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

  const targetFps = intConfig('TARGET_FPS', fileConfig.targetFps ?? fileConfig.maxFps, 30);

  return {
    javaPath: resolveJavaPath(),
    freej2meJar: process.env.FREEJ2ME_LR_JAR ? resolveFreej2meJar(process.env.FREEJ2ME_LR_JAR) : resolveFreej2meJar(fileConfig.freej2meJar),
    port: intConfig('PORT', fileConfig.port, 3000),

    width: intConfig('SCREEN_WIDTH', fileConfig.width, 240),
    height: intConfig('SCREEN_HEIGHT', fileConfig.height, 320),
    rotate: intConfig('ROTATE', fileConfig.rotate, 0),
    phoneType: intConfig('PHONE_TYPE', fileConfig.phoneType, 0),
    fps: intConfig('FPS', undefined, targetFps),
    sound: intConfig('SOUND', fileConfig.sound, 1),

    maxFps: intConfig('MAX_FPS', fileConfig.maxFps, targetFps),
    streamScale: Math.max(1, intConfig('STREAM_SCALE', fileConfig.streamScale, 1)),
    // V15 video compression without native deps:
    // IMAGE_QUALITY >= 90 => rgba 32-bit, >= 45 => rgb565 16-bit, <45 => rgb332 8-bit.
    // Or set VIDEO_CODEC=rgba|rgb565|rgb332 explicitly.
    imageQuality: Math.max(1, Math.min(100, intConfig('IMAGE_QUALITY', fileConfig.imageQuality, 65))),
    videoCodec: String(process.env.VIDEO_CODEC || fileConfig.videoCodec || '').toLowerCase(),
    webpQuality: Math.max(1, Math.min(100, intConfig('WEBP_QUALITY', fileConfig.webpQuality, 55))),
    webpEffort: Math.max(0, Math.min(6, intConfig('WEBP_EFFORT', fileConfig.webpEffort, 0))),
    maxWsBufferedAmount: intConfig('MAX_WS_BUFFERED', fileConfig.maxWsBufferedAmount, 512 * 1024),
    wsCompression: boolConfig('WS_COMPRESSION', fileConfig.wsCompression, false),
    audioPipe: boolConfig('AUDIO_PIPE', fileConfig.audioPipe, true),

    frameResyncLog: boolConfig('FRAME_RESYNC_LOG', fileConfig.frameResyncLog, false),
    audioDebugLog: boolConfig('AUDIO_DEBUG_LOG', fileConfig.audioDebugLog, false),
    // V21: gom PCM audio thành packet lớn hơn để giảm WebSocket overhead và jitter.
    audioPacketMs: Math.max(10, Math.min(120, intConfig('AUDIO_PACKET_MS', fileConfig.audioPacketMs, 40))),
    audioStartBufferMs: Math.max(40, Math.min(500, intConfig('AUDIO_START_BUFFER_MS', fileConfig.audioStartBufferMs, 180))),
    // V21: optional Opus/WebM HTTP audio stream. Requires ffmpeg.
    audioCodec: String(process.env.AUDIO_CODEC || fileConfig.audioCodec || 'opus').toLowerCase(),
    opusBitrate: String(process.env.OPUS_BITRATE || fileConfig.opusBitrate || '64k'),
    ffmpegPath: process.env.FFMPEG_PATH || fileConfig.ffmpegPath || 'ffmpeg',

    maxActiveSessions: intConfig('MAX_ACTIVE_SESSIONS', fileConfig.maxActiveSessions, 8),
    sessionIdleMs: intConfig('SESSION_IDLE_MS', fileConfig.sessionIdleMs, 10 * 60 * 1000),
    noClientShutdownMs: intConfig('NO_CLIENT_SHUTDOWN_MS', fileConfig.noClientShutdownMs, 5000),
    inputIdleShutdownMs: intConfig('INPUT_IDLE_SHUTDOWN_MS', fileConfig.inputIdleShutdownMs, 0),

    uploadsDir: process.env.UPLOADS_DIR || path.join(__dirname, 'uploads'),
    dataDir: process.env.DATA_DIR || path.join(__dirname, 'freej2me_data'),
    dbPath: process.env.DB_PATH || path.join(__dirname, 'freej2me_data', 'users.json'),
  };
}

const CONFIG = loadConfig();
if (!['rgba', 'rgb565', 'rgb332', 'webp'].includes(CONFIG.videoCodec)) {
  CONFIG.videoCodec = CONFIG.imageQuality >= 90 ? 'rgba' : (CONFIG.imageQuality >= 45 ? 'rgb565' : 'rgb332');
}
if (CONFIG.videoCodec === 'webp' && !sharp) {
  console.warn('[Video] VIDEO_CODEC=webp nhưng sharp chưa cài được. Fallback rgb565. Chạy: npm install sharp');
  CONFIG.videoCodec = 'rgb565';
}
if (!CONFIG.ffmpegPath || CONFIG.ffmpegPath === 'ffmpeg') {
  const localFfmpeg = path.join(__dirname, 'tools', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (fs.existsSync(localFfmpeg)) CONFIG.ffmpegPath = localFfmpeg;
}
const AUDIO_MAGIC = Buffer.from('FJ2A');
let wss = null;
const emulatorSessions = new Map(); // key userId:gameHash -> EmulatorSession
const publicSessionIds = new Map(); // publicId -> EmulatorSession for /audio/:id.webm
const headlessInstances = new Map(); // instanceId -> EmulatorSession, for /api/instances + /ws/:id

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
function parseJavaMajor(versionText) {
  // Handles: 1.8.0_x, 8, 11.0.x, 17.0.x
  const text = String(versionText || '');
  let m = text.match(/version\s+"(\d+)\.(\d+)/i);
  if (m) {
    const first = parseInt(m[1], 10);
    const second = parseInt(m[2], 10);
    return first === 1 ? second : first;
  }
  m = text.match(/openjdk\s+(\d+)/i) || text.match(/java\s+(\d+)/i);
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
  register(username, password) {
    username = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9_.-]{3,32}$/.test(username)) throw new Error('Username 3-32 ký tự, chỉ a-z 0-9 _ . -');
    if (!password || String(password).length < 4) throw new Error('Password tối thiểu 4 ký tự');
    if (this.data.users[username]) throw new Error('Username đã tồn tại');
    const salt = crypto.randomBytes(16).toString('hex');
    const user = { id: randomId('u_'), username, salt, passwordHash: sha256(salt + ':' + password), createdAt: now() };
    this.data.users[username] = user; this.save(); return user;
  }
  login(username, password) {
    username = String(username || '').trim().toLowerCase();
    const user = this.data.users[username];
    if (!user || user.passwordHash !== sha256(user.salt + ':' + password)) throw new Error('Sai username hoặc password');
    const sid = randomId('sid_');
    this.data.sessions[sid] = { userId: user.id, username: user.username, createdAt: now(), expiresAt: now() + 30 * 24 * 3600 * 1000 };
    this.save(); return { sid, user };
  }
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
function buildArgs(opts = CONFIG) {
  const s = {
    width: opts.width, height: opts.height, rotate: opts.rotate, phoneType: opts.phoneType, fps: opts.fps, sound: opts.sound,
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

// =================== EMULATOR SESSION ===================
class EmulatorSession {
  constructor({ user, gameHash, jarPath, options = {} }) {
    this.user = user; this.userId = user.id; this.username = user.username; this.gameHash = gameHash; this.jarPath = jarPath;
    const iq = options.imageQuality ?? CONFIG.imageQuality;
    const vc = String(options.videoCodec ?? CONFIG.videoCodec).toLowerCase();
    this.options = {
      width: parseInt(options.width ?? CONFIG.width, 10),
      height: parseInt(options.height ?? CONFIG.height, 10),
      rotate: parseInt(options.rotate ?? CONFIG.rotate, 10),
      phoneType: parseInt(options.phoneType ?? CONFIG.phoneType, 10),
      fps: parseInt(options.fps ?? CONFIG.fps, 10),
      sound: parseInt(options.sound ?? CONFIG.sound, 10),
      maxFps: parseInt(options.maxFps ?? CONFIG.maxFps, 10),
      streamScale: Math.max(1, parseInt(options.streamScale ?? CONFIG.streamScale, 10)),
      imageQuality: Math.max(1, Math.min(100, parseInt(iq, 10) || 65)),
      videoCodec: ['rgba','rgb565','rgb332','webp'].includes(vc) ? vc : CONFIG.videoCodec,
      webpQuality: Math.max(1, Math.min(100, parseInt(options.webpQuality ?? CONFIG.webpQuality, 10) || 55)),
      webpEffort: Math.max(0, Math.min(6, parseInt(options.webpEffort ?? CONFIG.webpEffort, 10) || 0)),
      wsCompression: String(options.wsCompression ?? CONFIG.wsCompression) !== '0' && String(options.wsCompression ?? CONFIG.wsCompression).toLowerCase() !== 'false',
      audioPipe: String(options.audioPipe ?? CONFIG.audioPipe) !== '0' && String(options.audioPipe ?? CONFIG.audioPipe).toLowerCase() !== 'false',
      audioCodec: String(options.audioCodec ?? CONFIG.audioCodec).toLowerCase(),
      opusBitrate: String(options.opusBitrate ?? this.options.opusBitrate),
    };
    if (this.options.videoCodec === 'webp' && !sharp) this.options.videoCodec = 'rgb565';
    this.key = `${this.userId}:${gameHash}`;
    this.publicId = randomId('s_');
    publicSessionIds.set(this.publicId, this);
    this.clients = new Set();
    this.audioHttpClients = new Set();
    this.ffmpeg = null;
    this.ffmpegReady = false;
    this.opusAudioEnabled = this.options.audioCodec === 'opus';
    this.process = null; this.stdoutReader = null; this.stdin = null;
    this.isRunning = false; this.frameLoopActive = false;
    this.emuFrameWidth = this.options.width; this.emuFrameHeight = this.options.height;
    this.streamOutWidth = Math.floor(this.options.width / this.options.streamScale); this.streamOutHeight = Math.floor(this.options.height / this.options.streamScale);
    this.stopOpusEncoder(); this.opusAudioEnabled = this.options.audioCodec === 'opus'; this.audioPipeBuffer = Buffer.alloc(0); this.currentAudioFormat = null;
    this.audioStats = { formatPackets: 0, pcmPackets: 0, pcmBytes: 0, lastFormatAt: 0, lastPcmAt: 0 };
    this.videoStats = { framesRead: 0, framesSent: 0, lastFrameAt: 0 };
    this.audioPcmChunks = [];
    this.audioPcmBytes = 0;
    this.audioFlushTimer = null;
    this.lastActivity = now();
    this.dataDir = path.join(CONFIG.dataDir, 'users', safeName(this.userId), 'games', gameHash, 'runtime');
    ensureDir(this.dataDir);
  }

  touch() { this.lastActivity = now(); }
  sendPacket(buf) { if (this.stdin && !this.stdin.destroyed) this.stdin.write(buf); }
  sendKeyDown(keyIndex) { const b = Buffer.alloc(5); b[0] = 3; b.writeInt32BE(keyIndex, 1); this.sendPacket(b); }
  sendKeyUp(keyIndex) { const b = Buffer.alloc(5); b[0] = 2; b.writeInt32BE(keyIndex, 1); this.sendPacket(b); }
  sendMouse(cmd, x, y) { const b = Buffer.alloc(5); b[0] = cmd; b[1] = (x >> 8) & 255; b[2] = x & 255; b[3] = (y >> 8) & 255; b[4] = y & 255; this.sendPacket(b); }
  sendLoadJar(jarPath) { const pb = Buffer.from(jarPath, 'utf8'); const h = Buffer.alloc(5); h[0] = 10; h.writeInt32BE(pb.length, 1); this.sendPacket(h); this.sendPacket(pb); console.log(`[PROTO ${this.username}] Load JAR:`, jarPath, `(len=${pb.length})`); }
  sendFrameRequest() { const b = Buffer.alloc(5); b[0] = 15; this.sendPacket(b); }

  broadcast(data, opts = {}) { for (const ws of this.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data, opts); }
  broadcastJson(obj) { this.broadcast(JSON.stringify(obj)); }
  getAudioStatus(extra = {}) { return { type: 'audio-status', enabled: this.options.audioPipe, format: this.currentAudioFormat, ...this.audioStats, ...extra }; }
  getStreamDimensions(width = this.emuFrameWidth, height = this.emuFrameHeight) { return { width: Math.max(1, Math.floor(width / this.options.streamScale)), height: Math.max(1, Math.floor(height / this.options.streamScale)) }; }
  broadcastConfig() { const d = this.getStreamDimensions(); this.streamOutWidth = d.width; this.streamOutHeight = d.height; this.broadcastJson({ type: 'config', width: d.width, height: d.height, scale: CONFIG.streamScale, videoCodec: CONFIG.videoCodec, imageQuality: CONFIG.imageQuality, webpQuality: CONFIG.webpQuality }); }

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
        this.cleanupProcess();
        emulatorSessions.delete(this.key);
        if (this.publicId) publicSessionIds.delete(this.publicId);
        if (this.instanceId) headlessInstances.delete(this.instanceId);
      }
    }, CONFIG.noClientShutdownMs);
  }

  startInputIdleWatchdog() {
    if (this.inputIdleTimer || CONFIG.inputIdleShutdownMs <= 0) return;
    this.inputIdleTimer = setInterval(() => {
      if (!this.isRunning || this.clients.size === 0) return;
      if (now() - this.lastInputAt >= CONFIG.inputIdleShutdownMs) {
        console.log(`[SESSION ${this.username}] input idle shutdown after ${CONFIG.inputIdleShutdownMs}ms`);
        this.broadcastJson({ type: 'status', state: 'input-idle-shutdown' });
        this.cleanupProcess();
        emulatorSessions.delete(this.key);
        if (this.publicId) publicSessionIds.delete(this.publicId);
        if (this.instanceId) headlessInstances.delete(this.instanceId);
      }
    }, Math.max(1000, Math.min(CONFIG.inputIdleShutdownMs, 5000)));
  }

  markInputActivity() { this.lastInputAt = now(); this.touch(); }

  addClient(ws) {
    this.touch();
    this.cancelNoClientShutdown();
    detachClientFromOtherSessions(ws, this);
    this.clients.add(ws);
    ws._emuSession = this;
    console.log(`[SESSION ${this.username}] client bound game=${this.gameHash} clients=${this.clients.size}`);
    ws.send(JSON.stringify({ type: 'auth', user: { id: this.userId, username: this.username }, gameHash: this.gameHash, sessionId: this.publicId, audioUrl: this.opusAudioEnabled ? `/audio/${this.publicId}.webm` : null, audioCodec: this.opusAudioEnabled ? 'opus' : 'pcm' }));
    ws.send(JSON.stringify({ type: 'status', state: this.isRunning ? 'running' : 'binding', gameHash: this.gameHash }));
    ws.send(JSON.stringify({ type: 'config', width: this.streamOutWidth, height: this.streamOutHeight, scale: this.options.streamScale, videoCodec: this.options.videoCodec, imageQuality: this.options.imageQuality, webpQuality: this.options.webpQuality }));
    ws.send(JSON.stringify(this.getAudioStatus({ event: 'connect' })));
    ws.on('close', () => { this.clients.delete(ws); this.touch(); if (this.clients.size === 0) this.scheduleNoClientShutdown('last websocket closed'); });
  }

  countReadyClients() {
    let n = 0;
    for (const ws of this.clients) if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= CONFIG.maxWsBufferedAmount) n++;
    return n;
  }

  async convertRgb24ToVideoBuffer(rgb24, width, height) {
    const scale = Math.max(1, this.options.streamScale | 0);
    const outWidth = scale <= 1 ? width : Math.max(1, Math.floor(width / scale));
    const outHeight = scale <= 1 ? height : Math.max(1, Math.floor(height / scale));
    const codec = this.options.videoCodec;

    // Optional WebP via sharp. Excellent for bandwidth, costs CPU/latency.
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
        .webp({ quality: this.options.webpQuality, effort: this.options.webpEffort, smartSubsample: false })
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

  async readFrameHeader() {
    let skipped = 0;
    while (this.frameLoopActive && this.isRunning) {
      const first = await this.stdoutReader.readBytes(1);
      if (first[0] !== 0xFE) { skipped++; continue; }
      const rest = await this.stdoutReader.readBytes(15);
      const header = Buffer.concat([first, rest]);
      const width = (header[1] << 8) | header[2];
      const height = (header[3] << 8) | header[4];
      const frameSize = width * height * 3;
      if (header[14] === 1) return header;
      if (width > 0 && height > 0 && frameSize <= 800 * 800 * 3) {
        if (skipped && CONFIG.frameResyncLog) console.warn(`[FRAME ${this.username}] resync skipped ${skipped} bytes`);
        return header;
      }
      const idx = rest.indexOf(0xFE);
      if (idx !== -1) this.stdoutReader.prepend(rest.slice(idx));
    }
    throw new Error('Frame loop stopped');
  }

  startOpusEncoder() {
    if (!this.opusAudioEnabled || !this.currentAudioFormat || this.ffmpeg) return;
    const f = this.currentAudioFormat;
    if (f.bits !== 16 || !f.signed) {
      console.warn(`[AUDIO ${this.username}] Opus fallback: unsupported PCM format`, f);
      this.opusAudioEnabled = false;
      return;
    }
    const inputFmt = f.bigEndian ? 's16be' : 's16le';
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', inputFmt,
      '-ar', String(f.sampleRate || 44100),
      '-ac', String(f.channels || 2),
      '-i', 'pipe:0',
      '-vn',
      '-c:a', 'libopus',
      '-b:a', this.options.opusBitrate,
      '-application', 'audio',
      '-frame_duration', '20',
      '-vbr', 'on',
      '-compression_level', '10',
      '-f', 'webm',
      '-cluster_time_limit', '100',
      '-flush_packets', '1',
      'pipe:1',
    ];
    console.log(`[AUDIO ${this.username}] starting ffmpeg opus ${this.options.opusBitrate}: ${CONFIG.ffmpegPath} ${args.join(' ')}`);
    try {
      this.ffmpeg = spawn(CONFIG.ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.ffmpegReady = true;
      this.ffmpeg.stdout.on('data', (chunk) => {
        for (const res of Array.from(this.audioHttpClients)) {
          try { res.write(chunk); } catch (e) { this.audioHttpClients.delete(res); }
        }
      });
      this.ffmpeg.stderr.on('data', (d) => {
        const t = d.toString().trim();
        if (t) console.warn(`[FFMPEG ${this.username}]`, t);
      });
      this.ffmpeg.on('exit', (code) => {
        console.warn(`[AUDIO ${this.username}] ffmpeg exited code=${code}`);
        this.ffmpeg = null; this.ffmpegReady = false;
      });
      this.ffmpeg.on('error', (err) => {
        console.warn(`[AUDIO ${this.username}] ffmpeg error: ${err.message}; fallback PCM websocket`);
        this.opusAudioEnabled = false; this.ffmpeg = null; this.ffmpegReady = false;
      });
    } catch (e) {
      console.warn(`[AUDIO ${this.username}] cannot start ffmpeg: ${e.message}; fallback PCM websocket`);
      this.opusAudioEnabled = false; this.ffmpeg = null; this.ffmpegReady = false;
    }
  }

  writeOpusPcm(payload) {
    if (!this.opusAudioEnabled) return false;
    this.startOpusEncoder();
    if (!this.ffmpeg || !this.ffmpeg.stdin || this.ffmpeg.stdin.destroyed) return false;
    try { this.ffmpeg.stdin.write(payload); return true; }
    catch (e) { console.warn(`[AUDIO ${this.username}] ffmpeg stdin write failed:`, e.message); return false; }
  }

  addAudioHttpClient(res) {
    if (!this.opusAudioEnabled) return false;
    res.writeHead(200, {
      'Content-Type': 'audio/webm; codecs=opus',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    this.audioHttpClients.add(res);
    res.on('close', () => this.audioHttpClients.delete(res));
    res.on('error', () => this.audioHttpClients.delete(res));
    return true;
  }

  stopOpusEncoder() {
    for (const res of Array.from(this.audioHttpClients)) {
      try { res.end(); } catch (e) {}
    }
    this.audioHttpClients.clear();
    if (this.ffmpeg) {
      try { this.ffmpeg.stdin.end(); } catch (e) {}
      try { this.ffmpeg.kill('SIGTERM'); } catch (e) {}
    }
    this.ffmpeg = null; this.ffmpegReady = false;
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
    if (!payload || payload.length <= 0) return;
    this.audioPcmChunks.push(Buffer.from(payload));
    this.audioPcmBytes += payload.length;
    const targetBytes = this.audioBytesPerMs() * CONFIG.audioPacketMs;
    if (this.audioPcmBytes >= targetBytes) {
      this.flushAudioPcm();
      return;
    }
    if (!this.audioFlushTimer) {
      this.audioFlushTimer = setTimeout(() => this.flushAudioPcm(), CONFIG.audioPacketMs);
    }
  }

  logAudioText(buf) {
    if (!buf || !buf.length) return;
    const text = buf.toString('utf8').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]+/g, '').trim();
    if (text && (CONFIG.audioDebugLog || text.includes('[AudioPipe'))) console.error(`[EMU stderr ${this.username}]`, text);
  }
  attachAudioPipe(stderrStream) {
    if (!stderrStream) return;
    stderrStream.on('data', chunk => {
      if (!this.options.audioPipe) { this.logAudioText(chunk); return; }
      this.audioPipeBuffer = Buffer.concat([this.audioPipeBuffer, chunk]);
      while (this.audioPipeBuffer.length > 0) {
        const idx = this.audioPipeBuffer.indexOf(AUDIO_MAGIC);
        if (idx < 0) { if (this.audioPipeBuffer.length > 3) { this.logAudioText(this.audioPipeBuffer.slice(0, this.audioPipeBuffer.length - 3)); this.audioPipeBuffer = this.audioPipeBuffer.slice(-3); } return; }
        if (idx > 0) { this.logAudioText(this.audioPipeBuffer.slice(0, idx)); this.audioPipeBuffer = this.audioPipeBuffer.slice(idx); }
        if (this.audioPipeBuffer.length < 5) return;
        const type = this.audioPipeBuffer[4];
        if (type === 1) {
          if (this.audioPipeBuffer.length < 13) return;
          const packet = Buffer.from(this.audioPipeBuffer.slice(0, 13));
          this.currentAudioFormat = { sampleRate: packet.readUInt32BE(5), channels: packet[9], bits: packet[10], signed: packet[11] !== 0, bigEndian: packet[12] !== 0 };
          this.audioStats.formatPackets++; this.audioStats.lastFormatAt = now();
          this.flushAudioPcm();
          this.stopOpusEncoder();
          this.opusAudioEnabled = this.options.audioCodec === 'opus';
          console.log(`[AUDIO ${this.username}] Format:`, this.currentAudioFormat);
          if (!this.opusAudioEnabled) this.broadcast(packet, { binary: true, compress: false });
          this.broadcastJson(this.getAudioStatus({ event: 'format', audioCodec: this.opusAudioEnabled ? 'opus' : 'pcm', audioUrl: this.opusAudioEnabled ? `/audio/${this.publicId}.webm` : null }));
          if (this.opusAudioEnabled) this.startOpusEncoder();
          this.audioPipeBuffer = this.audioPipeBuffer.slice(13); continue;
        }
        if (type === 2) {
          if (this.audioPipeBuffer.length < 9) return;
          const len = this.audioPipeBuffer.readUInt32BE(5);
          if (len > 1024 * 1024) { this.audioPipeBuffer = this.audioPipeBuffer.slice(1); continue; }
          const total = 9 + len; if (this.audioPipeBuffer.length < total) return;
          const payload = Buffer.from(this.audioPipeBuffer.slice(9, total));
          this.audioStats.pcmPackets++; this.audioStats.pcmBytes += len; this.audioStats.lastPcmAt = now();
          if (this.audioStats.pcmPackets === 1 || this.audioStats.pcmPackets % 1000 === 0) console.log(`[AUDIO ${this.username}] PCM packets=${this.audioStats.pcmPackets}, bytes=${this.audioStats.pcmBytes}, codec=${this.opusAudioEnabled ? 'opus' : 'pcm'}, coalesce=${CONFIG.audioPacketMs}ms`);
          if (!this.writeOpusPcm(payload)) this.queueAudioPcm(payload);
          this.audioPipeBuffer = this.audioPipeBuffer.slice(total); continue;
        }
        this.audioPipeBuffer = this.audioPipeBuffer.slice(1);
      }
    });
  }

  cleanupProcess() {
    this.frameLoopActive = false; this.isRunning = false;
    this.cancelNoClientShutdown();
    if (this.inputIdleTimer) { clearInterval(this.inputIdleTimer); this.inputIdleTimer = null; }
    this.flushAudioPcm();
    this.stopOpusEncoder();
    if (this.audioFlushTimer) { clearTimeout(this.audioFlushTimer); this.audioFlushTimer = null; }
    if (this.process && !this.process.killed) { try { this.process.kill('SIGTERM'); } catch (e) {} }
    this.process = null; this.stdoutReader = null; this.stdin = null;
  }

  async start(encodingName) {
    validateRuntimePaths();
    this.cleanupProcess();
    await new Promise(r => setTimeout(r, 250));
    ensureDir(this.dataDir);
    console.log(`[EMU ${this.username}] start game=${this.gameHash} dataDir=${this.dataDir}`);
    console.log('[EMU] freej2meJar selected:', CONFIG.freej2meJar);
    const jvmArgs = [getEncodingJvmArg(encodingName), '-Djava.awt.headless=true', ...(this.options.audioPipe ? ['-Dfreej2me.audioPipe=1'] : []), '-jar', CONFIG.freej2meJar];
    const proc = spawn(CONFIG.javaPath, [...jvmArgs, ...buildArgs(this.options)], { stdio: ['pipe', 'pipe', 'pipe'], cwd: this.dataDir });
    this.process = proc; this.stdin = proc.stdin; this.stdoutReader = new StdoutReader(proc.stdout);
    this.audioPipeBuffer = Buffer.alloc(0); this.currentAudioFormat = null; this.audioStats = { formatPackets: 0, pcmPackets: 0, pcmBytes: 0, lastFormatAt: 0, lastPcmAt: 0 }; this.videoStats = { framesRead: 0, framesSent: 0, lastFrameAt: 0 }; this.audioPcmChunks = []; this.audioPcmBytes = 0; if (this.audioFlushTimer) { clearTimeout(this.audioFlushTimer); this.audioFlushTimer = null; }
    this.attachAudioPipe(proc.stderr);
    proc.on('exit', code => { if (this.process === proc) { console.log(`[EMU ${this.username}] exited ${code}`); this.cleanupProcess(); } });
    proc.on('error', err => { if (this.process === proc) { console.error(`[EMU ${this.username}] error:`, err.message); this.cleanupProcess(); } });

    let ready = false;
    const done = waitForProcessExitOrError(proc);
    while (!ready) {
      const line = await Promise.race([this.stdoutReader.readLine(), done, waitMs(15000, 'Timeout đợi +READY')]);
      const text = String(line).trim(); if (text) console.log(`[EMU stdout ${this.username}]`, text);
      if (text.includes('+READY')) ready = true;
    }
    this.sendLoadJar(this.jarPath);
    await new Promise(r => setTimeout(r, 1000));
    this.sendFrameRequest();
    this.isRunning = true; this.frameLoopActive = true;
    this.lastInputAt = now();
    this.startInputIdleWatchdog();
    this.broadcastConfig();
    this.broadcastJson({ type: 'status', state: 'running', gameHash: this.gameHash });
    this.startFrameLoop();
    setTimeout(() => { if (this.isRunning && this.options.audioPipe && this.audioStats.formatPackets === 0) this.broadcastJson(this.getAudioStatus({ event: 'timeout-no-audio', warning: 'no FJ2A audio packet after 5s' })); }, 5000);
  }

  async startFrameLoop() {
    const minFrameInterval = this.options.maxFps > 0 ? 1000 / this.options.maxFps : 0;
    let lastFrameTime = 0, frameNo = 0, dropBackpressure = 0, lastStats = now();
    while (this.frameLoopActive && this.isRunning) {
      try {
        const header = await this.readFrameHeader();
        const width = (header[1] << 8) | header[2], height = (header[3] << 8) | header[4];
        if (header[14] === 1) {
          const enc = ['ISO-8859-1', 'Shift_JIS', 'EUC-KR'][header[15]] || 'ISO-8859-1';
          const expected = Math.max(1, this.emuFrameWidth) * Math.max(1, this.emuFrameHeight) * 3;
          try { await this.stdoutReader.readBytes(expected); } catch (e) {}
          await this.start(enc); return;
        }
        const frameSize = width * height * 3;
        this.emuFrameWidth = width; this.emuFrameHeight = height;
        const dims = this.getStreamDimensions(width, height);
        if (dims.width !== this.streamOutWidth || dims.height !== this.streamOutHeight) this.broadcastConfig();
        const rgb24 = await this.stdoutReader.readBytes(frameSize);
        frameNo++;
        this.videoStats.framesRead++;
        this.videoStats.lastFrameAt = now();
        if (minFrameInterval > 0) {
          const elapsed = now() - lastFrameTime;
          if (elapsed < minFrameInterval) await new Promise(r => setTimeout(r, minFrameInterval - elapsed));
          lastFrameTime = now();
        }
        if (this.countReadyClients() <= 0) { dropBackpressure++; this.sendFrameRequest(); continue; }
        const videoBuf = await this.convertRgb24ToVideoBuffer(rgb24, width, height);
        for (const ws of this.clients) {
          if (ws.readyState === WebSocket.OPEN) {
            if (ws.bufferedAmount <= CONFIG.maxWsBufferedAmount) ws.send(videoBuf, { binary: true, compress: this.options.wsCompression });
            else dropBackpressure++;
          }
        }
        if (now() - lastStats >= 10000) {
          console.log(`[STREAM ${this.username}] fps~${(frameNo / 10).toFixed(1)}, clients=${this.clients.size}, drop=${dropBackpressure}, out=${this.streamOutWidth}x${this.streamOutHeight}`);
          frameNo = 0; dropBackpressure = 0; lastStats = now();
        }
        this.sendFrameRequest();
      } catch (e) {
        if (!this.isRunning) break;
        console.error(`[FRAME ${this.username}]`, e.message);
        await new Promise(r => setTimeout(r, 100));
        this.sendFrameRequest();
      }
    }
  }
}

function getOrCreateSession(user, gameHash, jarPath, options = {}) {
  const key = `${user.id}:${gameHash}`;
  let sess = emulatorSessions.get(key);
  if (!sess) { sess = new EmulatorSession({ user, gameHash, jarPath, options }); emulatorSessions.set(key, sess); }
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

function stopOtherSessionsForUser(userId, keepKey = null) {
  for (const [key, sess] of Array.from(emulatorSessions.entries())) {
    if (sess.userId === userId && key !== keepKey) {
      console.log(`[SESSION] stop old session user=${sess.username} game=${sess.gameHash}`);
      // Detach sockets first so old emulator can no longer broadcast stale frames to web.
      for (const ws of Array.from(sess.clients)) {
        sess.clients.delete(ws);
        if (ws._emuSession === sess) ws._emuSession = null;
      }
      sess.cleanupProcess();
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
  html = html.replace('<div id="status" class="connecting">Đang kết nối...</div>', '<div id="status" class="connecting">Đang kết nối...</div>\n' + loginBox + '\n  <button id="audio-toggle" style="margin:0 0 10px;padding:8px 14px;border:0;border-radius:18px;background:#333;color:#fff;cursor:pointer;display:none">🔇 Bật âm thanh</button>\n  <style id="v11-controls-guard">#controls{display:none !important;}</style>\n  <style id="v12-login-first">#upload-area,#screen-container,#controls,#help{display:none !important;}</style>');

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
    }
    function setLoggedInUi(show) {
      document.body.classList.toggle('v16-login-mode', !show);
      if (v12LoginFirst) v12LoginFirst.disabled = !!show;
      if (uploadAreaEl) uploadAreaEl.style.display = show ? '' : 'none';
      if (screenContainerEl) screenContainerEl.style.display = show ? '' : 'none';
      if (helpEl) helpEl.style.display = show ? '' : 'none';
      if (audioToggle) audioToggle.style.display = show ? '' : 'none';
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
    let videoCodec = 'rgba';
    let imageQuality = 100;
    const AUDIO_START_BUFFER_SEC = 0.18; // overwritten by server config not needed; stable default for tunnel jitter
    function setAudioButton(t, title) { if(audioToggle){ audioToggle.textContent=t; if(title) audioToggle.title=title; } }
    function ensureAudioContext(){ if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)({latencyHint:'playback'}); return audioCtx; }
    function browserTestBeep(){ try{ const ctx=ensureAudioContext(); const o=ctx.createOscillator(), g=ctx.createGain(); o.frequency.value=880; g.gain.setValueAtTime(0.001,ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.10,ctx.currentTime+0.015); g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+0.16); o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime+0.18);}catch(e){} }
    function startOpusAudio(){ if(!opusAudioUrl) return; if(!opusAudioEl){ opusAudioEl = new Audio(); opusAudioEl.autoplay = true; opusAudioEl.controls = false; opusAudioEl.preload = 'none'; document.body.appendChild(opusAudioEl); } const u = opusAudioUrl + (opusAudioUrl.includes('?') ? '&' : '?') + 't=' + Date.now(); if(opusAudioEl.src !== location.origin + u && opusAudioEl.src !== u) opusAudioEl.src = u; opusAudioEl.muted = false; opusAudioEl.play().catch(e=>console.warn('Opus audio play blocked:', e)); }
    function unlockAudio(){ const ctx=ensureAudioContext(); ctx.resume(); audioUnlocked=true; audioMuted=false; audioNextTime=ctx.currentTime+AUDIO_START_BUFFER_SEC; setAudioButton('🔊 Âm thanh: bật'); browserTestBeep(); startOpusAudio(); }
    audioToggle.onclick = () => { if(!audioUnlocked) unlockAudio(); else { audioMuted=!audioMuted; if(opusAudioEl) opusAudioEl.muted = audioMuted; setAudioButton(audioMuted?'🔇 Âm thanh: tắt':'🔊 Âm thanh: bật'); if(!audioMuted){ audioNextTime=audioCtx.currentTime+AUDIO_START_BUFFER_SEC; browserTestBeep(); startOpusAudio(); } } };
    function isAudioPacket(u8){ return u8 && u8.length>=5 && u8[0]===0x46 && u8[1]===0x4A && u8[2]===0x32 && u8[3]===0x41; }
    function handleAudioStatus(msg){ if(msg.audioUrl){ opusAudioUrl = msg.audioUrl; if(audioUnlocked && !audioMuted) startOpusAudio(); } if(msg.format) setAudioButton(audioUnlocked&&!audioMuted?'🔊 Âm thanh: bật':'🔇 Bật âm thanh', 'codec='+(msg.audioCodec||'pcm')+' fmt='+(msg.formatPackets||0)+' pcm='+(msg.pcmPackets||0)); }
    function handleAudioPacket(u8){
      if(!isAudioPacket(u8)) return false;
      const type=u8[4]; const dv=new DataView(u8.buffer,u8.byteOffset,u8.byteLength);
      if(type===1 && u8.length>=13){ audioFormat={sampleRate:dv.getUint32(5,false),channels:u8[9]||1,bits:u8[10]||16,signed:u8[11]!==0,bigEndian:u8[12]!==0}; if(audioCtx) audioNextTime=audioCtx.currentTime+AUDIO_START_BUFFER_SEC; return true; }
      if(type!==2 || u8.length<9) return true;
      const len=dv.getUint32(5,false);
      if(len<=0||9+len>u8.length||!audioUnlocked||audioMuted||!audioCtx||audioFormat.bits!==16) return true;
      const chs=Math.max(1,audioFormat.channels|0), frames=Math.floor(len/(2*chs)); if(frames<=0) return true;
      const buf=audioCtx.createBuffer(chs,frames,audioFormat.sampleRate||48000);
      const cd=[]; for(let c=0;c<chs;c++) cd[c]=buf.getChannelData(c); let off=9;
      for(let i=0;i<frames;i++){ for(let c=0;c<chs;c++){ let smp=audioFormat.bigEndian?((u8[off]<<8)|u8[off+1]):(u8[off]|(u8[off+1]<<8)); if(audioFormat.signed&&smp>=0x8000)smp-=0x10000; if(!audioFormat.signed)smp-=0x8000; cd[c][i]=Math.max(-1,Math.min(1,smp/32768)); off+=2; } }
      const nowAudio=audioCtx.currentTime;
      if(!audioNextTime || audioNextTime < nowAudio + 0.04) audioNextTime = nowAudio + AUDIO_START_BUFFER_SEC;
      // If backlog grows too much, drop this packet rather than playing old audio late.
      if(audioNextTime > nowAudio + 0.9) return true;
      const src=audioCtx.createBufferSource(); src.buffer=buf; src.connect(audioCtx.destination);
      src.start(audioNextTime); audioNextTime += buf.duration;
      return true;
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
  // V21: nhận videoCodec/imageQuality từ config packet. Bản V15 thiếu đoạn này nên client tưởng frame là RGBA và bị đen màn hình.
  html = html.replace(
    '            screenHeight = msg.height;\n            canvas.width = screenWidth;',
    "            screenHeight = msg.height;\n            videoCodec = msg.videoCodec || videoCodec || 'rgba';\n            imageQuality = msg.imageQuality || imageQuality || 100;\n            canvas.width = screenWidth;"
  );

  // V21: connection guard để tránh kẹt noGame và tránh tạo 2 socket/audio chồng.
  html = html.replace(
    "      ws.onopen = () => {\n        isConnected = true;",
    "      ws.onopen = () => {\n        wsConnecting = false;\n        isConnected = true;"
  );
  html = html.replace(
    "      ws.onclose = () => {\n        isConnected = false;",
    "      ws.onclose = () => {\n        wsConnecting = false;\n        isConnected = false;"
  );

  // V21: không tự WebSocket reconnect khi chưa đăng nhập, để form login/register gõ bình thường.
  html = html.replace('    function connect() {', '    function connect() {\n      if (!shouldConnectWs) return;\n      if (wsConnecting) return;\n      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;\n      wsConnecting = true;');
  html = html.replace('        setTimeout(connect, 2000);', '        if (shouldConnectWs) setTimeout(connect, 2000);');
  html = html.replace('    connect();', '    // V21: connect() được gọi sau khi đăng nhập thành công; không tự connect ở màn hình login.');
  html = html.replace("setStatus(`Đã kết nối - ${screenWidth}x${screenHeight}`, 'connected');\n          }", "setStatus(`Đã kết nối - ${screenWidth}x${screenHeight}`, 'connected');\n          } else if (msg.type === 'audio-status') {\n            handleAudioStatus(msg);\n          } else if (msg.type === 'auth') {\n            if (msg.noGame) {\n              setLoggedInUi(true);\n              setGameUiVisible(false);\n              setStatus('Đã đăng nhập - hãy upload game', 'connected');\n            } else if (msg.gameHash) {\n              setLoggedInUi(true);\n              setGameUiVisible(true);\n              if (msg.audioUrl) { opusAudioUrl = msg.audioUrl; if (audioUnlocked && !audioMuted) startOpusAudio(); }\n            }\n          } else if (msg.type === 'status') {\n            if (msg.state === 'loading') {\n              setGameUiVisible(false);\n              setStatus('Đang tải game mới...', 'connecting');\n              try { ctx.clearRect(0, 0, canvas.width, canvas.height); latestFrame = null; } catch(e) {}\n            } else if (msg.state === 'running') {\n              setLoggedInUi(true);\n            } else if (msg.state === 'no-video-yet') {\n              setStatus('Game đang chạy nhưng chưa có hình - thử VIDEO_CODEC=rgba hoặc xem log server', 'error');\n            }\n          }");
  // V21: ẩn bàn phím ảo trong lúc chưa tải game / đang upload.
  html = html.replace(
    "uploadStatus.textContent = 'Đang upload...';",
    "uploadStatus.textContent = 'Đang upload...';\n      setGameUiVisible(false);"
  );
  // V21: sau upload thành công, reconnect WS để bind vào emulator session mới.
  html = html.replace(
    "uploadStatus.textContent = `Đang chạy: ${file.name}`;",
    "uploadStatus.textContent = `Đang chạy: ${file.name}`;\n          // V21: reconnect an toàn 1 lần để chắc chắn socket bind vào session mới.\n          reconnectWsSoon(250);"
  );

  // V21: Cho phép gõ bình thường trong ô login/register/upload.
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
  html = html.replace('    const pressedKeys = new Set();', inputGuard + '\n    const pressedKeys = new Set();');
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


// =================== HEADLESS DEV API HELPERS ===================
function checkBridgeToken(req) {
  const token = process.env.BRIDGE_TOKEN || '';
  if (!token) return true;
  const header = req.headers['x-bridge-token'];
  const queryToken = new URL(req.url, 'http://localhost').searchParams.get('token');
  return header === token || queryToken === token;
}
function headlessUser(externalUserId) {
  const id = 'ext_' + safeName(externalUserId || 'anonymous');
  return { id, username: String(externalUserId || 'anonymous'), createdAt: now() };
}
function field(req, name, fallback) {
  return req.body && req.body[name] !== undefined && req.body[name] !== '' ? req.body[name] : fallback;
}
function instanceOptionsFromReq(req) {
  return {
    width: field(req, 'width', CONFIG.width),
    height: field(req, 'height', CONFIG.height),
    rotate: field(req, 'rotate', CONFIG.rotate),
    phoneType: field(req, 'phoneType', CONFIG.phoneType),
    fps: field(req, 'fps', CONFIG.fps),
    maxFps: field(req, 'maxFps', CONFIG.maxFps),
    sound: field(req, 'sound', CONFIG.sound),
    audioPipe: field(req, 'audioPipe', CONFIG.audioPipe ? 1 : 0),
    streamScale: field(req, 'streamScale', CONFIG.streamScale),
    imageQuality: field(req, 'imageQuality', CONFIG.imageQuality),
    videoCodec: field(req, 'videoCodec', CONFIG.videoCodec),
    webpQuality: field(req, 'webpQuality', CONFIG.webpQuality),
    webpEffort: field(req, 'webpEffort', CONFIG.webpEffort),
    wsCompression: field(req, 'wsCompression', CONFIG.wsCompression ? 1 : 0),
    audioCodec: field(req, 'audioCodec', CONFIG.audioCodec),
    opusBitrate: field(req, 'opusBitrate', this.options.opusBitrate),
  };
}

// =================== WEB SERVER ===================
function startWebServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  ensureDir(CONFIG.uploadsDir); ensureDir(CONFIG.dataDir);

  app.get('/api/me', (req, res) => res.json({ user: db.publicUser(requireUser(req, null)) }));
  app.post('/api/register', (req, res) => { try { const u = db.register(req.body.username, req.body.password); res.json({ success: true, user: db.publicUser(u) }); } catch (e) { res.status(400).json({ error: e.message }); } });
  app.post('/api/login', (req, res) => { try { const { sid, user } = db.login(req.body.username, req.body.password); setCookie(res, 'fj2me_sid', sid, { maxAge: 30 * 24 * 3600 }); res.json({ success: true, user: db.publicUser(user) }); } catch (e) { res.status(401).json({ error: e.message }); } });
  app.post('/api/logout', (req, res) => { db.logout(parseCookies(req).fj2me_sid); clearCookie(res, 'fj2me_sid'); res.json({ success: true }); });

  const storage = multer.diskStorage({ destination: (req, file, cb) => cb(null, CONFIG.uploadsDir), filename: (req, file, cb) => cb(null, `game_${Date.now()}_${Math.random().toString(36).slice(2)}${path.extname(file.originalname) || '.jar'}`) });
  const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });
  // -------- Headless Dev API: create isolated emulator instance without built-in UI/login --------
  app.post('/api/instances', upload.single('jar'), async (req, res) => {
    if (!checkBridgeToken(req)) return res.status(401).json({ error: 'bad bridge token' });
    if (!req.file) return res.status(400).json({ error: 'missing jar field' });
    try {
      const externalUserId = String(field(req, 'externalUserId', '')).trim();
      if (!externalUserId) throw new Error('externalUserId is required');
      const user = headlessUser(externalUserId);
      const jarPath = path.resolve(req.file.path);
      const gameHash = sha1File(jarPath);
      const options = instanceOptionsFromReq(req);
      stopOtherSessionsForUser(user.id, `${user.id}:${gameHash}`);
      const sess = getOrCreateSession(user, gameHash, jarPath, options);
      await sess.start();
      const instanceId = randomId('i_');
      sess.instanceId = instanceId;
      headlessInstances.set(instanceId, sess);
      res.json({
        success: true,
        instanceId,
        gameHash,
        wsPath: `/ws/${instanceId}`,
        audioUrl: sess.opusAudioEnabled ? `/audio/${sess.publicId}.webm` : null,
        dataDir: sess.dataDir,
        config: { width: sess.streamOutWidth, height: sess.streamOutHeight, scale: sess.options.streamScale, videoCodec: sess.options.videoCodec, imageQuality: sess.options.imageQuality, webpQuality: sess.options.webpQuality, audioCodec: sess.opusAudioEnabled ? 'opus' : 'pcm' },
      });
    } catch (e) {
      console.error('[Headless create]', e);
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/instances/:id', (req, res) => {
    if (!checkBridgeToken(req)) return res.status(401).json({ error: 'bad bridge token' });
    const sess = headlessInstances.get(req.params.id);
    if (!sess) return res.status(404).json({ error: 'instance not found' });
    res.json({ success: true, instanceId: req.params.id, running: sess.isRunning, clients: sess.clients.size, gameHash: sess.gameHash, dataDir: sess.dataDir, options: sess.options, audioUrl: sess.opusAudioEnabled ? `/audio/${sess.publicId}.webm` : null });
  });

  app.delete('/api/instances/:id', (req, res) => {
    if (!checkBridgeToken(req)) return res.status(401).json({ error: 'bad bridge token' });
    const sess = headlessInstances.get(req.params.id);
    if (sess) { sess.cleanupProcess(); headlessInstances.delete(req.params.id); emulatorSessions.delete(sess.key); publicSessionIds.delete(sess.publicId); }
    res.json({ success: true });
  });

  app.post('/upload', upload.single('jar'), async (req, res) => {
    const user = requireUser(req, res); if (!user) return;
    if (!req.file) return res.status(400).json({ error: 'Không có file' });
    try {
      const jarPath = path.resolve(req.file.path);
      const gameHash = sha1File(jarPath);
      if (emulatorSessions.size >= CONFIG.maxActiveSessions && !getActiveSessionForUser(user.id)) throw new Error('Server đã đạt giới hạn session đang chạy');
      // V21: Web và emulator phải gắn chặt 1-1 theo user. Khi user upload JAR mới,
      // dừng toàn bộ emulator cũ của user trước để tránh 2 process cùng broadcast gây nhấp nháy.
      stopOtherSessionsForUser(user.id, `${user.id}:${gameHash}`);
      const sess = getOrCreateSession(user, gameHash, jarPath);
      // Bind các socket hiện tại vào session mới trước khi start để config/loading tới đúng client.
      if (wss) {
        wss.clients.forEach((ws) => {
          if (ws.readyState === WebSocket.OPEN && ws._userId === user.id) sess.addClient(ws);
        });
      }
      sess.broadcastJson({ type: 'status', state: 'loading', gameHash });
      await sess.start();
      // V21: bind các WebSocket đang mở của user này vào session mới.
      // Bản V10 tạo session sau upload nhưng WebSocket cũ vẫn ở trạng thái noGame.
      if (wss) {
        wss.clients.forEach((ws) => {
          if (ws.readyState === WebSocket.OPEN && ws._userId === user.id && ws._emuSession !== sess) sess.addClient(ws);
        });
      }
      res.json({ success: true, gameHash, jar: req.file.filename, user: db.publicUser(user), dataDir: sess.dataDir });
    } catch (e) { console.error('[Upload]', e); res.status(500).json({ error: e.message }); }
  });

  app.get('/audio/:id.webm', (req, res) => {
    const sess = publicSessionIds.get(req.params.id);
    if (!sess || !sess.isRunning || !sess.opusAudioEnabled) {
      res.status(404).end('audio stream not found');
      return;
    }
    sess.addAudioHttpClient(res);
  });

  app.get(['/', '/index.html'], (req, res) => { try { res.type('html').send(getPatchedIndexHtml()); } catch (e) { console.error('[Web]', e); res.sendFile(path.join(__dirname, 'public', 'index.html')); } });
  app.use(express.static(path.join(__dirname, 'public')));

  const server = http.createServer(app);
  wss = new WebSocket.Server({ server, perMessageDeflate: CONFIG.wsCompression ? { zlibDeflateOptions: { level: 1, memLevel: 7 }, clientNoContextTakeover: true, serverNoContextTakeover: true, threshold: 1024 } : false });
  console.log(`[Stream] maxFps=${CONFIG.maxFps}, scale=${CONFIG.streamScale}, videoCodec=${CONFIG.videoCodec}, imageQuality=${CONFIG.imageQuality}, webpQuality=${CONFIG.webpQuality}, sharp=${sharp ? 'on' : 'off'}, wsCompression=${CONFIG.wsCompression ? 'on' : 'off'}, audioPipe=${CONFIG.audioPipe ? 'on' : 'off'}, audioCodec=${CONFIG.audioCodec}, opusBitrate=${this.options.opusBitrate}, audioPacketMs=${CONFIG.audioPacketMs}, maxBuffered=${CONFIG.maxWsBufferedAmount}, noClientShutdownMs=${CONFIG.noClientShutdownMs}, inputIdleShutdownMs=${CONFIG.inputIdleShutdownMs}`);
  console.log(`[Auth] JSON DB: ${CONFIG.dbPath}`);
  console.log(`[Runtime] java=${CONFIG.javaPath}`);
  console.log(`[Runtime] jar=${CONFIG.freej2meJar}`);

  wss.on('connection', (ws, req) => {
    const urlObj = new URL(req.url, 'http://localhost');
    const wsMatch = urlObj.pathname.match(/^\/ws\/([^/]+)$/);
    if (wsMatch) {
      if (!checkBridgeToken(req)) { ws.send(JSON.stringify({ type: 'error', error: 'bad_bridge_token' })); ws.close(); return; }
      const sess = headlessInstances.get(decodeURIComponent(wsMatch[1]));
      if (!sess) { ws.send(JSON.stringify({ type: 'error', error: 'instance_not_found' })); ws.close(); return; }
      sess.addClient(ws);
      ws.on('message', msg => {
        try {
          sess.touch();
          const data = JSON.parse(msg.toString());
          if (data.type === 'key' || data.type === 'touch') sess.markInputActivity();
          if (data.type === 'key') { if (data.state === 'D') sess.sendKeyDown(data.key); else if (data.state === 'U') sess.sendKeyUp(data.key); }
          else if (data.type === 'touch') { let cmd = data.state === 'D' ? 5 : data.state === 'U' ? 4 : data.state === 'M' ? 6 : 0; if (cmd) sess.sendMouse(cmd, data.x, data.y); }
        } catch (e) { console.error('[Headless WS]', e.message); }
      });
      return;
    }

    const user = db.getUserBySession(parseCookies(req).fj2me_sid);
    if (!user) { ws.send(JSON.stringify({ type: 'error', error: 'not_logged_in' })); ws.close(); return; }
    ws._userId = user.id;
    const sess = getActiveSessionForUser(user.id);
    if (!sess) { ws.send(JSON.stringify({ type: 'auth', user: db.publicUser(user), noGame: true })); ws.send(JSON.stringify({ type: 'config', width: Math.floor(CONFIG.width / CONFIG.streamScale), height: Math.floor(CONFIG.height / CONFIG.streamScale), scale: this.options.streamScale, videoCodec: this.options.videoCodec, imageQuality: this.options.imageQuality, webpQuality: this.options.webpQuality })); }
    else sess.addClient(ws);
    ws.on('message', msg => {
      try {
        const s = ws._emuSession || getActiveSessionForUser(user.id); if (!s) return; s.touch();
        const data = JSON.parse(msg.toString());
        if (data.type === 'key' || data.type === 'touch') s.markInputActivity();
        if (data.type === 'key') { if (data.state === 'D') s.sendKeyDown(data.key); else if (data.state === 'U') s.sendKeyUp(data.key); }
        else if (data.type === 'touch') { let cmd = data.state === 'D' ? 5 : data.state === 'U' ? 4 : data.state === 'M' ? 6 : 0; if (cmd) { const scale = Math.max(1, s.options.streamScale | 0); const x = data.x < 0 ? data.x : Math.max(0, Math.min(s.emuFrameWidth - 1, Math.floor(data.x * scale))); const y = data.y < 0 ? data.y : Math.max(0, Math.min(s.emuFrameHeight - 1, Math.floor(data.y * scale))); s.sendMouse(cmd, x, y); } }
      } catch (e) { console.error('[WS]', e.message); }
    });
  });

  server.listen(CONFIG.port, '0.0.0.0', () => console.log(`[WebServer] http://localhost:${CONFIG.port}`));
}

// =================== MAIN ===================
async function main() { ensureDir(CONFIG.uploadsDir); ensureDir(CONFIG.dataDir); validateRuntimePaths(); startWebServer(); }
main().catch(err => { console.error('Lỗi nghiêm trọng:', err); process.exit(1); });
