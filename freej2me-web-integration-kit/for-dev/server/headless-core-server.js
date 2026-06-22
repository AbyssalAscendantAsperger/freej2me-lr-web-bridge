/******************************************************************************
 * FreeJ2ME Headless Core Server - for-dev reference build
 *
 * This file is intentionally based on the latest proven bridge server, but the
 * recommended headless integration contract is documented in docs/PROTOCOL.md.
 *
 * For a pure backend integration, use server/server.js at root kit or adapt the
 * EmulatorSession class from this file. The built-in UI route can be ignored or
 * hidden behind a private path; dev apps normally call REST + WebSocket.
 *****************************************************************************/

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
const { spawn } = require('child_process');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const http = require('http');
const WebSocket = require('ws');

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

  function resolveJavaPath() {
    if (process.env.JAVA_PATH) return resolvePath(process.env.JAVA_PATH);
    const configured = resolvePath(fileConfig.javaPath);
    if (process.platform === 'win32') return configured || 'java.exe';
    if (configured && !configured.toLowerCase().endsWith('.exe') && fs.existsSync(configured)) return configured;
    return 'java';
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
    maxWsBufferedAmount: intConfig('MAX_WS_BUFFERED', fileConfig.maxWsBufferedAmount, 512 * 1024),
    wsCompression: boolConfig('WS_COMPRESSION', fileConfig.wsCompression, false),
    audioPipe: boolConfig('AUDIO_PIPE', fileConfig.audioPipe, true),

    frameResyncLog: boolConfig('FRAME_RESYNC_LOG', fileConfig.frameResyncLog, false),
    audioDebugLog: boolConfig('AUDIO_DEBUG_LOG', fileConfig.audioDebugLog, false),

    maxActiveSessions: intConfig('MAX_ACTIVE_SESSIONS', fileConfig.maxActiveSessions, 8),
    sessionIdleMs: intConfig('SESSION_IDLE_MS', fileConfig.sessionIdleMs, 10 * 60 * 1000),

    uploadsDir: process.env.UPLOADS_DIR || path.join(__dirname, 'uploads'),
    dataDir: process.env.DATA_DIR || path.join(__dirname, 'freej2me_data'),
    dbPath: process.env.DB_PATH || path.join(__dirname, 'freej2me_data', 'users.json'),
  };
}

