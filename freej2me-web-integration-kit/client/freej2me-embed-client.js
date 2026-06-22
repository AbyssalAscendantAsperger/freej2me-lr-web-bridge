/*
 * FreeJ2ME Web Bridge Embed Client SDK
 * Same-origin recommended. If hosted on another domain, use reverse proxy or iframe.
 */
(function (global) {
  class FreeJ2MEEmbedClient {
    constructor(options) {
      this.baseUrl = (options.baseUrl || '').replace(/\/$/, '');
      this.canvas = typeof options.canvas === 'string' ? document.querySelector(options.canvas) : options.canvas;
      this.statusEl = options.statusEl ? (typeof options.statusEl === 'string' ? document.querySelector(options.statusEl) : options.statusEl) : null;
      this.onStatus = options.onStatus || function () {};
      this.onAuth = options.onAuth || function () {};
      this.onAudioStatus = options.onAudioStatus || function () {};
      this.ctx = this.canvas.getContext('2d', { alpha: false });
      this.ws = null;
      this.screenWidth = options.width || 240;
      this.screenHeight = options.height || 320;
      this.videoCodec = 'rgba';
      this.imageQuality = 100;
      this.latestFrame = null;
      this.rafPending = false;
      this.imageData = null;
      this.audioCtx = null;
      this.audioUnlocked = false;
      this.audioMuted = false;
      this.audioNextTime = 0;
      this.audioFormat = { sampleRate: 48000, channels: 2, bits: 16, signed: true, bigEndian: false };
      this.frameCount = 0;
      this.lastFpsTime = performance.now();
    }

    setStatus(text) {
      if (this.statusEl) this.statusEl.textContent = text;
      this.onStatus(text);
    }

    async api(path, body) {
      const res = await fetch(this.baseUrl + path, {
        method: body ? 'POST' : 'GET',
        credentials: 'include',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || res.statusText);
      return json;
    }

    me() { return this.api('/api/me'); }
    register(username, password) { return this.api('/api/register', { username, password }); }
    login(username, password) { return this.api('/api/login', { username, password }); }
    logout() { return this.api('/api/logout', {}); }

    async uploadJar(file) {
      const fd = new FormData();
      fd.append('jar', file);
      const res = await fetch(this.baseUrl + '/upload', { method: 'POST', credentials: 'include', body: fd });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || res.statusText);
      // Reconnect/bind to new game session.
      this.disconnect();
      setTimeout(() => this.connect(), 200);
      return json;
    }

    connect() {
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
      const proto = this.baseUrl.startsWith('https') ? 'wss' : (location.protocol === 'https:' ? 'wss' : 'ws');
      let wsUrl;
      if (this.baseUrl.startsWith('http')) {
        const u = new URL(this.baseUrl);
        wsUrl = proto + '://' + u.host;
      } else {
        wsUrl = proto + '://' + location.host;
      }
      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = 'arraybuffer';
      this.ws.onopen = () => this.setStatus('connected');
      this.ws.onclose = () => this.setStatus('disconnected');
      this.ws.onerror = () => this.setStatus('websocket error');
      this.ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          const u8 = new Uint8Array(event.data);
          if (!this.handleAudioPacket(u8)) {
            this.latestFrame = u8;
            this.scheduleDraw();
          }
          return;
        }
        const msg = JSON.parse(event.data);
        if (msg.type === 'config') {
          this.screenWidth = msg.width;
          this.screenHeight = msg.height;
          this.videoCodec = msg.videoCodec || 'rgba';
          this.imageQuality = msg.imageQuality || 100;
          this.canvas.width = this.screenWidth;
          this.canvas.height = this.screenHeight;
          this.setStatus(`screen ${this.screenWidth}x${this.screenHeight} ${this.videoCodec}`);
        } else if (msg.type === 'auth') {
          this.onAuth(msg);
        } else if (msg.type === 'audio-status') {
          this.onAudioStatus(msg);
        }
      };
    }

    disconnect() {
      if (this.ws) {
        try { this.ws.close(); } catch (e) {}
      }
      this.ws = null;
    }

    send(data) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(data));
    }

    keyDown(key) { this.send({ type: 'key', state: 'D', key }); }
    keyUp(key) { this.send({ type: 'key', state: 'U', key }); }
    touch(state, x, y) { this.send({ type: 'touch', state, x, y }); }

    unlockAudio() {
      if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      this.audioCtx.resume();
      this.audioUnlocked = true;
      this.audioMuted = false;
      this.audioNextTime = this.audioCtx.currentTime + 0.08;
    }

    handleAudioPacket(u8) {
      if (!(u8 && u8.length >= 5 && u8[0] === 0x46 && u8[1] === 0x4A && u8[2] === 0x32 && u8[3] === 0x41)) return false;
      const type = u8[4];
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      if (type === 1 && u8.length >= 13) {
        this.audioFormat = { sampleRate: dv.getUint32(5, false), channels: u8[9] || 1, bits: u8[10] || 16, signed: u8[11] !== 0, bigEndian: u8[12] !== 0 };
        return true;
      }
      if (type !== 2 || !this.audioUnlocked || this.audioMuted || !this.audioCtx || this.audioFormat.bits !== 16) return true;
      const len = dv.getUint32(5, false);
      if (len <= 0 || 9 + len > u8.length) return true;
      const chs = Math.max(1, this.audioFormat.channels | 0);
      const frames = Math.floor(len / (2 * chs));
      if (frames <= 0) return true;
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
      const src = this.audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(this.audioCtx.destination);
      const n = this.audioCtx.currentTime;
      if (!this.audioNextTime || this.audioNextTime < n + 0.02) this.audioNextTime = n + 0.06;
      if (this.audioNextTime > n + 0.45) return true;
      src.start(this.audioNextTime);
      this.audioNextTime += buf.duration;
      return true;
    }

    scheduleDraw() {
      if (this.rafPending) return;
      this.rafPending = true;
      requestAnimationFrame(() => {
        this.rafPending = false;
        if (!this.latestFrame) return;
        if (!this.imageData || this.imageData.width !== this.screenWidth || this.imageData.height !== this.screenHeight) {
          this.imageData = this.ctx.createImageData(this.screenWidth, this.screenHeight);
        }
        if (!this.decodeVideoFrame(this.latestFrame, this.imageData)) return;
        this.ctx.putImageData(this.imageData, 0, 0);
        this.frameCount++;
      });
    }

    decodeVideoFrame(src, imageData) {
      const dst = imageData.data;
      const pixels = this.screenWidth * this.screenHeight;
      let codec = this.videoCodec;
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
      if (src.length < pixels * 4) return false;
      dst.set(src.subarray(0, pixels * 4));
      return true;
    }
  }

  global.FreeJ2MEEmbedClient = FreeJ2MEEmbedClient;
})(window);
