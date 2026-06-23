/******************************************************************************
 * FreeJ2ME Web Bridge - Extension Module for freej2me-web (CheerpJ) Integration
 *
 * File này là module MỞ RỘNG cho server.js. Mục đích:
 *  - Cho phép freej2me-web (https://github.com/zb3/freej2me-web) gọi sang Node.js
 *    bridge thông qua API. Khi user ấn "Run on Node.js Bridge" trong launcher
 *    của freej2me-web, JAR + settings được đẩy sang Node.js, Node.js chạy
 *    emulator serverside và stream frames (video + audio) về client qua
 *    WebSocket. Client (vẫn dùng UI của freej2me-web, vd: canvas, keypad) vẽ
 *    lại các frame đó. Tức là phần "vẽ" được chuyển từ CheerpJ WASM sang
 *    Node.js bridge serverside, giúp game chạy mượt hơn và tương thích
 *    nhiều game hơn (đặc biệt M3G, Mascot Capsule, MIDI nặng).
 *
 *  - Game WASM (CheerpJ) của freej2me-web vẫn hoạt động bình thường, không
 *    bị ảnh hưởng. Tích hợp này là OPT-IN: user ấn nút mới trong launcher
 *    thì mới qua bridge.
 *
 *  - Tương thích PHP/MySQL web hosting: server chấp nhận cookie PHPSESSID
 *    (chia sẻ session với PHP site), response theo envelope { success, data,
 *    error } giống PHP REST API. Nếu cấu hình mysql trong config.json thì
 *    sẽ dùng MySQL làm DB (cũng tự tạo table), nếu không thì fallback về
 *    JSON DB của server.js.
 *
 *  - File này được require() từ server.js. Không tự khởi chạy.
 *
 * API endpoints thêm vào (cộng dồn với server.js gốc):
 *   POST /bridge/fj2meweb/push-game
 *     freej2me-web client gửi JAR + settings sang. Trả về { gameId,
 *     streamUrl, settings, ... }.
 *   GET  /bridge/fj2meweb/launch/:gameId
 *     Yêu cầu bridge khởi động game (nếu chưa chạy). Trả về thông tin
 *     session + stream URL.
 *   GET  /bridge/fj2meweb/stream/:gameId
 *     WebSocket stream: server gửi nhị phân (RGB565/RGBA/WebP frames + FJ2A
 *     audio), client gửi JSON { type: 'key'|'touch'|'ping' }.
 *   GET  /bridge/fj2meweb/settings/:gameId
 *     Lấy config hiện tại của game (kết hợp config.json + client settings).
 *   POST /bridge/fj2meweb/settings/:gameId
 *     Cập nhật config cho game (vd: phoneType, fps, sound). Persist vào
 *     config.json nếu chạy standalone, hoặc MySQL nếu enable.
 *   GET  /bridge/fj2meweb/list
 *     Liệt kê các bridge games hiện có.
 *   GET  /bridge/fj2meweb/compat/:gameId
 *     Trả về { needsBridge: true|false, reason: '...' } để client tự quyết
 *     định có dùng bridge không.
 *   POST /bridge/api  (PHP-style envelope)
 *     Endpoint kiểu PHP API: action=login|register|upload|launch|list|
 *     settings. Response { success, data, error }.
 *
 * Drop-in: require('./fj2me-bridge') rồi gọi mountBridge({ app, wssRef, db,
 * CONFIG, publicSessionIds }). Không cần sửa server.js quá nhiều.
 *****************************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

// Optional deps (giống pattern của server.js gốc: try/catch require).
let mysqlPool = null;
try {
  const mysql = require('mysql2/promise');
  mysqlPool = mysql; // chỉ là reference, pool tạo sau.
} catch (e) { /* optional */ }

const BRIDGE_AUDIO_MAGIC = Buffer.from('FJ2A');

// =================================================================
// Helper utilities
// =================================================================
function b64ToBuf(b64) {
  if (!b64) return Buffer.alloc(0);
  try { return Buffer.from(b64, 'base64'); } catch (e) { return Buffer.alloc(0); }
}
function bufToB64(buf) {
  if (!buf || !buf.length) return '';
  return Buffer.from(buf).toString('base64');
}
function safeName(s) {
  return String(s || '').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
}
function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
function sha1Buf(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}
function nowMs() { return Date.now(); }
function nowSec() { return Math.floor(Date.now() / 1000); }
function randomId(prefix = '') { return prefix + crypto.randomBytes(12).toString('hex'); }

// =================================================================
// PHP-style response envelope. { success, data, error, meta }.
// =================================================================
function phpResponse(res, ok, data, error, httpStatus) {
  if (httpStatus) res.status(httpStatus);
  res.json({
    success: !!ok,
    data: data || null,
    error: error || null,
    meta: { server: 'fj2me-bridge', ts: nowSec() },
  });
}

// =================================================================
// PHP session detection. Cho phép web hosting PHP dùng chung session.
// =================================================================
function parsePhpSessionFromRequest(req) {
  const cookies = (req.headers && req.headers.cookie) || '';
  const out = {};
  cookies.split(/[;]\s*/).forEach((p) => {
    const idx = p.indexOf('=');
    if (idx > 0) out[p.slice(0, idx).trim()] = decodeURIComponent(p.slice(idx + 1).trim());
  });
  return out;
}

// =================================================================
// JSON DB compat layer - mở rộng server.js JsonDB để hỗ trợ thêm
// settings per-game và bridge sessions.
// =================================================================
class BridgeStore {
  constructor(opts) {
    this.opts = opts || {};
    this.filePath = opts.dbPath || path.join(__dirname, 'freej2me_data', 'bridge.json');
    this.data = { bridgeGames: {}, bridgeConfigs: {}, bridgeSessions: {}, mysqlMirror: false };
    this._load();
  }
  _load() {
    try {
      if (!fs.existsSync(path.dirname(this.filePath))) fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      if (fs.existsSync(this.filePath)) this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.data.bridgeGames ||= {};
      this.data.bridgeConfigs ||= {};
      this.data.bridgeSessions ||= {};
      this._save();
    } catch (e) { /* giữ nguyên default */ }
  }
  _save() {
    try { fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2)); } catch (e) {}
  }

  // Game registry: { gameId -> { appId, name, jarSha1, jarSize, createdAt, lastLaunch, launchCount } }
  registerGame(gameId, info) {
    this.data.bridgeGames[gameId] = Object.assign(this.data.bridgeGames[gameId] || {}, info);
    this._save();
  }
  getGame(gameId) { return this.data.bridgeGames[gameId] || null; }
  listGames() { return Object.entries(this.data.bridgeGames).map(([id, g]) => Object.assign({ gameId: id }, g)); }
  deleteGame(gameId) { delete this.data.bridgeGames[gameId]; delete this.data.bridgeConfigs[gameId]; this._save(); }

  // Per-game config: { gameId -> { phoneType, width, height, ... } }
  getConfig(gameId) { return this.data.bridgeConfigs[gameId] || {}; }
  setConfig(gameId, cfg) { this.data.bridgeConfigs[gameId] = cfg; this._save(); }

  // Per-session: { sid -> { gameId, userId, createdAt, lastActivity } }
  putSession(sid, info) { this.data.bridgeSessions[sid] = info; this._save(); }
  getSession(sid) { return this.data.bridgeSessions[sid] || null; }
  deleteSession(sid) { delete this.data.bridgeSessions[sid]; this._save(); }
  purgeExpired(ttlMs) {
    const cutoff = nowMs() - ttlMs;
    let removed = 0;
    for (const [sid, s] of Object.entries(this.data.bridgeSessions)) {
      if ((s.lastActivity || 0) < cutoff) { delete this.data.bridgeSessions[sid]; removed++; }
    }
    if (removed) this._save();
    return removed;
  }
}

