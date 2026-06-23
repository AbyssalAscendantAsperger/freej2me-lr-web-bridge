/******************************************************************************
 * FreeJ2ME-Web Bridge Client - nhúng vào freej2me-web (CheerpJ)
 *
 * File này được include vào freej2me-web để:
 *  1) Trong launcher (index.html): thêm nút "Run on Node.js Bridge" cho mỗi
 *     game. Khi ấn, JAR + settings được đẩy sang Node.js bridge qua API,
 *     sau đó redirect sang run.html?app=<appId>&bridge=1&gameId=<gameId>.
 *  2) Trong run.html: nếu URL có ?bridge=1, file này sẽ chặn CheerpJ, kết nối
 *     WebSocket với Node.js bridge, vẽ frames nhận được lên canvas#display (cùng
 *     canvas mà CheerpJ dùng), forward keyboard/touch events sang Node.js.
 *
 * Tích hợp vào freej2me-web:
 *  - Trong index.html: thêm <script src=".../fj2me-web-bridge-client.js"></script>
 *    TRƯỚC <script type="module" src="src/launcher.js"></script>.
 *  - Trong run.html: thêm <script src=".../fj2me-web-bridge-client.js"></script>
 *    TRƯỚC <script type="module" src="src/main.js"></script>.
 *
 * Hoặc dùng tools/integrate-fj2me-web.js để tự động patch.
 *
 * Không cần CheerpJ chạy game - chỉ cần Node.js bridge đang chạy.
 *****************************************************************************/