const CONFIG = loadConfig();
if (!['rgba', 'rgb565', 'rgb332'].includes(CONFIG.videoCodec)) {
  CONFIG.videoCodec = CONFIG.imageQuality >= 90 ? 'rgba' : (CONFIG.imageQuality >= 45 ? 'rgb565' : 'rgb332');
}
const AUDIO_MAGIC = Buffer.from('FJ2A');
let wss = null;
const emulatorSessions = new Map(); // key userId:gameHash -> EmulatorSession
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
function validateRuntimePaths() {
  if (shouldCheckExecutablePath(CONFIG.javaPath) && !fs.existsSync(CONFIG.javaPath)) throw new Error(`Không tìm thấy Java executable: ${CONFIG.javaPath}`);
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

// =================== EMULATOR SESSION ===================
class EmulatorSession {
  constructor({ user, gameHash, jarPath }) {
    this.user = user; this.userId = user.id; this.username = user.username; this.gameHash = gameHash; this.jarPath = jarPath;
    this.key = `${this.userId}:${gameHash}`;
    this.clients = new Set();
    this.process = null; this.stdoutReader = null; this.stdin = null;
    this.isRunning = false; this.frameLoopActive = false;
    this.emuFrameWidth = CONFIG.width; this.emuFrameHeight = CONFIG.height;
    this.streamOutWidth = Math.floor(CONFIG.width / CONFIG.streamScale); this.streamOutHeight = Math.floor(CONFIG.height / CONFIG.streamScale);
    this.audioPipeBuffer = Buffer.alloc(0); this.currentAudioFormat = null;
    this.audioStats = { formatPackets: 0, pcmPackets: 0, pcmBytes: 0, lastFormatAt: 0, lastPcmAt: 0 };
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
  getAudioStatus(extra = {}) { return { type: 'audio-status', enabled: CONFIG.audioPipe, format: this.currentAudioFormat, ...this.audioStats, ...extra }; }
  getStreamDimensions(width = this.emuFrameWidth, height = this.emuFrameHeight) { return { width: Math.max(1, Math.floor(width / CONFIG.streamScale)), height: Math.max(1, Math.floor(height / CONFIG.streamScale)) }; }
  broadcastConfig() { const d = this.getStreamDimensions(); this.streamOutWidth = d.width; this.streamOutHeight = d.height; this.broadcastJson({ type: 'config', width: d.width, height: d.height, scale: CONFIG.streamScale, videoCodec: CONFIG.videoCodec, imageQuality: CONFIG.imageQuality }); }

  addClient(ws) {
    this.touch(); this.clients.add(ws);
    ws._emuSession = this;
    ws.send(JSON.stringify({ type: 'auth', user: { id: this.userId, username: this.username }, gameHash: this.gameHash }));
    ws.send(JSON.stringify({ type: 'config', width: this.streamOutWidth, height: this.streamOutHeight, scale: CONFIG.streamScale, videoCodec: CONFIG.videoCodec, imageQuality: CONFIG.imageQuality }));
    ws.send(JSON.stringify(this.getAudioStatus({ event: 'connect' })));
    ws.on('close', () => { this.clients.delete(ws); this.touch(); });
  }

  countReadyClients() {
    let n = 0;
    for (const ws of this.clients) if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= CONFIG.maxWsBufferedAmount) n++;
    return n;
  }

  convertRgb24ToVideoBuffer(rgb24, width, height) {
    const scale = Math.max(1, CONFIG.streamScale | 0);
    const outWidth = scale <= 1 ? width : Math.max(1, Math.floor(width / scale));
    const outHeight = scale <= 1 ? height : Math.max(1, Math.floor(height / scale));
    const codec = CONFIG.videoCodec;

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

    // rgba 32-bit fallback / best quality.
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

  logAudioText(buf) {
    if (!buf || !buf.length) return;
    const text = buf.toString('utf8').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]+/g, '').trim();
    if (text && (CONFIG.audioDebugLog || text.includes('[AudioPipe'))) console.error(`[EMU stderr ${this.username}]`, text);
  }
  attachAudioPipe(stderrStream) {
    if (!stderrStream) return;
    stderrStream.on('data', chunk => {
      if (!CONFIG.audioPipe) { this.logAudioText(chunk); return; }
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
          console.log(`[AUDIO ${this.username}] Format:`, this.currentAudioFormat);
          this.broadcast(packet, { binary: true, compress: false });
          this.broadcastJson(this.getAudioStatus({ event: 'format' }));
          this.audioPipeBuffer = this.audioPipeBuffer.slice(13); continue;
        }
        if (type === 2) {
          if (this.audioPipeBuffer.length < 9) return;
          const len = this.audioPipeBuffer.readUInt32BE(5);
          if (len > 1024 * 1024) { this.audioPipeBuffer = this.audioPipeBuffer.slice(1); continue; }
          const total = 9 + len; if (this.audioPipeBuffer.length < total) return;
          const packet = Buffer.from(this.audioPipeBuffer.slice(0, total));
          this.audioStats.pcmPackets++; this.audioStats.pcmBytes += len; this.audioStats.lastPcmAt = now();
          if (this.audioStats.pcmPackets === 1 || this.audioStats.pcmPackets % 1000 === 0) console.log(`[AUDIO ${this.username}] PCM packets=${this.audioStats.pcmPackets}, bytes=${this.audioStats.pcmBytes}`);
          this.broadcast(packet, { binary: true, compress: false });
          this.audioPipeBuffer = this.audioPipeBuffer.slice(total); continue;
        }
        this.audioPipeBuffer = this.audioPipeBuffer.slice(1);
      }
    });
  }

  cleanupProcess() {
    this.frameLoopActive = false; this.isRunning = false;
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
    const jvmArgs = [getEncodingJvmArg(encodingName), '-Djava.awt.headless=true', ...(CONFIG.audioPipe ? ['-Dfreej2me.audioPipe=1'] : []), '-jar', CONFIG.freej2meJar];
    const proc = spawn(CONFIG.javaPath, [...jvmArgs, ...buildArgs()], { stdio: ['pipe', 'pipe', 'pipe'], cwd: this.dataDir });
    this.process = proc; this.stdin = proc.stdin; this.stdoutReader = new StdoutReader(proc.stdout);
    this.audioPipeBuffer = Buffer.alloc(0); this.currentAudioFormat = null; this.audioStats = { formatPackets: 0, pcmPackets: 0, pcmBytes: 0, lastFormatAt: 0, lastPcmAt: 0 };
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
    this.broadcastConfig();
    this.startFrameLoop();
    setTimeout(() => { if (this.isRunning && CONFIG.audioPipe && this.audioStats.formatPackets === 0) this.broadcastJson(this.getAudioStatus({ event: 'timeout-no-audio', warning: 'no FJ2A audio packet after 5s' })); }, 5000);
  }

  async startFrameLoop() {
    const minFrameInterval = CONFIG.maxFps > 0 ? 1000 / CONFIG.maxFps : 0;
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
        if (minFrameInterval > 0) {
          const elapsed = now() - lastFrameTime;
          if (elapsed < minFrameInterval) await new Promise(r => setTimeout(r, minFrameInterval - elapsed));
          lastFrameTime = now();
        }
        if (this.countReadyClients() <= 0) { dropBackpressure++; this.sendFrameRequest(); continue; }
        const videoBuf = this.convertRgb24ToVideoBuffer(rgb24, width, height);
        for (const ws of this.clients) {
          if (ws.readyState === WebSocket.OPEN) {
            if (ws.bufferedAmount <= CONFIG.maxWsBufferedAmount) ws.send(videoBuf, { binary: true, compress: CONFIG.wsCompression });
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
  <div id="login-box" style="margin-bottom:10px;padding:10px;background:#252525;border-radius:8px;max-width:600px;width:100%;text-align:center">
    <span id="me-label">Chưa đăng nhập</span>
    <input id="login-user" placeholder="username" style="margin-left:8px;padding:6px;border-radius:5px;border:1px solid #555;background:#111;color:#fff">
    <input id="login-pass" placeholder="password" type="password" style="padding:6px;border-radius:5px;border:1px solid #555;background:#111;color:#fff">
    <button id="btn-login" style="padding:7px 10px;border:0;border-radius:5px;background:#0d5c0d;color:#fff">Login</button>
    <button id="btn-register" style="padding:7px 10px;border:0;border-radius:5px;background:#333;color:#fff">Register</button>
    <button id="btn-logout" style="padding:7px 10px;border:0;border-radius:5px;background:#5c0d0d;color:#fff;display:none">Logout</button>
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
    function setGameUiVisible(show) {
      gameLoaded = !!show;
      if (v11ControlsGuard) v11ControlsGuard.disabled = !!show;
      if (controlsEl) controlsEl.style.display = show ? 'grid' : 'none';
    }
    function setLoggedInUi(show) {
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
    refreshMe().then(() => { if (currentUser) setTimeout(connect, 100); });

    let audioCtx = null, audioUnlocked = false, audioMuted = false, audioNextTime = 0;
    let audioFormat = { sampleRate: 48000, channels: 2, bits: 16, signed: true, bigEndian: false };
    let videoCodec = 'rgba';
    let imageQuality = 100;
    function setAudioButton(t, title) { if(audioToggle){ audioToggle.textContent=t; if(title) audioToggle.title=title; } }
    function ensureAudioContext(){ if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)({latencyHint:'interactive'}); return audioCtx; }
    function browserTestBeep(){ try{ const ctx=ensureAudioContext(); const o=ctx.createOscillator(), g=ctx.createGain(); o.frequency.value=880; g.gain.setValueAtTime(0.001,ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.12,ctx.currentTime+0.015); g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+0.18); o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime+0.2);}catch(e){} }
    function unlockAudio(){ const ctx=ensureAudioContext(); ctx.resume(); audioUnlocked=true; audioMuted=false; audioNextTime=ctx.currentTime+0.08; setAudioButton('🔊 Âm thanh: bật'); browserTestBeep(); }
    audioToggle.onclick = () => { if(!audioUnlocked) unlockAudio(); else { audioMuted=!audioMuted; setAudioButton(audioMuted?'🔇 Âm thanh: tắt':'🔊 Âm thanh: bật'); if(!audioMuted) browserTestBeep(); } };
    function isAudioPacket(u8){ return u8 && u8.length>=5 && u8[0]===0x46 && u8[1]===0x4A && u8[2]===0x32 && u8[3]===0x41; }
    function handleAudioStatus(msg){ if(msg.format) setAudioButton(audioUnlocked&&!audioMuted?'🔊 Âm thanh: bật':'🔇 Bật âm thanh', 'fmt='+(msg.formatPackets||0)+' pcm='+(msg.pcmPackets||0)); }
    function handleAudioPacket(u8){
      if(!isAudioPacket(u8)) return false; const type=u8[4]; const dv=new DataView(u8.buffer,u8.byteOffset,u8.byteLength);
      if(type===1 && u8.length>=13){ audioFormat={sampleRate:dv.getUint32(5,false),channels:u8[9]||1,bits:u8[10]||16,signed:u8[11]!==0,bigEndian:u8[12]!==0}; return true; }
      if(type!==2 || u8.length<9) return true; const len=dv.getUint32(5,false); if(len<=0||9+len>u8.length||!audioUnlocked||audioMuted||!audioCtx||audioFormat.bits!==16) return true;
      const chs=Math.max(1,audioFormat.channels|0), frames=Math.floor(len/(2*chs)); if(frames<=0) return true; const buf=audioCtx.createBuffer(chs,frames,audioFormat.sampleRate||48000); const cd=[]; for(let c=0;c<chs;c++) cd[c]=buf.getChannelData(c); let off=9;
      for(let i=0;i<frames;i++){ for(let c=0;c<chs;c++){ let smp=audioFormat.bigEndian?((u8[off]<<8)|u8[off+1]):(u8[off]|(u8[off+1]<<8)); if(audioFormat.signed&&smp>=0x8000)smp-=0x10000; if(!audioFormat.signed)smp-=0x8000; cd[c][i]=Math.max(-1,Math.min(1,smp/32768)); off+=2; } }
      const src=audioCtx.createBufferSource(); src.buffer=buf; src.connect(audioCtx.destination); const n=audioCtx.currentTime; if(!audioNextTime||audioNextTime<n+0.02) audioNextTime=n+0.06; if(audioNextTime>n+0.45) return true; src.start(audioNextTime); audioNextTime+=buf.duration; return true;
    }

    // PERF: render latest frame only, reuse ImageData through replacement drawFrame below.
    let latestFrame = null, rafPending = false, reusableImageData = null;
    function decodeVideoFrameToImageData(src, imageData) {
      const dst = imageData.data;
      const pixels = screenWidth * screenHeight;
      // V15.1 safety: tự nhận codec theo kích thước packet để tránh đen màn hình
      // nếu config packet tới muộn hoặc client còn cache codec cũ.
      let codec = videoCodec;
      if (src.length >= pixels * 4) codec = 'rgba';
      else if (src.length >= pixels * 2) codec = 'rgb565';
      else if (src.length >= pixels) codec = 'rgb332';

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
    function scheduleDraw(){ if(rafPending) return; rafPending=true; requestAnimationFrame(()=>{ rafPending=false; if(!latestFrame) return; if(!reusableImageData || reusableImageData.width!==screenWidth || reusableImageData.height!==screenHeight) reusableImageData=ctx.createImageData(screenWidth, screenHeight); if(!decodeVideoFrameToImageData(latestFrame, reusableImageData)) return; ctx.putImageData(reusableImageData,0,0); frameCount++; const n=performance.now(); if(n-lastFpsTime>=1000){ fpsEl.textContent=frameCount+' FPS ['+videoCodec+' q'+imageQuality+']'; frameCount=0; lastFpsTime=n; } }); }
  `;
  html = html.replace("    const jarInput = document.getElementById('jar-input');", "    const jarInput = document.getElementById('jar-input');\n" + injected);
  html = html.replace('          drawFrame(new Uint8Array(event.data));', '          const u8 = new Uint8Array(event.data);\n          if (!handleAudioPacket(u8)) { latestFrame = u8; scheduleDraw(); }');
  // V15.1: nhận videoCodec/imageQuality từ config packet. Bản V15 thiếu đoạn này nên client tưởng frame là RGBA và bị đen màn hình.
  html = html.replace(
    '            screenHeight = msg.height;\n            canvas.width = screenWidth;',
    "            screenHeight = msg.height;\n            videoCodec = msg.videoCodec || videoCodec || 'rgba';\n            imageQuality = msg.imageQuality || imageQuality || 100;\n            canvas.width = screenWidth;"
  );

  // V15.1: không tự WebSocket reconnect khi chưa đăng nhập, để form login/register gõ bình thường.
  html = html.replace('    function connect() {', '    function connect() {\n      if (!shouldConnectWs) return;');
  html = html.replace('        setTimeout(connect, 2000);', '        if (shouldConnectWs) setTimeout(connect, 2000);');
  html = html.replace('    connect();', '    // V15.1: connect() được gọi sau khi đăng nhập thành công; không tự connect ở màn hình login.');
  html = html.replace("setStatus(`Đã kết nối - ${screenWidth}x${screenHeight}`, 'connected');\n          }", "setStatus(`Đã kết nối - ${screenWidth}x${screenHeight}`, 'connected');\n          } else if (msg.type === 'audio-status') {\n            handleAudioStatus(msg);\n          } else if (msg.type === 'auth') {\n            if (msg.noGame) {\n              setLoggedInUi(true);\n              setGameUiVisible(false);\n              setStatus('Đã đăng nhập - hãy upload game', 'connected');\n            } else if (msg.gameHash) {\n              setLoggedInUi(true);\n              setGameUiVisible(true);\n            }\n          }");
  // V15.1: ẩn bàn phím ảo trong lúc chưa tải game / đang upload.
  html = html.replace(
    "uploadStatus.textContent = 'Đang upload...';",
    "uploadStatus.textContent = 'Đang upload...';\n      setGameUiVisible(false);"
  );
  // V15.1: sau upload thành công, reconnect WS để bind vào emulator session mới.
  html = html.replace(
    "uploadStatus.textContent = `Đang chạy: ${file.name}`;",
    "uploadStatus.textContent = `Đang chạy: ${file.name}`;\n          // V15.1: không reconnect ở đây để tránh tạo 2 WebSocket và phát audio chồng tiếng. Server sẽ bind socket hiện tại vào session mới."
  );

  // V15.1: Cho phép gõ bình thường trong ô login/register/upload.
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
function intField(req, name, fallback) {
  const v = req.body && req.body[name];
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}
function strField(req, name, fallback) {
  return req.body && req.body[name] !== undefined && req.body[name] !== '' ? String(req.body[name]) : fallback;
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
  // -------- Headless Dev API: create isolated emulator instance without using built-in login/UI --------
  app.post('/api/instances', upload.single('jar'), async (req, res) => {
    if (!checkBridgeToken(req)) return res.status(401).json({ error: 'bad bridge token' });
    if (!req.file) return res.status(400).json({ error: 'missing jar field' });
    try {
      const externalUserId = strField(req, 'externalUserId', null);
      if (!externalUserId) throw new Error('externalUserId is required');
      const user = headlessUser(externalUserId);
      const jarPath = path.resolve(req.file.path);
      const gameHash = sha1File(jarPath);

      // Per-instance runtime config is intentionally kept simple here: process-level env/config is preferred.
      // For screen size, set SCREEN_WIDTH/SCREEN_HEIGHT before starting this core, or run separate core services.
      // The REST fields are returned for the dev app and future per-instance extension.
      const sess = getOrCreateSession(user, gameHash, jarPath);
      await sess.start();
      const instanceId = randomId('i_');
      sess.instanceId = instanceId;
      headlessInstances.set(instanceId, sess);
      res.json({
        success: true,
        instanceId,
        gameHash,
        wsPath: `/ws/${instanceId}`,
        dataDir: sess.dataDir,
        config: {
          width: sess.streamOutWidth,
          height: sess.streamOutHeight,
          videoCodec: CONFIG.videoCodec,
          imageQuality: CONFIG.imageQuality,
          scale: CONFIG.streamScale,
        },
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
    res.json({ success: true, instanceId: req.params.id, running: sess.isRunning, clients: sess.clients.size, gameHash: sess.gameHash, dataDir: sess.dataDir });
  });

  app.delete('/api/instances/:id', (req, res) => {
    if (!checkBridgeToken(req)) return res.status(401).json({ error: 'bad bridge token' });
    const sess = headlessInstances.get(req.params.id);
    if (sess) { sess.cleanupProcess(); headlessInstances.delete(req.params.id); emulatorSessions.delete(sess.key); }
    res.json({ success: true });
  });

  app.post('/upload', upload.single('jar'), async (req, res) => {
    const user = requireUser(req, res); if (!user) return;
    if (!req.file) return res.status(400).json({ error: 'Không có file' });
    try {
      const jarPath = path.resolve(req.file.path);
      const gameHash = sha1File(jarPath);
      if (emulatorSessions.size >= CONFIG.maxActiveSessions && !getActiveSessionForUser(user.id)) throw new Error('Server đã đạt giới hạn session đang chạy');
      const sess = getOrCreateSession(user, gameHash, jarPath);
      await sess.start();
      // V15.1: bind các WebSocket đang mở của user này vào session mới.
      // Bản V10 tạo session sau upload nhưng WebSocket cũ vẫn ở trạng thái noGame.
      if (wss) {
        wss.clients.forEach((ws) => {
          if (ws.readyState === WebSocket.OPEN && ws._userId === user.id && ws._emuSession !== sess) sess.addClient(ws);
        });
      }
      res.json({ success: true, gameHash, jar: req.file.filename, user: db.publicUser(user), dataDir: sess.dataDir });
    } catch (e) { console.error('[Upload]', e); res.status(500).json({ error: e.message }); }
  });

  app.get(['/', '/index.html'], (req, res) => { try { res.type('html').send(getPatchedIndexHtml()); } catch (e) { console.error('[Web]', e); res.sendFile(path.join(__dirname, 'public', 'index.html')); } });
  app.use(express.static(path.join(__dirname, 'public')));

  const server = http.createServer(app);
  wss = new WebSocket.Server({ server, perMessageDeflate: CONFIG.wsCompression ? { zlibDeflateOptions: { level: 1, memLevel: 7 }, clientNoContextTakeover: true, serverNoContextTakeover: true, threshold: 1024 } : false });
  console.log(`[Stream] maxFps=${CONFIG.maxFps}, scale=${CONFIG.streamScale}, videoCodec=${CONFIG.videoCodec}, imageQuality=${CONFIG.imageQuality}, wsCompression=${CONFIG.wsCompression ? 'on' : 'off'}, audioPipe=${CONFIG.audioPipe ? 'on' : 'off'}, maxBuffered=${CONFIG.maxWsBufferedAmount}`);
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
    if (!sess) { ws.send(JSON.stringify({ type: 'auth', user: db.publicUser(user), noGame: true })); ws.send(JSON.stringify({ type: 'config', width: Math.floor(CONFIG.width / CONFIG.streamScale), height: Math.floor(CONFIG.height / CONFIG.streamScale), scale: CONFIG.streamScale, videoCodec: CONFIG.videoCodec, imageQuality: CONFIG.imageQuality })); }
    else sess.addClient(ws);
    ws.on('message', msg => {
      try {
        const s = ws._emuSession || getActiveSessionForUser(user.id); if (!s) return; s.touch();
        const data = JSON.parse(msg.toString());
        if (data.type === 'key') { if (data.state === 'D') s.sendKeyDown(data.key); else if (data.state === 'U') s.sendKeyUp(data.key); }
        else if (data.type === 'touch') { let cmd = data.state === 'D' ? 5 : data.state === 'U' ? 4 : data.state === 'M' ? 6 : 0; if (cmd) { const scale = Math.max(1, CONFIG.streamScale | 0); const x = data.x < 0 ? data.x : Math.max(0, Math.min(s.emuFrameWidth - 1, Math.floor(data.x * scale))); const y = data.y < 0 ? data.y : Math.max(0, Math.min(s.emuFrameHeight - 1, Math.floor(data.y * scale))); s.sendMouse(cmd, x, y); } }
      } catch (e) { console.error('[WS]', e.message); }
    });
  });

  server.listen(CONFIG.port, '0.0.0.0', () => console.log(`[WebServer] http://localhost:${CONFIG.port}`));
}

// =================== MAIN ===================
async function main() { ensureDir(CONFIG.uploadsDir); ensureDir(CONFIG.dataDir); validateRuntimePaths(); startWebServer(); }
main().catch(err => { console.error('Lỗi nghiêm trọng:', err); process.exit(1); });