// =================================================================
// MySQL bridge store - chỉ chạy khi bridge.mysql.enabled = true.
// Tự tạo tables nếu chưa có. Schema đơn giản để dễ quản lý qua phpMyAdmin.
// =================================================================
class MysqlBridgeStore {
  constructor(opts) {
    this.opts = opts || {};
    this.pool = null;
    this.ready = false;
  }
  async init() {
    if (!mysqlPool) throw new Error('mysql2 chưa cài. Chạy: npm install mysql2');
    const o = this.opts;
    this.pool = mysqlPool.createPool({
      host: o.host, port: o.port || 3306, user: o.user, password: o.password,
      database: o.database, charset: o.charset || 'utf8mb4', waitForConnections: true,
      connectionLimit: 5, queueLimit: 0,
    });
    await this._ensureSchema();
    this.ready = true;
  }
  async _conn() { return await this.pool.getConnection(); }
  async _ensureSchema() {
    const sql = [
      `CREATE TABLE IF NOT EXISTS bridge_games (
        game_id VARCHAR(64) PRIMARY KEY,
        app_id VARCHAR(128), name VARCHAR(255), jar_sha1 VARCHAR(64),
        jar_size BIGINT, created_at BIGINT, last_launch BIGINT,
        launch_count INT DEFAULT 0, jar_path TEXT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS bridge_configs (
        game_id VARCHAR(64) PRIMARY KEY,
        config_json MEDIUMTEXT, updated_at BIGINT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS bridge_sessions (
        sid VARCHAR(96) PRIMARY KEY,
        game_id VARCHAR(64), user_id VARCHAR(96), created_at BIGINT,
        last_activity BIGINT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ];
    const conn = await this._conn();
    try { for (const s of sql) await conn.query(s); } finally { conn.release(); }
  }
  async registerGame(gameId, info) {
    const conn = await this._conn();
    try {
      await conn.query(
        `INSERT INTO bridge_games (game_id, app_id, name, jar_sha1, jar_size, created_at, last_launch, launch_count, jar_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE app_id=VALUES(app_id), name=VALUES(name),
           jar_sha1=VALUES(jar_sha1), jar_size=VALUES(jar_size), last_launch=VALUES(last_launch)`,
        [gameId, info.appId || null, info.name || null, info.jarSha1 || null,
         info.jarSize || 0, info.createdAt || nowMs(), info.lastLaunch || nowMs(),
         info.launchCount || 0, info.jarPath || null]
      );
    } finally { conn.release(); }
  }
  async getGame(gameId) {
    const conn = await this._conn();
    try {
      const [rows] = await conn.query('SELECT * FROM bridge_games WHERE game_id=? LIMIT 1', [gameId]);
      return rows[0] || null;
    } finally { conn.release(); }
  }
  async listGames() {
    const conn = await this._conn();
    try {
      const [rows] = await conn.query('SELECT * FROM bridge_games ORDER BY last_launch DESC');
      return rows;
    } finally { conn.release(); }
  }
  async deleteGame(gameId) {
    const conn = await this._conn();
    try {
      await conn.query('DELETE FROM bridge_games WHERE game_id=?', [gameId]);
      await conn.query('DELETE FROM bridge_configs WHERE game_id=?', [gameId]);
    } finally { conn.release(); }
  }
  async getConfig(gameId) {
    const conn = await this._conn();
    try {
      const [rows] = await conn.query('SELECT config_json FROM bridge_configs WHERE game_id=? LIMIT 1', [gameId]);
      if (!rows[0]) return {};
      try { return JSON.parse(rows[0].config_json); } catch (e) { return {}; }
    } finally { conn.release(); }
  }
  async setConfig(gameId, cfg) {
    const conn = await this._conn();
    try {
      await conn.query(
        `INSERT INTO bridge_configs (game_id, config_json, updated_at) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE config_json=VALUES(config_json), updated_at=VALUES(updated_at)`,
        [gameId, JSON.stringify(cfg), nowMs()]
      );
    } finally { conn.release(); }
  }
  async putSession(sid, info) {
    const conn = await this._conn();
    try {
      await conn.query(
        `INSERT INTO bridge_sessions (sid, game_id, user_id, created_at, last_activity) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE game_id=VALUES(game_id), last_activity=VALUES(last_activity)`,
        [sid, info.gameId || null, info.userId || null, info.createdAt || nowMs(), info.lastActivity || nowMs()]
      );
    } finally { conn.release(); }
  }
  async getSession(sid) {
    const conn = await this._conn();
    try {
      const [rows] = await conn.query('SELECT * FROM bridge_sessions WHERE sid=? LIMIT 1', [sid]);
      return rows[0] || null;
    } finally { conn.release(); }
  }
  async deleteSession(sid) {
    const conn = await this._conn();
    try { await conn.query('DELETE FROM bridge_sessions WHERE sid=?', [sid]); } finally { conn.release(); }
  }
  async purgeExpired(ttlMs) {
    const conn = await this._conn();
    try {
      const [r] = await conn.query('DELETE FROM bridge_sessions WHERE last_activity < ?', [nowMs() - ttlMs]);
      return r.affectedRows || 0;
    } finally { conn.release(); }
  }
  async close() { if (this.pool) await this.pool.end(); }
}

// =================================================================
// Resolve per-game config. Ưu tiên: 1) MySQL nếu enabled, 2) config.json
// perGame section, 3) defaults ở root config.json.
// =================================================================
function resolveGameConfig({ gameId, appId, clientSettings, rootConfig }) {
  const defaults = {
    width: rootConfig.width || 240,
    height: rootConfig.height || 320,
    phoneType: rootConfig.phoneType || 0,
    fps: rootConfig.fps || 60,
    sound: rootConfig.sound || 1,
    rotate: rootConfig.rotate || 0,
    maxFps: rootConfig.maxFps || 30,
    streamScale: (rootConfig.bridge && rootConfig.bridge.streamScale) || 1,
    videoCodec: (rootConfig.bridge && rootConfig.bridge.videoCodec) || '',
    imageQuality: (rootConfig.bridge && rootConfig.bridge.imageQuality) || 65,
    audioCodec: (rootConfig.bridge && rootConfig.bridge.audioCodec) || 'opus',
  };
  const perGame = (rootConfig.perGame && (rootConfig.perGame[gameId] || rootConfig.perGame[appId])) || {};
  const merged = Object.assign({}, defaults, perGame);
  if (clientSettings && typeof clientSettings === 'object') {
    for (const k of Object.keys(clientSettings)) {
      if (clientSettings[k] !== undefined && clientSettings[k] !== null && clientSettings[k] !== '') {
        merged[k] = clientSettings[k];
      }
    }
  }
  return merged;
}

// =================================================================
// Compatibility detection: gợi ý nên dùng bridge hay không dựa vào
// các flag CheerpJ thường gặp vấn đề.
// =================================================================
function suggestBridge(gameInfo) {
  const reasons = [];
  if (!gameInfo) return { needsBridge: false, reasons: [] };
  if (gameInfo.requiresM3G || gameInfo.hasMascotCapsule || gameInfo.requires3D) {
    reasons.push('Game có M3G / Mascot Capsule / 3D - thường chạy kém trên CheerpJ, nên chuyển sang Node.js bridge.');
  }
  if (gameInfo.requiresMidi && gameInfo.midiComplex) {
    reasons.push('MIDI phức tạp - bridge serverside sẽ mượt hơn.');
  }
  if (gameInfo.largeJar || (gameInfo.jarSize || 0) > 1.5 * 1024 * 1024) {
    reasons.push('JAR > 1.5MB - CheerpJ load chậm.');
  }
  return { needsBridge: reasons.length > 0, reasons };
}

// =================================================================
// Parse settings.conf / appproperties.conf từ freej2me-web CheerpJ
// "key: value" per line (đúng format của freej2me-web).
// =================================================================
function parseCheerpjConf(text) {
  const out = {};
  if (!text) return out;
  String(text).split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([^:]+?)\s*:\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  });
  return out;
}

// =================================================================
// Xây JVM args + argv cho freej2me-lr.jar (mirror EmulatorSession.buildArgs
// ở server.js gốc nhưng cho bridge). Trả về mảng args.
// =================================================================
function buildBridgeEmulatorArgs(cfg) {
  const s = {
    width: cfg.width | 0, height: cfg.height | 0, rotate: cfg.rotate | 0,
    phoneType: cfg.phoneType | 0, fps: cfg.fps | 0, sound: cfg.sound | 0,
    useCustomMidi: 0, dumpAudioStreams: 0, minLogLevel: 2, noAlphaOnBlankImages: 1,
    maskIndex: 1, compatFantasyZoneFix: 0, compatTranslateToOriginOnReset: 0,
    useCustomTextFont: 0, fontSizeOffset: 0, dumpGraphicsObjects: 0,
    deleteTemporaryKJXFiles: 1, M3GRenderUntexturedPolygons: 0,
    M3GRenderWireframe: 0, unlockFramerateHack: 0, compatImmediateRepaints: 0,
    compatOverridePlatformChecks: 1, compatSiemensFriendlyDrawing: 0,
    halfResM3GRaster: 0, DoJaVersion: 200, compatIgnoreVolumeChanges: 0,
    halfResMCV3Raster: 0, MCV3NoLighting: 0, compatMCV3HorizontalFovFix: 0,
    MCV3ShowHeapUsage: 0, MCV3ShowTimeMetrics: 0,
  };
  return [
    s.width, s.height, s.rotate, s.phoneType, s.fps, s.sound,
    s.useCustomMidi, s.dumpAudioStreams, s.minLogLevel, s.noAlphaOnBlankImages,
    s.maskIndex, s.compatFantasyZoneFix, s.compatTranslateToOriginOnReset,
    s.useCustomTextFont, s.fontSizeOffset, s.dumpGraphicsObjects,
    s.deleteTemporaryKJXFiles, s.M3GRenderUntexturedPolygons,
    s.M3GRenderWireframe, s.unlockFramerateHack, s.compatImmediateRepaints,
    s.compatOverridePlatformChecks, s.compatSiemensFriendlyDrawing,
    s.halfResM3GRaster, s.DoJaVersion, s.compatIgnoreVolumeChanges,
    s.halfResMCV3Raster, s.MCV3NoLighting, s.compatMCV3HorizontalFovFix,
    s.MCV3ShowHeapUsage, s.MCV3ShowTimeMetrics,
  ].map(String);
}

// =================================================================
// Bridge session lifecycle - một instance freej2me-lr.jar cho 1 game.
// Tái sử dụng các utility từ server.js gốc (StdoutReader, EmulatorSession
// classes) nếu được truyền vào qua opts.sessionFactory. Nếu không, tự
// dựng session đơn giản để vẫn hoạt động độc lập.
// =================================================================
class BridgeEmulatorSession {
  constructor({ gameId, appId, jarPath, javaPath, freej2meJar, config, onFrame, onAudio, onLog, onStatus }) {
    this.gameId = gameId;
    this.appId = appId;
    this.jarPath = jarPath;
    this.javaPath = javaPath;
    this.freej2meJar = freej2meJar;
    this.config = config;
    this.onFrame = onFrame || (() => {});
    this.onAudio = onAudio || (() => {});
    this.onLog = onLog || (() => {});
    this.onStatus = onStatus || (() => {});
    this.process = null;
    this.stdin = null;
    this.stdoutReader = null;
    this.isRunning = false;
    this.startedAt = 0;
    this.emuFrameWidth = config.width;
    this.emuFrameHeight = config.height;
    this.audioBuf = Buffer.alloc(0);
    this.audioFormat = null;
    this.ffmpeg = null;
    this.ffmpegReady = false;
    this.clients = new Set();
    this._stderrBuf = Buffer.alloc(0);
  }
  attachClient(ws) { this.clients.add(ws); ws._bridgeSession = this; }
  detachClient(ws) { this.clients.delete(ws); }
  broadcastFrame(buf) { for (const ws of this.clients) try { ws.send(buf, { binary: true }); } catch (e) {} }
  broadcastJson(obj) { const s = JSON.stringify(obj); for (const ws of this.clients) try { ws.send(s); } catch (e) {} }

  sendKey(keyIndex, state /* 'D'|'U' */) {
    const b = Buffer.alloc(5);
    b[0] = state === 'D' ? 3 : 2;
    b.writeInt32BE(keyIndex, 1);
    if (this.stdin && !this.stdin.destroyed) this.stdin.write(b);
  }
  sendMouse(cmd, x, y) {
    const b = Buffer.alloc(5);
    b[0] = cmd; b[1] = (x >> 8) & 255; b[2] = x & 255; b[3] = (y >> 8) & 255; b[4] = y & 255;
    if (this.stdin && !this.stdin.destroyed) this.stdin.write(b);
  }
  sendFrameRequest() { const b = Buffer.alloc(5); b[0] = 15; if (this.stdin && !this.stdin.destroyed) this.stdin.write(b); }
  sendLoadJar(jarPath) {
    const pb = Buffer.from(jarPath, 'utf8');
    const h = Buffer.alloc(5);
    h[0] = 10; h.writeInt32BE(pb.length, 1);
    if (this.stdin && !this.stdin.destroyed) { this.stdin.write(h); this.stdin.write(pb); }
  }

  async start() {
    if (this.isRunning) return;
    if (!fs.existsSync(this.javaPath)) throw new Error('Không tìm thấy java: ' + this.javaPath);
    if (!fs.existsSync(this.freej2meJar)) throw new Error('Không tìm thấy jar: ' + this.freej2meJar);
    if (!fs.existsSync(this.jarPath)) throw new Error('Không tìm thấy game jar: ' + this.jarPath);

    const jvmArgs = ['-Dfile.encoding=ISO_8859_1', '-Djava.awt.headless=true',
      '-Dfreej2me.audioPipe=1', '-jar', this.freej2meJar, ...buildBridgeEmulatorArgs(this.config)];
    this.onLog('[bridge-jar] java ' + jvmArgs.join(' '));
    const proc = spawn(this.javaPath, jvmArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.process = proc;
    this.stdin = proc.stdin;
    this.stdoutReader = new SimpleStreamReader(proc.stdout);
    proc.stderr.on('data', (chunk) => this._onStderr(chunk));
    proc.on('exit', (code) => { this.onLog(`[bridge-jar] exit code=${code}`); this.isRunning = false; this.onStatus('exited'); });
    proc.on('error', (err) => { this.onLog('[bridge-jar] error: ' + err.message); this.isRunning = false; this.onStatus('error'); });

    // Đợi +READY.
    const startDeadline = nowMs() + 20000;
    while (nowMs() < startDeadline) {
      const line = await Promise.race([this.stdoutReader.readLine(), new Promise((_, r) => setTimeout(() => r(new Error('timeout-read')), 5000))]).catch(() => null);
      if (!line) break;
      const text = String(line).trim();
      if (text) this.onLog('[bridge-jar-stdout] ' + text);
      if (text.includes('+READY')) break;
    }
    this.sendLoadJar(this.jarPath);
    await new Promise((r) => setTimeout(r, 800));
    this.sendFrameRequest();
    this.isRunning = true;
    this.startedAt = nowMs();
    this.onStatus('running');
    this._startFrameLoop().catch((e) => this.onLog('[bridge-frame] ' + e.message));
  }
  async _startFrameLoop() {
    while (this.isRunning) {
      try {
        // Read 1 byte; nếu không phải 0xFE (frame marker), bỏ qua.
        let first;
        try { first = await this.stdoutReader.readBytes(1); } catch (e) { break; }
        if (!first || first[0] !== 0xFE) continue;
        let rest;
        try { rest = await this.stdoutReader.readBytes(15); } catch (e) { break; }
        const header = Buffer.concat([first, rest]);
        const width = (header[1] << 8) | header[2];
        const height = (header[3] << 8) | header[4];
        if (header[14] === 1) {
          // Encoding switch marker - re-init nếu cần.
          const enc = ['ISO-8859-1', 'Shift_JIS', 'EUC-KR'][header[15]] || 'ISO-8859-1';
          const expected = Math.max(1, this.emuFrameWidth) * Math.max(1, this.emuFrameHeight) * 3;
          try { await this.stdoutReader.readBytes(expected); } catch (e) {}
          this.onLog('[bridge-jar] encoding switch: ' + enc);
          continue;
        }
        if (width <= 0 || height <= 0) continue;
        const frameSize = width * height * 3;
        this.emuFrameWidth = width;
        this.emuFrameHeight = height;
        let rgb24;
        try { rgb24 = await this.stdoutReader.readBytes(frameSize); } catch (e) { break; }
        this.onFrame(rgb24, width, height);
        this.sendFrameRequest();
      } catch (e) {
        this.onLog('[bridge-frame-loop] ' + e.message);
        break;
      }
    }
  }
  _onStderr(chunk) {
    this._stderrBuf = Buffer.concat([this._stderrBuf, chunk]);
    while (this._stderrBuf.length > 0) {
      const idx = this._stderrBuf.indexOf(BRIDGE_AUDIO_MAGIC);
      if (idx < 0) {
        // Không có magic - log text nếu còn lại dài > 3.
        if (this._stderrBuf.length > 256) {
          const txt = this._stderrBuf.slice(0, this._stderrBuf.length - 3).toString('utf8').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]+/g, '').trim();
          if (txt) this.onLog('[bridge-jar-stderr] ' + txt);
          this._stderrBuf = this._stderrBuf.slice(-3);
        }
        return;
      }
      if (idx > 0) {
        const txt = this._stderrBuf.slice(0, idx).toString('utf8').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]+/g, '').trim();
        if (txt) this.onLog('[bridge-jar-stderr] ' + txt);
        this._stderrBuf = this._stderrBuf.slice(idx);
      }
      if (this._stderrBuf.length < 5) return;
      const type = this._stderrBuf[4];
      if (type === 1) {
        if (this._stderrBuf.length < 13) return;
        const fmt = {
          sampleRate: this._stderrBuf.readUInt32BE(5),
          channels: this._stderrBuf[9] || 1, bits: this._stderrBuf[10] || 16,
          signed: this._stderrBuf[11] !== 0, bigEndian: this._stderrBuf[12] !== 0,
        };
        this.audioFormat = fmt;
        this.onAudio('format', fmt);
        this._stderrBuf = this._stderrBuf.slice(13);
        continue;
      }
      if (type === 2) {
        if (this._stderrBuf.length < 9) return;
        const len = this._stderrBuf.readUInt32BE(5);
        const total = 9 + len;
        if (this._stderrBuf.length < total) return;
        const payload = Buffer.from(this._stderrBuf.slice(9, total));
        this.onAudio('pcm', payload, this.audioFormat);
        this._stderrBuf = this._stderrBuf.slice(total);
        continue;
      }
      this._stderrBuf = this._stderrBuf.slice(1);
    }
  }
  stop() {
    this.isRunning = false;
    try { if (this.process && !this.process.killed) this.process.kill('SIGTERM'); } catch (e) {}
    if (this.ffmpeg) { try { this.ffmpeg.kill('SIGTERM'); } catch (e) {} }
    this.process = null; this.stdin = null; this.stdoutReader = null;
  }
}

// =================================================================
// Minimal stream reader - tách riêng để module này hoạt động độc lập
// với server.js (không cần require server.js, tránh circular dep).
// =================================================================
class SimpleStreamReader {
  constructor(stream) {
    this.stream = stream;
    this.buffer = Buffer.alloc(0);
    this.pending = [];
    this.ended = false;
    stream.on('data', (chunk) => { this.buffer = Buffer.concat([this.buffer, chunk]); this._pump(); });
    stream.on('end', () => { this.ended = true; this._pump(); });
    stream.on('error', (err) => { this.pending.forEach((p) => p.reject(err)); this.pending = []; });
  }
  _pump() {
    while (this.pending.length > 0) {
      const req = this.pending[0];
      if (req.type === 'line') {
        const idx = this.buffer.indexOf('\n');
        if (idx !== -1) { this.pending.shift(); const line = this.buffer.slice(0, idx + 1).toString('utf8'); this.buffer = this.buffer.slice(idx + 1); req.resolve(line); }
        else if (this.ended) { this.pending.shift(); if (this.buffer.length) { const line = this.buffer.toString('utf8'); this.buffer = Buffer.alloc(0); req.resolve(line); } else req.reject(new Error('ended')); }
        else break;
      } else if (req.type === 'bytes') {
        if (this.buffer.length >= req.size) { this.pending.shift(); const d = this.buffer.slice(0, req.size); this.buffer = this.buffer.slice(req.size); req.resolve(d); }
        else if (this.ended) { this.pending.shift(); req.reject(new Error('ended-before-bytes')); }
        else break;
      }
    }
  }
  readLine() { return new Promise((res, rej) => { this.pending.push({ type: 'line', resolve: res, reject: rej }); this._pump(); }); }
  readBytes(n) { return new Promise((res, rej) => { this.pending.push({ type: 'bytes', size: n, resolve: res, reject: rej }); this._pump(); }); }
  prepend(d) { this.buffer = Buffer.concat([d, this.buffer]); this._pump(); }
}

// =================================================================
// Frame encoder: RGB24 -> RGB565/RGB332/RGBA/WebP cho bridge client.
// Output là binary buffer broadcast qua WebSocket.
// =================================================================
function rgb24ToBridgeBuffer(rgb24, width, height, codec, scale, sharpLib) {
  scale = Math.max(1, scale | 0);
  const outW = Math.max(1, Math.floor(width / scale));
  const outH = Math.max(1, Math.floor(height / scale));
  if (codec === 'webp' && sharpLib) {
    const raw = Buffer.alloc(outW * outH * 3);
    let dst = 0;
    for (let y = 0; y < outH; y++) {
      const rowStart = (y * scale * width) * 3;
      for (let x = 0; x < outW; x++) {
        const src = rowStart + (x * scale * 3);
        raw[dst++] = rgb24[src]; raw[dst++] = rgb24[src + 1]; raw[dst++] = rgb24[src + 2];
      }
    }
    return sharpLib(raw, { raw: { width: outW, height: outH, channels: 3 } }).webp({ quality: 60 }).toBuffer();
  }
  if (codec === 'rgb332') {
    const out = Buffer.allocUnsafe(outW * outH);
    let dst = 0;
    for (let y = 0; y < outH; y++) {
      const rowStart = (y * scale * width) * 3;
      for (let x = 0; x < outW; x++) {
        const src = rowStart + (x * scale * 3);
        out[dst++] = (rgb24[src] & 0xE0) | ((rgb24[src + 1] & 0xE0) >> 3) | (rgb24[src + 2] >> 6);
      }
    }
    return out;
  }
  if (codec === 'rgb565') {
    const out = Buffer.allocUnsafe(outW * outH * 2);
    let dst = 0;
    for (let y = 0; y < outH; y++) {
      const rowStart = (y * scale * width) * 3;
      for (let x = 0; x < outW; x++) {
        const src = rowStart + (x * scale * 3);
        const v = ((rgb24[src] & 0xF8) << 8) | ((rgb24[src + 1] & 0xFC) << 3) | (rgb24[src + 2] >> 3);
        out[dst++] = v & 0xFF; out[dst++] = (v >> 8) & 0xFF;
      }
    }
    return out;
  }
  // RGBA default.
  const out = Buffer.allocUnsafe(outW * outH * 4);
  let dst = 0;
  for (let y = 0; y < outH; y++) {
    const rowStart = (y * scale * width) * 3;
    for (let x = 0; x < outW; x++) {
      const src = rowStart + (x * scale * 3);
      out[dst++] = rgb24[src]; out[dst++] = rgb24[src + 1]; out[dst++] = rgb24[src + 2]; out[dst++] = 255;
    }
  }
  return out;
}

// =================================================================
// Main mount function. Được gọi từ server.js sau khi đã setup express
// và wss. Truyền vào các dependencies cần thiết để gắn thêm routes.
// =================================================================
function mountBridge(deps) {
  const {
    app,                  // express app instance
    wss,                  // WebSocket.Server instance (optional - bridge có thể dùng ws riêng)
    WebSocket,            // ws module constructor
    db,                   // server.js JsonDB instance (cho user auth)
    CONFIG,               // server.js CONFIG object
    requireUserFn,        // (req, res) => user hoặc null
    getIpFn,              // (req) => string IP
    memoryRateLimitFn,    // (key, limit, window) -> { ok, ... }
    parseCookiesFn,       // (req) => cookies object
    getActiveSessionFn,   // (userId) => EmulatorSession (của server.js) - dùng để share frames
    rootConfigPath,       // path tới config.json để reload khi update perGame
    onConfigUpdate,       // callback khi perGame thay đổi (server.js có thể reload)
    sharpLib,             // sharp module (optional)
  } = deps;

  if (!CONFIG.bridge || !CONFIG.bridge.enabled) {
    console.log('[fj2me-bridge] disabled in config.json');
    return null;
  }

  const BRIDGE_CONFIG = CONFIG.bridge;
  // Tạo bridge store (JSON hoặc MySQL).
  let store;
  if (BRIDGE_CONFIG.mysql && BRIDGE_CONFIG.mysql.enabled && mysqlPool) {
    store = new MysqlBridgeStore(BRIDGE_CONFIG.mysql);
    store.init().then(() => console.log('[fj2me-bridge] MySQL store ready'))
      .catch((e) => console.warn('[fj2me-bridge] MySQL init failed:', e.message));
  } else {
    const dbDir = (BRIDGE_CONFIG.gamesDir && path.dirname(BRIDGE_CONFIG.gamesDir)) || path.join(__dirname, 'freej2me_data');
    store = new BridgeStore({
      dbPath: path.join(dbDir, 'bridge.json'),
    });
    console.log('[fj2me-bridge] JSON store at', path.join(dbDir, 'bridge.json'));
  }

  // Games directory: lưu JAR được đẩy từ freej2me-web.
  const gamesDir = BRIDGE_CONFIG.gamesDir || path.join(__dirname, 'freej2me_data', 'bridge_games');
  if (!fs.existsSync(gamesDir)) fs.mkdirSync(gamesDir, { recursive: true });
  const gameDir = (gameId) => path.join(gamesDir, safeName(gameId));
  const ensureGameDir = (gameId) => { const d = gameDir(gameId); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); return d; };

  // Cache các bridge session đang chạy.
  const liveSessions = new Map(); // gameId -> BridgeEmulatorSession
  const liveByClient = new WeakMap(); // ws -> BridgeEmulatorSession

  // CORS cho freej2me-web nếu cấu hình.
  if (BRIDGE_CONFIG.corsOrigins && BRIDGE_CONFIG.corsOrigins.length) {
    app.use('/bridge/', (req, res, next) => {
      const origin = req.headers.origin || '';
      if (BRIDGE_CONFIG.corsOrigins.includes('*') || BRIDGE_CONFIG.corsOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Bridge-Secret');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      }
      if (req.method === 'OPTIONS') return res.status(204).end();
      next();
    });
  }

  // Verify shared secret nếu có.
  function verifySecret(req) {
    if (!BRIDGE_CONFIG.sharedSecret) return true;
    const hdr = req.headers['x-bridge-secret'] || req.query.secret;
    return String(hdr || '') === String(BRIDGE_CONFIG.sharedSecret);
  }

  // Body parsing đã có sẵn trong server.js (express.json), không cần add thêm.

  // =================================================================
  // ROUTE: POST /bridge/fj2meweb/push-game
  // freej2me-web client upload JAR (base64 hoặc multipart) + settings.
  // Trả về { success, data: { gameId, appId, name, settings, streamUrl } }.
  // =================================================================
  app.post('/bridge/fj2meweb/push-game', async (req, res) => {
    try {
      if (!verifySecret(req)) return phpResponse(res, false, null, 'unauthorized', 401);
      const body = req.body || {};
      const jarB64 = body.jarBase64 || body.jar || null;
      const jarBuf = jarB64 ? b64ToBuf(jarB64) : (body.jarPath ? fs.readFileSync(body.jarPath) : null);
      if (!jarBuf || jarBuf.length < 32) return phpResponse(res, false, null, 'jar missing or too small');

      // Xác định appId: ưu tiên client gửi, fallback từ settings.appId hoặc tên file.
      const appId = safeName(body.appId || (body.settings && body.settings.appId) || 'unknown');
      const gameId = sha1Buf(jarBuf).slice(0, 16);
      const d = ensureGameDir(gameId);
      const jarPath = path.join(d, 'game.jar');
      fs.writeFileSync(jarPath, jarBuf);

      // Merge config: perGame (từ config.json) + client settings (từ CheerpJ).
      const effective = resolveGameConfig({
        gameId, appId,
        clientSettings: body.settings || {},
        rootConfig: CONFIG,
      });

      // Lưu registry.
      await _safeStoreCall(store, 'registerGame', gameId, {
        appId, name: body.name || appId, jarSha1: sha1Buf(jarBuf),
        jarSize: jarBuf.length, createdAt: nowMs(), lastLaunch: nowMs(),
        launchCount: 0, jarPath,
      });
      await _safeStoreCall(store, 'setConfig', gameId, effective);

      const streamUrl = _buildStreamUrl(req, gameId);
      return phpResponse(res, true, {
        gameId, appId, name: body.name || appId, jarPath: jarPath, jarSha1: sha1Buf(jarBuf),
        settings: effective, streamUrl,
      });
    } catch (e) {
      return phpResponse(res, false, null, e.message, 500);
    }
  });

  // =================================================================
  // ROUTE: GET /bridge/fj2meweb/list
  // =================================================================
  app.get('/bridge/fj2meweb/list', async (req, res) => {
    try {
      if (!verifySecret(req)) return phpResponse(res, false, null, 'unauthorized', 401);
      const games = await _safeStoreCall(store, 'listGames') || [];
      return phpResponse(res, true, { games });
    } catch (e) { return phpResponse(res, false, null, e.message, 500); }
  });

  // =================================================================
  // ROUTE: GET /bridge/fj2meweb/launch/:gameId
  // Khởi động emulator cho game. Trả về streamUrl + session info.
  // =================================================================
  app.get('/bridge/fj2meweb/launch/:gameId', async (req, res) => {
    try {
      if (!verifySecret(req)) return phpResponse(res, false, null, 'unauthorized', 401);
      const gameId = safeName(req.params.gameId);
      const game = await _safeStoreCall(store, 'getGame', gameId);
      if (!game) return phpResponse(res, false, null, 'game not found', 404);

      let sess = liveSessions.get(gameId);
      if (!sess) {
        const cfg = await _safeStoreCall(store, 'getConfig', gameId) || {};
        const javaPath = CONFIG.javaPath;
        const jar = CONFIG.freej2meJar;
        if (!fs.existsSync(game.jarPath)) return phpResponse(res, false, null, 'jar file missing on disk: ' + game.jarPath, 410);
        sess = new BridgeEmulatorSession({
          gameId, appId: game.appId, jarPath: game.jarPath, javaPath, freej2meJar: jar,
          config: cfg,
          onFrame: (rgb24, w, h) => {
            // Lấy codec theo effective config.
            const codec = cfg.videoCodec || (cfg.imageQuality >= 90 ? 'rgba' : cfg.imageQuality >= 45 ? 'rgb565' : 'rgb332');
            const scale = cfg.streamScale || 1;
            const buf = rgb24ToBridgeBuffer(rgb24, w, h, codec, scale, sharpLib);
            sess.broadcastFrame(buf);
            // Broadcast cả config update nếu dimensions thay đổi.
            if (sess._lastW !== w || sess._lastH !== h) {
              sess._lastW = w; sess._lastH = h;
              sess.broadcastJson({ type: 'config', width: Math.floor(w / scale), height: Math.floor(h / scale), codec, scale });
            }
          },
          onAudio: (kind, payload, fmt) => {
            if (kind === 'format') {
              sess.broadcastJson({ type: 'audio-format', format: fmt, codec: cfg.audioCodec || 'pcm' });
            } else if (kind === 'pcm') {
              const header = Buffer.allocUnsafe(9);
              header.write('FJ2A', 0, 4, 'ascii'); header[4] = 2;
              header.writeUInt32BE(payload.length, 5);
              sess.broadcastFrame(Buffer.concat([header, payload]));
            }
          },
          onLog: (line) => console.log('[bridge:' + gameId + ']', line),
          onStatus: (state) => {
            sess.broadcastJson({ type: 'status', state, gameId });
            if (state === 'exited' || state === 'error') {
              liveSessions.delete(gameId);
            }
          },
        });
        liveSessions.set(gameId, sess);
        // Tăng launch count.
        await _safeStoreCall(store, 'registerGame', gameId, Object.assign({}, game, {
          lastLaunch: nowMs(), launchCount: (game.launchCount || 0) + 1,
        }));
        sess.start().catch((e) => console.error('[bridge:' + gameId + '] start failed:', e));
      }
      return phpResponse(res, true, {
        gameId, appId: game.appId, name: game.name, sessionId: sess._sid || (sess._sid = randomId('bs_')),
        streamUrl: _buildStreamUrl(req, gameId),
        settings: await _safeStoreCall(store, 'getConfig', gameId) || {},
        status: sess.isRunning ? 'running' : 'starting',
      });
    } catch (e) { return phpResponse(res, false, null, e.message, 500); }
  });

  // =================================================================
  // ROUTE: GET /bridge/fj2meweb/settings/:gameId
  // POST /bridge/fj2meweb/settings/:gameId  (update)
  // =================================================================
  app.get('/bridge/fj2meweb/settings/:gameId', async (req, res) => {
    try {
      if (!verifySecret(req)) return phpResponse(res, false, null, 'unauthorized', 401);
      const gameId = safeName(req.params.gameId);
      const cfg = await _safeStoreCall(store, 'getConfig', gameId) || {};
      return phpResponse(res, true, { gameId, settings: cfg });
    } catch (e) { return phpResponse(res, false, null, e.message, 500); }
  });
  app.post('/bridge/fj2meweb/settings/:gameId', async (req, res) => {
    try {
      if (!verifySecret(req)) return phpResponse(res, false, null, 'unauthorized', 401);
      const gameId = safeName(req.params.gameId);
      const cur = await _safeStoreCall(store, 'getConfig', gameId) || {};
      const merged = Object.assign({}, cur, req.body || {});
      await _safeStoreCall(store, 'setConfig', gameId, merged);
      // Nếu game đang chạy, restart để áp dụng config mới.
      const sess = liveSessions.get(gameId);
      if (sess) { sess.stop(); liveSessions.delete(gameId); }
      return phpResponse(res, true, { gameId, settings: merged, restartTriggered: !!sess });
    } catch (e) { return phpResponse(res, false, null, e.message, 500); }
  });

  // =================================================================
  // ROUTE: GET /bridge/fj2meweb/compat/:gameId
  // Gợi ý client có nên dùng bridge không.
  // =================================================================
  app.get('/bridge/fj2meweb/compat/:gameId', async (req, res) => {
    try {
      if (!verifySecret(req)) return phpResponse(res, false, null, 'unauthorized', 401);
      const gameId = safeName(req.params.gameId);
      const game = await _safeStoreCall(store, 'getGame', gameId);
      const hint = suggestBridge(game || {});
      return phpResponse(res, true, { gameId, ...hint });
    } catch (e) { return phpResponse(res, false, null, e.message, 500); }
  });

  // =================================================================
  // ROUTE: DELETE /bridge/fj2meweb/game/:gameId
  // Xoá game khỏi registry + xoá JAR.
  // =================================================================
  app.delete('/bridge/fj2meweb/game/:gameId', async (req, res) => {
    try {
      if (!verifySecret(req)) return phpResponse(res, false, null, 'unauthorized', 401);
      const gameId = safeName(req.params.gameId);
      const sess = liveSessions.get(gameId);
      if (sess) { sess.stop(); liveSessions.delete(gameId); }
      await _safeStoreCall(store, 'deleteGame', gameId);
      const d = gameDir(gameId);
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {}
      return phpResponse(res, true, { gameId, deleted: true });
    } catch (e) { return phpResponse(res, false, null, e.message, 500); }
  });

  // =================================================================
  // ROUTE: PHP-style API endpoint (tương thích web hosting).
  // POST /bridge/api  body: { action: 'launch'|'list'|'settings', ... }
  // =================================================================
  if (BRIDGE_CONFIG.phpApiEnabled) {
    const phpPath = BRIDGE_CONFIG.phpApiPath || '/bridge/api';
    app.post(phpPath, async (req, res) => {
      try {
        const action = (req.body && req.body.action) || (req.query && req.query.action);
        const cookies = parseCookiesFn ? parseCookiesFn(req) : parsePhpSessionFromRequest(req);
        // Tương thích PHPSESSID: nếu có thì attach vào req để downstream có thể dùng.
        if (BRIDGE_CONFIG.phpCompat && BRIDGE_CONFIG.phpCompat.acceptPhpSessionCookie) {
          const sid = cookies[BRIDGE_CONFIG.phpCompat.phpSessionCookieName || 'PHPSESSID'];
          req._phpSessionId = sid || null;
        }
        // Auth (nếu có user).
        const user = requireUserFn ? requireUserFn(req, null) : null;
        switch (action) {
          case 'ping':
            return phpResponse(res, true, { pong: true, bridgeVersion: '1.0.0', mysqlEnabled: !!(BRIDGE_CONFIG.mysql && BRIDGE_CONFIG.mysql.enabled) });
          case 'list': {
            const games = await _safeStoreCall(store, 'listGames') || [];
            return phpResponse(res, true, { games, count: games.length });
          }
          case 'get': {
            const gameId = safeName((req.body && req.body.gameId) || (req.query && req.query.gameId));
            if (!gameId) return phpResponse(res, false, null, 'missing gameId');
            const g = await _safeStoreCall(store, 'getGame', gameId);
            return g ? phpResponse(res, true, g) : phpResponse(res, false, null, 'not found', 404);
          }
          case 'launch': {
            const gameId = safeName((req.body && req.body.gameId) || (req.query && req.query.gameId));
            if (!gameId) return phpResponse(res, false, null, 'missing gameId');
            const g = await _safeStoreCall(store, 'getGame', gameId);
            if (!g) return phpResponse(res, false, null, 'not found', 404);
            let sess = liveSessions.get(gameId);
            if (!sess) {
              const cfg = await _safeStoreCall(store, 'getConfig', gameId) || {};
              sess = new BridgeEmulatorSession({
                gameId, appId: g.appId, jarPath: g.jarPath, javaPath: CONFIG.javaPath,
                freej2meJar: CONFIG.freej2meJar, config: cfg,
                onFrame: (rgb24, w, h) => {
                  const codec = cfg.videoCodec || 'rgba';
                  sess.broadcastFrame(rgb24ToBridgeBuffer(rgb24, w, h, codec, cfg.streamScale || 1, sharpLib));
                },
                onAudio: (kind, payload) => {
                  if (kind === 'pcm') {
                    const h = Buffer.allocUnsafe(9); h.write('FJ2A', 0, 4, 'ascii'); h[4] = 2; h.writeUInt32BE(payload.length, 5);
                    sess.broadcastFrame(Buffer.concat([h, payload]));
                  }
                },
                onLog: (l) => console.log('[php-api:bridge]', l),
                onStatus: (s) => { if (s === 'exited') liveSessions.delete(gameId); },
              });
              liveSessions.set(gameId, sess);
              sess.start().catch((e) => console.error('[php-api:bridge]', e));
            }
            return phpResponse(res, true, { gameId, status: 'launching', streamUrl: _buildStreamUrl(req, gameId) });
          }
          case 'delete': {
            const gameId = safeName((req.body && req.body.gameId));
            const sess = liveSessions.get(gameId);
            if (sess) { sess.stop(); liveSessions.delete(gameId); }
            await _safeStoreCall(store, 'deleteGame', gameId);
            return phpResponse(res, true, { gameId, deleted: true });
          }
          default:
            return phpResponse(res, false, null, 'unknown action: ' + action, 400);
        }
      } catch (e) { return phpResponse(res, false, null, e.message, 500); }
    });
  }

  // =================================================================
  // WebSocket endpoint: /bridge/fj2meweb/stream/:gameId
  // Server -> client: binary frames (RGB) hoặc FJ2A audio.
  // Client -> server: JSON { type: 'key'|'touch'|'ping', ... }.
  // =================================================================
  if (wss && WebSocket) {
    wss.on('connection', (ws, req) => {
      // Phân biệt URL /bridge/fj2meweb/stream/:gameId.
      const url = req.url || '';
      const m = url.match(/^\/bridge\/fj2meweb\/stream\/([A-Za-z0-9_.-]+)(?:\?|$)/);
      if (!m) return; // không phải route của bridge - để wss gốc xử lý.
      const gameId = safeName(m[1]);
      // Auth: cần user (nếu server.js yêu cầu) hoặc chỉ secret.
      const user = requireUserFn ? requireUserFn(req, null) : null;
      // Verify secret nếu cấu hình.
      const cookies = parseCookiesFn ? parseCookiesFn(req) : parsePhpSessionFromRequest(req);
      const secretOk = !BRIDGE_CONFIG.sharedSecret || String(req.headers['x-bridge-secret'] || '') === BRIDGE_CONFIG.sharedSecret;
      if (!secretOk) { try { ws.close(4001, 'unauthorized'); } catch (e) {} return; }
      if (CONFIG.requireLogin && !user) { try { ws.close(4001, 'not logged in'); } catch (e) {} return; }

      let sess = liveSessions.get(gameId);
      // Lazy-start nếu game đã registered nhưng chưa chạy.
      if (!sess) {
        _safeStoreCall(store, 'getGame', gameId).then((g) => {
          if (!g) { try { ws.close(4004, 'game not found'); } catch (e) {} return; }
          _safeStoreCall(store, 'getConfig', gameId).then((cfg) => {
            const s = new BridgeEmulatorSession({
              gameId, appId: g.appId, jarPath: g.jarPath, javaPath: CONFIG.javaPath,
              freej2meJar: CONFIG.freej2meJar, config: cfg || {},
              onFrame: (rgb24, w, h) => {
                const codec = (cfg && cfg.videoCodec) || 'rgba';
                s.broadcastFrame(rgb24ToBridgeBuffer(rgb24, w, h, codec, (cfg && cfg.streamScale) || 1, sharpLib));
              },
              onAudio: (kind, payload, fmt) => {
                if (kind === 'format') s.broadcastJson({ type: 'audio-format', format: fmt });
                else if (kind === 'pcm') {
                  const h = Buffer.allocUnsafe(9); h.write('FJ2A', 0, 4, 'ascii'); h[4] = 2;
                  h.writeUInt32BE(payload.length, 5);
                  s.broadcastFrame(Buffer.concat([h, payload]));
                }
              },
              onLog: (l) => console.log('[bridge-ws:' + gameId + ']', l),
              onStatus: (st) => { if (st === 'exited') liveSessions.delete(gameId); },
            });
            liveSessions.set(gameId, s);
            s.attachClient(ws); liveByClient.set(ws, s);
            s.start().catch((e) => console.error('[bridge-ws:' + gameId + ']', e));
          });
        });
        return;
      }
      sess.attachClient(ws); liveByClient.set(ws, sess);
      try { ws.send(JSON.stringify({ type: 'hello', gameId, appId: sess.appId })); } catch (e) {}
      ws.on('message', (msg) => {
        try {
          const data = JSON.parse(msg.toString());
          const s = liveByClient.get(ws) || sess;
          if (!s || !s.isRunning) return;
          if (data.type === 'key') {
            s.sendKey(data.key | 0, data.state === 'D' ? 'D' : 'U');
          } else if (data.type === 'touch') {
            const cmd = data.state === 'D' ? 5 : data.state === 'U' ? 4 : data.state === 'M' ? 6 : 0;
            if (cmd) s.sendMouse(cmd, data.x | 0, data.y | 0);
          } else if (data.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
          }
        } catch (e) { /* ignore */ }
      });
      ws.on('close', () => {
        const s = liveByClient.get(ws);
        if (s) s.detachClient(ws);
      });
    });
  }

  // =================================================================
  // Auto-cleanup: xoá bridge game quá hạn keepUploadsDays.
  // =================================================================
  const keepMs = (BRIDGE_CONFIG.keepUploadsDays || 30) * 24 * 3600 * 1000;
  setInterval(() => {
    try {
      const cutoff = nowMs() - keepMs;
      for (const [gameId, game] of Object.entries(((store && store.data && store.data.bridgeGames) || {}))) {
        const lastTouch = Math.max(game.lastLaunch || 0, game.createdAt || 0);
        if (lastTouch < cutoff) {
          const d = gameDir(gameId);
          try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {}
        }
      }
    } catch (e) { /* ignore */ }
  }, 6 * 3600 * 1000);

  // =================================================================
  // Helpers
  // =================================================================
  function _buildStreamUrl(req, gameId) {
    if (BRIDGE_CONFIG.publicUrl) return BRIDGE_CONFIG.publicUrl.replace(/\/$/, '') + '/bridge/fj2meweb/stream/' + gameId;
    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const host = req.headers['x-forwarded-host'] || req.headers.host || ('localhost:' + CONFIG.port);
    return proto + '://' + host + '/bridge/fj2meweb/stream/' + gameId;
  }
  async function _safeStoreCall(storeObj, method, ...args) {
    try {
      const fn = storeObj[method];
      if (!fn) return null;
      const r = fn.apply(storeObj, args);
      return r && typeof r.then === 'function' ? await r : r;
    } catch (e) {
      console.warn('[fj2me-bridge] store.' + method + ' failed:', e.message);
      return null;
    }
  }

  console.log('[fj2me-bridge] mounted at /bridge/fj2meweb/... and ' + (BRIDGE_CONFIG.phpApiPath || '/bridge/api'));
  return {
    store, liveSessions, gameDir, gamesDir,
    resolveGameConfig: (opts) => resolveGameConfig(Object.assign({ rootConfig: CONFIG }, opts)),
  };
}

module.exports = {
  mountBridge,
  BridgeStore, MysqlBridgeStore, BridgeEmulatorSession,
  resolveGameConfig, suggestBridge, parseCheerpjConf,
  rgb24ToBridgeBuffer, SimpleStreamReader, buildBridgeEmulatorArgs,
  phpResponse, parsePhpSessionFromRequest,
};