(function () {
  'use strict';

  // Bridge config - override được qua window.FJ2ME_BRIDGE_CONFIG.
  const CFG = Object.assign({
    enabled: true,
    autoDetectBridgeParam: true,
    bridgeParamName: 'bridge',
    gameIdParamName: 'gameId',
    appIdParamName: 'app',
    bridgeServerUrl: '',           // để trống → dùng window.location.origin
    bridgeApiPrefix: '/bridge/fj2meweb',
    bridgePhpApiPath: '/bridge/api',
    secretHeader: 'X-Bridge-Secret',
    secretValue: '',                // nếu server có bridge.sharedSecret thì điền vào
    autoFallbackToCheerpj: false,   // nếu true, ws fail thì load CheerpJ
    logPrefix: '[fj2me-web-bridge-client]',
  }, window.FJ2ME_BRIDGE_CONFIG || {});

  // =================================================================
  // Utilities
  // =================================================================
  function log() { try { console.log.apply(console, [CFG.logPrefix].concat(Array.prototype.slice.call(arguments))); } catch (e) {} }
  function warn() { try { console.warn.apply(console, [CFG.logPrefix].concat(Array.prototype.slice.call(arguments))); } catch (e) {} }

  function apiBase() {
    return (CFG.bridgeServerUrl || (typeof location !== 'undefined' ? location.origin : '')) + CFG.bridgeApiPrefix;
  }

  async function bridgeFetch(path, body, method) {
    method = method || (body ? 'POST' : 'GET');
    const url = (CFG.bridgeServerUrl || (typeof location !== 'undefined' ? location.origin : '')) + path;
    const headers = { 'Content-Type': 'application/json' };
    if (CFG.secretValue) headers[CFG.secretHeader] = CFG.secretValue;
    const init = { method, headers, credentials: 'include' };
    if (body) init.body = JSON.stringify(body);
    const r = await fetch(url, init);
    const txt = await r.text();
    let j = null;
    try { j = txt ? JSON.parse(txt) : null; } catch (e) { j = { success: false, error: 'invalid_json: ' + txt.slice(0, 120) }; }
    if (!r.ok && !(j && j.success === false)) j = { success: false, error: 'HTTP ' + r.status };
    return j;
  }

  function getQueryParam(name) {
    try { return new URLSearchParams(location.search).get(name); } catch (e) { return null; }
  }

  // =================================================================
  // CheerpJ file helpers - đọc file từ /files/ (CheerpJ virtual FS).
  // Trong freej2me-web, mỗi app có:
  //   /files/<appId>/app.jar
  //   /files/<appId>/name
  //   /files/<appId>/icon
  //   /files/<appId>/config/settings.conf
  //   /files/<appId>/config/appproperties.conf
  //   /files/<appId>/config/systemproperties.conf
  // =================================================================
  async function readCheerpjFileBlob(path) {
    try {
      if (typeof cjFileBlob === 'function') {
        return await cjFileBlob(path);
      }
    } catch (e) {}
    return null;
  }

  async function readCheerpjFileText(path) {
    const b = await readCheerpjFileBlob(path);
    if (!b) return null;
    try { return await b.text(); } catch (e) { return null; }
  }

  function parseConf(text) {
    const out = {};
    if (!text) return out;
    String(text).split(/\r?\n/).forEach(function (line) {
      const m = line.match(/^\s*([^:]+?)\s*:\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2];
    });
    return out;
  }

  function confToString(kv) {
    return Object.keys(kv).map(function (k) { return k + ': ' + kv[k]; }).join('\n');
  }

  async function buildPushPayloadFromCheerpj(appId) {
    const jarBlob = await readCheerpjFileBlob('/files/' + appId + '/app.jar');
    if (!jarBlob) throw new Error('Không tìm thấy JAR của app ' + appId + ' trong CheerpJ /files/');
    const jarBuf = new Uint8Array(await jarBlob.arrayBuffer());
    let jarB64 = '';
    try {
      let bin = '';
      const chunk = 0x8000;
      for (let i = 0; i < jarBuf.length; i += chunk) {
        bin += String.fromCharCode.apply(null, jarBuf.subarray(i, i + chunk));
      }
      jarB64 = btoa(bin);
    } catch (e) { throw new Error('Không base64 được JAR: ' + e.message); }

    const settingsText = await readCheerpjFileText('/files/' + appId + '/config/settings.conf');
    const appPropsText = await readCheerpjFileText('/files/' + appId + '/config/appproperties.conf');
    const sysPropsText = await readCheerpjFileText('/files/' + appId + '/config/systemproperties.conf');
    const name = await readCheerpjFileText('/files/' + appId + '/name');
    const settings = parseConf(settingsText);
    const appProperties = parseConf(appPropsText);
    const systemProperties = parseConf(sysPropsText);

    return {
      appId, name: name || appId,
      jarBase64: jarB64,
      settings: settings,            // freej2me-web dùng: phone, width, height, fontSize, dgFormat, sound, rotate, ...
      appProperties, systemProperties,
    };
  }

  // =================================================================
  // Convert freej2me-web settings -> bridge config keys.
  // freej2me-web (Config.DEFAULT_SETTINGS) dùng 'phone', 'width', 'height';
  // bridge dùng 'phoneType' (int). Convert ở đây.
  // =================================================================
  function normalizeSettingsForBridge(s) {
    const out = Object.assign({}, s);
    if (out.phone !== undefined && out.phoneType === undefined) {
      const map = { Standard: 0, Nokia: 1, Motorola: 2, Siemens: 3, SonyEricsson: 4 };
      out.phoneType = typeof out.phone === 'string' ? (map[out.phone] ?? 0) : (out.phone | 0);
    }
    if (typeof out.fps !== 'number') {
      const map = { 0: 60, 1: 30, 2: 15, 3: 10 };
      out.fps = map[out.fps] || 60;
    }
    if (typeof out.maxFps !== 'number') out.maxFps = out.fps;
    if (out.sound === 'on') out.sound = 1; else if (out.sound === 'off') out.sound = 0;
    if (out.rotate === 'on') out.rotate = 1; else if (out.rotate === 'off') out.rotate = 0;
    if (typeof out.width === 'string') out.width = parseInt(out.width, 10) || 240;
    if (typeof out.height === 'string') out.height = parseInt(out.height, 10) || 320;
    return out;
  }

  // =================================================================
  // Push game từ CheerpJ sang Node.js bridge.
  // =================================================================
  async function pushGameToBridge(appId) {
    const payload = await buildPushPayloadFromCheerpj(appId);
    payload.settings = normalizeSettingsForBridge(payload.settings || {});
    payload.appProperties = payload.appProperties || {};
    payload.systemProperties = payload.systemProperties || {};
    const resp = await bridgeFetch(CFG.bridgeApiPrefix + '/push-game', payload, 'POST');
    if (!resp || !resp.success) throw new Error('Bridge push-game failed: ' + (resp && resp.error || 'unknown'));
    return resp.data;
  }

  // =================================================================
  // LAUNCHER INTEGRATION: thêm nút "Run on Node.js Bridge" cho mỗi game.
  // Hook vào launcher.js bằng cách override fillGamesList qua MutationObserver.
  // =================================================================
  function injectLauncherBridgeButtons() {
    if (typeof document === 'undefined') return;
    const gameList = document.getElementById('game-list');
    if (!gameList) return;
    const addButtons = () => {
      const items = gameList.querySelectorAll('.game-item');
      items.forEach((item) => {
        if (item.querySelector('.fj2me-bridge-btn')) return; // đã có
        const link = item.querySelector('a[href^="run?app="]');
        if (!link) return;
        const m = (link.getAttribute('href') || '').match(/app=([^&]+)/);
        if (!m) return;
        const appId = decodeURIComponent(m[1]);
        const btn = document.createElement('button');
        btn.className = 'fj2me-bridge-btn';
        btn.textContent = '☁ Bridge';
        btn.title = 'Chạy game này trên Node.js server bridge (tương thích cao hơn CheerpJ WASM)';
        btn.style.cssText = 'background:#1f6feb;color:#fff;border:none;border-radius:4px;padding:5px 10px;margin-left:4px;cursor:pointer;font-weight:600;';
        btn.onclick = async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          btn.disabled = true;
          btn.textContent = '⏳ pushing...';
          try {
            const data = await pushGameToBridge(appId);
            log('push-game OK', data);
            // Redirect sang run.html với bridge=1.
            const runUrl = 'run?app=' + encodeURIComponent(appId) + '&' + CFG.bridgeParamName + '=1&' + CFG.gameIdParamName + '=' + encodeURIComponent(data.gameId);
            location.href = runUrl;
          } catch (e) {
            warn('push-game failed:', e.message);
            btn.disabled = false;
            btn.textContent = '☁ Bridge';
            alert('Bridge push failed: ' + e.message);
          }
        };
        // Chèn nút trước nút "Manage" nếu có, hoặc cuối item.
        const manageBtn = item.querySelector('button');
        if (manageBtn && manageBtn !== btn) item.insertBefore(btn, manageBtn);
        else item.appendChild(btn);
      });
    };
    addButtons();
    // Theo dõi DOM thay đổi (launcher reload games list).
    const obs = new MutationObserver(() => addButtons());
    obs.observe(gameList, { childList: true, subtree: true });
  }

  // =================================================================
  // RUN.HTML INTEGRATION: thay CheerpJ rendering bằng bridge stream.
  // Khi ?bridge=1, hook canvas#display và forward events qua WebSocket.
  // =================================================================
  class BridgeStreamClient {
    constructor(opts) {
      this.gameId = opts.gameId;
      this.appId = opts.appId;
      this.ws = null;
      this.canvas = null;
      this.ctx = null;
      this.screenWidth = 0;
      this.screenHeight = 0;
      this.videoCodec = 'rgba';
      this.imageQuality = 100;
      this.audioCtx = null;
      this.audioNextTime = 0;
      this.audioFormat = { sampleRate: 48000, channels: 2, bits: 16, signed: true, bigEndian: false };
      this.audioMuted = false;
      this.audioUnlocked = false;
      this.opusAudioUrl = null;
      this.opusAudioEl = null;
      this.wsReconnectTimer = null;
      this.shouldRun = true;
      this.latestFrame = null;
      this.rafPending = false;
      this.fpsCount = 0;
      this.lastFpsTime = 0;
      this.fpsEl = null;
      this.reusableImageData = null;
      this.onConfig = opts.onConfig || (() => {});
    }

    async start() {
      this._setupCanvas();
      this._setupAudioUnlock();
      this._setupEventForwarding();
      this._connect();
    }

    _setupCanvas() {
      this.canvas = document.getElementById('display');
      if (!this.canvas) {
        warn('Không tìm thấy canvas#display - bridge sẽ không vẽ được.');
        return;
      }
      this.ctx = this.canvas.getContext('2d');
      // FPS counter (tận dụng #fps nếu launcher tạo).
      this.fpsEl = document.getElementById('fps') || (() => {
        const el = document.createElement('div');
        el.id = 'fps';
        el.style.cssText = 'position:fixed;bottom:8px;right:8px;background:rgba(0,0,0,.5);color:#fff;padding:3px 8px;border-radius:6px;font:12px monospace;z-index:9999;';
        document.body.appendChild(el);
        return el;
      })();
      // Ẩn loading text.
      const loading = document.getElementById('loading');
      if (loading) loading.style.display = 'none';
      this.canvas.style.display = '';
      this.canvas.focus();
    }

    _setupAudioUnlock() {
      const onFirstClick = () => {
        if (this.audioUnlocked) return;
        try {
          this.audioCtx = this.audioCtx || new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
          this.audioCtx.resume();
          this.audioUnlocked = true;
          log('Audio context unlocked');
        } catch (e) { warn('Cannot unlock audio:', e.message); }
        document.removeEventListener('pointerdown', onFirstClick);
        document.removeEventListener('keydown', onFirstClick);
      };
      document.addEventListener('pointerdown', onFirstClick);
      document.addEventListener('keydown', onFirstClick);
    }

    _setupEventForwarding() {
      // Keyboard mapping giống freej2me-web codeMap trong main.js.
      const codeMap = {
        'F1': 9, 'Q': 9, 'Digit1': 10, 'Numpad1': 10, 'Digit2': 14, 'Numpad2': 14,
        'Digit3': 11, 'Numpad3': 11, 'Digit4': 15, 'Numpad4': 15, 'Digit5': 18, 'Numpad5': 18,
        'Digit6': 16, 'Numpad6': 16, 'Digit7': 5, 'Numpad7': 5, 'Digit8': 17, 'Numpad8': 17,
        'Digit9': 4, 'Numpad9': 4, 'Digit0': 6, 'Numpad0': 6, 'NumpadMultiply': 12, 'NumpadDivide': 13,
        'ArrowUp': 0, 'ArrowDown': 1, 'ArrowLeft': 2, 'ArrowRight': 3,
        'Enter': 7, 'NumpadEnter': 7, ' ': 7, 'Escape': 19, 'Backspace': 19,
        'F2': 8, 'W': 8, 'E': 12, 'R': 13, 'Z': 12, 'X': 13,
      };
      const isInput = (e) => {
        const t = e.target;
        if (!t) return false;
        const tag = (t.tagName || '').toLowerCase();
        return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
      };
      const send = (type, payload) => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        try { this.ws.send(JSON.stringify(Object.assign({ type: type }, payload || {}))); } catch (e) {}
      };
      document.addEventListener('keydown', (e) => {
        if (isInput(e)) return;
        const keyIndex = codeMap[e.code] || codeMap[e.key];
        if (keyIndex === undefined) return;
        send('key', { key: keyIndex, state: 'D' });
        // KHÔNG preventDefault để F12, F5 vẫn hoạt động bình thường.
      });
      document.addEventListener('keyup', (e) => {
        if (isInput(e)) return;
        const keyIndex = codeMap[e.code] || codeMap[e.key];
        if (keyIndex === undefined) return;
        send('key', { key: keyIndex, state: 'U' });
      });

      // Touch / mouse - giống freej2me-web handler nhưng scale về emu resolution.
      let down = false;
      const xy = (e) => {
        const r = this.canvas.getBoundingClientRect();
        const sx = (this.canvas.clientWidth || this.screenWidth) / r.width;
        const sy = (this.canvas.clientHeight || this.screenHeight) / r.height;
        return {
          x: Math.max(0, Math.min(this.screenWidth - 1, Math.floor(((e.clientX || (e.touches && e.touches[0] && e.touches[0].clientX) || 0) - r.left) * sx))),
          y: Math.max(0, Math.min(this.screenHeight - 1, Math.floor(((e.clientY || (e.touches && e.touches[0] && e.touches[0].clientY) || 0) - r.top) * sy))),
        };
      };
      this.canvas.addEventListener('mousedown', (e) => { const p = xy(e); down = true; send('touch', { state: 'D', x: p.x, y: p.y }); e.preventDefault(); });
      this.canvas.addEventListener('mousemove', (e) => { if (!down) return; const p = xy(e); send('touch', { state: 'M', x: p.x, y: p.y }); });
      this.canvas.addEventListener('mouseup', (e) => { down = false; const p = xy(e); send('touch', { state: 'U', x: p.x, y: p.y }); });
      this.canvas.addEventListener('touchstart', (e) => { const p = xy(e); down = true; send('touch', { state: 'D', x: p.x, y: p.y }); e.preventDefault(); }, { passive: false });
      this.canvas.addEventListener('touchmove', (e) => { const p = xy(e); send('touch', { state: 'M', x: p.x, y: p.y }); e.preventDefault(); }, { passive: false });
      this.canvas.addEventListener('touchend', (e) => { down = false; const p = xy(e); send('touch', { state: 'U', x: p.x, y: p.y }); e.preventDefault(); }, { passive: false });
    }

    _connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const host = CFG.bridgeServerUrl || (location.host || 'localhost');
      const wsUrl = (CFG.bridgeServerUrl ? CFG.bridgeServerUrl.replace(/^http/, 'ws') : (proto + '://' + host))
        + CFG.bridgeApiPrefix + '/stream/' + encodeURIComponent(this.gameId);
      log('Connecting WS:', wsUrl);
      try {
        this.ws = new WebSocket(wsUrl);
      } catch (e) { warn('WebSocket construction failed:', e.message); this._scheduleReconnect(); return; }
      this.ws.binaryType = 'arraybuffer';
      this.ws.onopen = () => { log('WS open'); this._sendPingLoop(); };
      this.ws.onmessage = (ev) => this._onMessage(ev);
      this.ws.onclose = (ev) => { log('WS close', ev.code, ev.reason); this._scheduleReconnect(); };
      this.ws.onerror = (e) => { warn('WS error:', e && e.message); };
    }

    _sendPingLoop() {
      const ping = () => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        try { this.ws.send(JSON.stringify({ type: 'ping', ts: Date.now() })); } catch (e) {}
        setTimeout(ping, 5000);
      };
      setTimeout(ping, 5000);
    }

    _scheduleReconnect() {
      if (!this.shouldRun) return;
      if (this.wsReconnectTimer) return;
      this.wsReconnectTimer = setTimeout(() => { this.wsReconnectTimer = null; this._connect(); }, 1500);
    }

    _onMessage(ev) {
      const data = ev.data;
      if (data instanceof ArrayBuffer) {
        this._handleBinaryFrame(new Uint8Array(data));
      } else {
        try {
          const msg = JSON.parse(String(data));
          this._handleJsonMessage(msg);
        } catch (e) {}
      }
    }

    _handleJsonMessage(msg) {
      if (msg.type === 'hello') {
        log('hello', msg);
      } else if (msg.type === 'config') {
        if (msg.width) this.screenWidth = msg.width;
        if (msg.height) this.screenHeight = msg.height;
        if (msg.codec) this.videoCodec = msg.codec;
        if (msg.imageQuality) this.imageQuality = msg.imageQuality;
        if (this.canvas) {
          this.canvas.width = this.screenWidth || 240;
          this.canvas.height = this.screenHeight || 320;
          this._autoscale();
        }
        this.onConfig(msg);
      } else if (msg.type === 'audio-format') {
        if (msg.format) {
          this.audioFormat = Object.assign(this.audioFormat, msg.format);
          if (msg.codec === 'opus' && msg.audioUrl) this.opusAudioUrl = msg.audioUrl;
        }
      } else if (msg.type === 'audio-status') {
        if (msg.audioUrl) {
          this.opusAudioUrl = msg.audioUrl;
          if (this.audioUnlocked && !this.audioMuted) this._startOpusAudio();
        }
      } else if (msg.type === 'status') {
        log('status', msg);
      } else if (msg.type === 'error') {
        warn('server error:', msg.error);
      }
    }

    _handleBinaryFrame(u8) {
      // Detect FJ2A audio packet.
      if (u8.length >= 5 && u8[0] === 0x46 && u8[1] === 0x4A && u8[2] === 0x32 && u8[3] === 0x41) {
        this._handleAudioPacket(u8);
        return;
      }
      this.latestFrame = u8;
      this._scheduleDraw();
    }

    _handleAudioPacket(u8) {
      const type = u8[4];
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      if (type === 1 && u8.length >= 13) {
        this.audioFormat = {
          sampleRate: dv.getUint32(5, false),
          channels: u8[9] || 1,
          bits: u8[10] || 16,
          signed: u8[11] !== 0,
          bigEndian: u8[12] !== 0,
        };
        if (this.audioCtx) this.audioNextTime = this.audioCtx.currentTime + 0.18;
        return;
      }
      if (type !== 2 || u8.length < 9) return;
      const len = dv.getUint32(5, false);
      if (len <= 0 || 9 + len > u8.length) return;
      if (!this.audioUnlocked || this.audioMuted || !this.audioCtx || this.audioFormat.bits !== 16) return;
      const chs = Math.max(1, this.audioFormat.channels | 0);
      const frames = Math.floor(len / (2 * chs));
      if (frames <= 0) return;
      const buf = this.audioCtx.createBuffer(chs, frames, this.audioFormat.sampleRate || 48000);
      const cd = [];
      for (let c = 0; c < chs; c++) cd[c] = buf.getChannelData(c);
      let off = 9;
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < chs; c++) {
          let smp = this.audioFormat.bigEndian ? ((u8[off] << 8) | u8[off + 1]) : (u8[off] | (u8[off + 1] << 8));
          if (this.audioFormat.signed && smp >= 0x8000) smp -= 0x10000;
          if (!this.audioFormat.signed) smp -= 0x8000;
          cd[c][i] = Math.max(-1, Math.min(1, smp / 32768));
          off += 2;
        }
      }
      const nowAudio = this.audioCtx.currentTime;
      if (!this.audioNextTime || this.audioNextTime < nowAudio + 0.04) this.audioNextTime = nowAudio + 0.18;
      if (this.audioNextTime > nowAudio + 0.9) return; // drop backlog
      const src = this.audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(this.audioCtx.destination);
      src.start(this.audioNextTime);
      this.audioNextTime += buf.duration;
    }

    _startOpusAudio() {
      if (!this.opusAudioUrl) return;
      if (!this.opusAudioEl) {
        this.opusAudioEl = new Audio();
        this.opusAudioEl.autoplay = true;
        document.body.appendChild(this.opusAudioEl);
      }
      this.opusAudioEl.src = this.opusAudioUrl + '?t=' + Date.now();
      this.opusAudioEl.play().catch(() => {});
    }

    _scheduleDraw() {
      if (this.rafPending || !this.ctx) return;
      this.rafPending = true;
      requestAnimationFrame(() => {
        this.rafPending = false;
        if (!this.latestFrame) return;
        try {
          this._decodeDraw(this.latestFrame);
          this.fpsCount++;
          const n = performance.now();
          if (n - this.lastFpsTime >= 1000) {
            if (this.fpsEl) this.fpsEl.textContent = this.fpsCount + ' FPS [' + this.videoCodec + ']';
            this.fpsCount = 0; this.lastFpsTime = n;
          }
        } catch (e) { warn('draw failed:', e.message); }
      });
    }

    _decodeDraw(src) {
      const pixels = this.screenWidth * this.screenHeight;
      if (!pixels) return;
      let codec = this.videoCodec;
      if (codec !== 'rgba' && codec !== 'rgb565' && codec !== 'rgb332') {
        if (src.length >= pixels * 4) codec = 'rgba';
        else if (src.length >= pixels * 2) codec = 'rgb565';
        else if (src.length >= pixels) codec = 'rgb332';
      }
      if (!this.reusableImageData || this.reusableImageData.width !== this.screenWidth || this.reusableImageData.height !== this.screenHeight) {
        this.reusableImageData = this.ctx.createImageData(this.screenWidth, this.screenHeight);
      }
      const dst = this.reusableImageData.data;
      if (codec === 'rgb332') {
        if (src.length < pixels) return;
        for (let i = 0, j = 0; i < pixels; i++, j += 4) {
          const v = src[i];
          dst[j] = Math.round(((v >> 5) & 7) * 255 / 7);
          dst[j + 1] = Math.round(((v >> 2) & 7) * 255 / 7);
          dst[j + 2] = Math.round((v & 3) * 255 / 3);
          dst[j + 3] = 255;
        }
      } else if (codec === 'rgb565') {
        if (src.length < pixels * 2) return;
        for (let i = 0, k = 0, j = 0; i < pixels; i++, k += 2, j += 4) {
          const v = src[k] | (src[k + 1] << 8);
          dst[j] = Math.round(((v >> 11) & 31) * 255 / 31);
          dst[j + 1] = Math.round(((v >> 5) & 63) * 255 / 63);
          dst[j + 2] = Math.round((v & 31) * 255 / 31);
          dst[j + 3] = 255;
        }
      } else {
        const expected = pixels * 4;
        if (src.length < expected) return;
        dst.set(src.subarray(0, expected));
      }
      this.ctx.putImageData(this.reusableImageData, 0, 0);
    }

    _autoscale() {
      if (!this.canvas) return;
      const sw = window.innerWidth, sh = window.innerHeight;
      const isMobile = !!document.getElementById('left-keys');
      let aw = sw, ah = sh;
      if (isMobile) {
        if (sw > sh) aw = sw - 2 * 220; else ah = sh - 220;
      }
      const scale = Math.min(aw / this.screenWidth, ah / this.screenHeight) | 0;
      if (scale >= 1) this.canvas.style.zoom = scale;
    }

    stop() {
      this.shouldRun = false;
      if (this.ws) try { this.ws.close(); } catch (e) {}
      if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
    }
  }

  // =================================================================
  // Auto-init: detect ?bridge=1 trên run.html hoặc index.html.
  // =================================================================
  function autoInit() {
    if (!CFG.enabled) return;
    const isRunHtml = !!document.getElementById('display');
    const bridgeFlag = getQueryParam(CFG.bridgeParamName);
    const gameId = getQueryParam(CFG.gameIdParamName);
    const appId = getQueryParam(CFG.appIdParamName);

    if (isRunHtml && bridgeFlag === '1' && gameId) {
      log('run.html detected bridge=1, gameId=' + gameId);
      // Chặn CheerpJ init bằng cách set flag và stop main.js ASAP.
      // main.js load type=module và async, nên patch này chỉ effective trước khi module xử lý.
      // Tactic: đợi DOM ready, chặn các native bridge calls nếu CheerpJ đã init.
      const startBridge = () => {
        const client = new BridgeStreamClient({ gameId, appId, onConfig: (msg) => log('config', msg) });
        client.start();
        window.__fj2meBridgeClient = client;
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startBridge);
      } else {
        startBridge();
      }
      return;
    }

    // index.html: launcher - inject nút Bridge.
    if (!isRunHtml && document.getElementById('game-list')) {
      log('index.html detected (launcher), injecting Bridge buttons');
      const startInject = () => injectLauncherBridgeButtons();
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startInject);
      } else {
        startInject();
      }
    }
  }

  // Expose cho debugger / custom scripts.
  window.FJ2ME_BRIDGE_CLIENT = {
    pushGameToBridge,
    BridgeStreamClient,
    normalizeSettingsForBridge,
    apiBase,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }
})();
