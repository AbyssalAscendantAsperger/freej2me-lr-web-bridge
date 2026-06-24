const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, execSync } = require('child_process');
const WebSocket = require('ws');
const express = require('express');

const HTTP_PORT = 3001;
const JAVA_WS_PORT = 35556;

// Đọc cấu hình từ config.json chuẩn
const CFG_PATH = path.join(__dirname, 'config.json');
let JAVA_CMD = 'java';
let CORE_JAR = path.join(__dirname, 'freej2me-plus', 'freej2me-lr.jar');

if (fs.existsSync(CFG_PATH)) {
  try {
    const c = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    if (c.javaPath) {
      const p = path.resolve(__dirname, c.javaPath);
      if (process.platform === 'win32' || !p.toLowerCase().endsWith('.exe')) {
        if (fs.existsSync(p)) JAVA_CMD = p;
      }
    }
    if (c.freej2meJar) {
      const p = path.resolve(__dirname, c.freej2meJar);
      if (fs.existsSync(p)) {
        if (fs.statSync(p).isDirectory()) CORE_JAR = path.join(p, 'freej2me-lr.jar');
        else CORE_JAR = p;
      }
    }
  } catch(e) {}
}

let DEFAULT_ROM = path.join(__dirname, 'demo_game.jar');
if (!fs.existsSync(DEFAULT_ROM)) {
  const alt = path.join(__dirname, 'freej2me-plus', 'freej2me.jar');
  if (fs.existsSync(alt)) DEFAULT_ROM = alt;
  else DEFAULT_ROM = CORE_JAR;
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let javaProc = null;
let stressInstances = [];
let isRunningBench = false;
let activeSpamRate = 5;

// Khởi chạy JavaBackend trên cổng 35556
function ensureJavaBackend() {
  if (javaProc && javaProc.exitCode === null) return;
  if (!fs.existsSync(CORE_JAR)) {
    console.error(`[BENCH-3001 ERR] Không tìm thấy tệp giả lập core: ${CORE_JAR}`);
    return;
  }
  const args = ['-Djava.awt.headless=true', '-Dfreej2me.maxConcurrentSessions=5000', '-cp', CORE_JAR, 'org.recompile.freej2me.transport.WebSocketMain', String(JAVA_WS_PORT)];
  console.log(`[BENCH-3001] Đang boot JavaBackend: ${JAVA_CMD} ${args.join(' ')}`);
  javaProc = spawn(JAVA_CMD, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  javaProc.stdout.on('data', d => {
    const s = d.toString('utf8').trim();
    if (s) console.log(`[JavaCore-3001] ${s}`);
  });
  javaProc.stderr.on('data', d => {
    const s = d.toString('utf8').trim();
    if (s) console.error(`[JavaCore-3001 ERR] ${s}`);
  });
  javaProc.on('exit', c => {
    console.warn(`[BENCH-3001] JavaBackend thoát (code=${c}). Boot lại sau 3s...`);
    javaProc = null;
    setTimeout(ensureJavaBackend, 3000);
  });
}

ensureJavaBackend();

// Hàm đo lường RAM & CPU
function getPerfMetrics() {
  const nodeRamMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
  let javaRamMb = 0;
  let cpuPercent = 0;
  if (javaProc && javaProc.pid) {
    try {
      if (process.platform === 'win32') {
        const out = execSync(`wmic process where processid=${javaProc.pid} get WorkingSetSize`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const m = out.match(/\d+/);
        if (m) javaRamMb = Math.round(parseInt(m[0], 10) / (1024 * 1024));
      } else {
        const out = execSync(`ps -o rss=,pcpu= -p ${javaProc.pid}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        const parts = out.split(/\s+/);
        if (parts[0]) javaRamMb = Math.round(parseInt(parts[0], 10) / 1024);
        if (parts[1]) cpuPercent = Math.round(parseFloat(parts[1]));
      }
    } catch(e) {}
  }
  return {
    nodeRamMb,
    javaRamMb,
    totalRamMb: nodeRamMb + javaRamMb,
    cpuPercent,
    activeInstances: stressInstances.length
  };
}

// Bắn thông số Debug định kỳ mỗi 2s cho UI
setInterval(() => {
  const metrics = getPerfMetrics();
  const payload = JSON.stringify({ type: 'metrics', ...metrics });
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(payload);
  });
}, 2000);

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <title>FreeJ2ME-Plus Multi-VM Stress Test & Benchmark</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0f172a; color: #e2e8f0; font-family: system-ui, sans-serif; padding: 20px; }
    .header { max-width: 900px; margin: 0 auto 20px; text-align: center; }
    .header h1 { color: #38bdf8; font-size: 26px; margin-bottom: 8px; }
    .header p { color: #94a3b8; font-size: 14px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 20px; max-width: 900px; margin: 0 auto 20px; }
    .control-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
    @media(max-width: 640px) { .control-grid { grid-template-columns: 1fr; } }
    .field { display: flex; flex-direction: column; gap: 8px; }
    .field label { font-size: 14px; font-weight: 600; color: #cbd5e1; display: flex; justify-content: space-between; }
    .field label span { color: #38bdf8; font-family: monospace; }
    input[type="range"] { accent-color: #38bdf8; cursor: pointer; }
    input[type="text"] { background: #0f172a; border: 1px solid #475569; color: #fff; padding: 10px 14px; border-radius: 8px; font-family: monospace; }
    .btn-row { display: flex; gap: 12px; justify-content: center; }
    button { padding: 12px 24px; border: 0; border-radius: 12px; font-weight: 700; cursor: pointer; transition: all 0.2s; }
    .btn-start { background: #0284c7; color: #fff; flex: 1; }
    .btn-start:hover { background: #0369a1; }
    .btn-stop { background: #dc2626; color: #fff; }
    .btn-stop:hover { background: #b91c1c; }
    .perf-box { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 20px; }
    .metric { background: #0f172a; padding: 14px; border-radius: 12px; text-align: center; border: 1px solid #334155; }
    .metric h3 { font-size: 12px; color: #94a3b8; text-transform: uppercase; margin-bottom: 4px; }
    .metric div { font-size: 22px; font-weight: 800; color: #38bdf8; font-family: monospace; }
    .screen-carousel { display: flex; flex-direction: column; align-items: center; background: #0f172a; padding: 20px; border-radius: 16px; border: 1px solid #334155; }
    canvas { background: #000; border: 2px solid #475569; border-radius: 8px; image-rendering: pixelated; margin-bottom: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
    .pan-control { width: 100%; max-width: 400px; display: flex; flex-direction: column; gap: 8px; }
    .pan-control div { text-align: center; font-size: 13px; color: #f1f5f9; font-weight: 600; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🚀 Hệ thống Benchmark & Stress Test Đa máy ảo J2ME</h1>
    <p>Mở đồng thời hàng chục giả lập cô lập trên cùng một Lõi Java 8, mô phỏng phím bấm loạn xạ và đo lường tài nguyên thực tế.</p>
  </div>

  <div class="card">
    <div class="field" style="margin-bottom: 20px;">
      <label>Đường dẫn Rom game J2ME (.jar):</label>
      <input type="text" id="jar-path" value="${DEFAULT_ROM.replace(/\\/g, '/')}">
    </div>

    <div class="control-grid">
      <div class="field">
        <label>Số lượng giả lập mở đồng thời: <span id="val-instances">10</span></label>
        <input type="range" id="slide-instances" min="1" max="1000" value="10">
      </div>
      <div class="field">
        <label>Tốc độ phím ngẫu nhiên loạn xạ: <span id="val-spam">5 phím/s</span></label>
        <input type="range" id="slide-spam" min="0" max="50" value="5">
      </div>
    </div>

    <div class="btn-row">
      <button class="btn-start" id="btn-start">🔥 Khởi chạy Multi-VM Stress Test</button>
      <button class="btn-stop" id="btn-stop">🛑 Dừng tất cả máy ảo</button>
    </div>
  </div>

  <div class="card">
    <div class="perf-box">
      <div class="metric"><h3>🧠 Tổng RAM Sử dụng</h3><div id="m-ram">0 MB</div></div>
      <div class="metric"><h3>⚡ Tổng CPU Sử dụng</h3><div id="m-cpu">0 %</div></div>
      <div class="metric"><h3>🎮 Máy ảo Hoạt động</h3><div id="m-count">0 / 0</div></div>
    </div>

    <div class="screen-carousel">
      <canvas id="lcd" width="240" height="320"></canvas>
      <div class="pan-control">
        <div id="screen-info">📺 Kéo thanh trượt ngang bên dưới để chọn xem màn hình các máy ảo</div>
        <input type="range" id="slide-screen" min="0" max="0" value="0" disabled>
      </div>
    </div>
  </div>

  <script>
    const slideInstances = document.getElementById('slide-instances');
    const valInstances = document.getElementById('val-instances');
    const slideSpam = document.getElementById('slide-spam');
    const valSpam = document.getElementById('val-spam');
    const slideScreen = document.getElementById('slide-screen');
    const screenInfo = document.getElementById('screen-info');
    const jarPath = document.getElementById('jar-path');
    const lcd = document.getElementById('lcd');
    const ctx = lcd.getContext('2d');

    slideInstances.oninput = () => valInstances.textContent = slideInstances.value;
    slideSpam.oninput = () => {
      valSpam.textContent = slideSpam.value + ' phím/s';
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'setSpamRate', rate: parseInt(slideSpam.value) }));
    };

    let ws = new WebSocket('ws://' + location.host);
    ws.binaryType = 'arraybuffer';

    let currentSubscribed = 0;

    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const msg = JSON.parse(e.data);
        if (msg.type === 'metrics') {
          document.getElementById('m-ram').textContent = msg.totalRamMb + ' MB';
          document.getElementById('m-cpu').textContent = msg.cpuPercent + ' %';
          document.getElementById('m-count').textContent = msg.activeInstances + ' / ' + slideInstances.value;
        } else if (msg.type === 'benchStarted') {
          slideScreen.max = Math.max(0, msg.count - 1);
          slideScreen.disabled = msg.count <= 1;
          slideScreen.value = 0;
          currentSubscribed = 0;
          updateScreenLabel();
        }
      } else {
        const buf = new Uint8Array(e.data);
        if (buf.length >= 16 && buf[0] === 0xFE) {
          const rgb = buf.subarray(16);
          const img = ctx.createImageData(240, 320);
          for(let i=0, j=0; i < rgb.length; i+=3, j+=4) {
            img.data[j]   = rgb[i];
            img.data[j+1] = rgb[i+1];
            img.data[j+2] = rgb[i+2];
            img.data[j+3] = 255;
          }
          ctx.putImageData(img, 0, 0);
        }
      }
    };

    function updateScreenLabel() {
      screenInfo.textContent = '📺 Đang xem màn hình Giả lập số: ' + (currentSubscribed + 1) + ' / ' + (parseInt(slideScreen.max) + 1) + ' (sim_user_' + currentSubscribed + ')';
    }

    slideScreen.oninput = () => {
      currentSubscribed = parseInt(slideScreen.value);
      updateScreenLabel();
      ws.send(JSON.stringify({ type: 'selectScreen', index: currentSubscribed }));
    };

    document.getElementById('btn-start').onclick = () => {
      ws.send(JSON.stringify({
        type: 'startBench',
        jar: jarPath.value,
        count: parseInt(slideInstances.value),
        spam: parseInt(slideSpam.value)
      }));
    };

    document.getElementById('btn-stop').onclick = () => {
      ws.send(JSON.stringify({ type: 'stopBench' }));
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 240, 320);
    };
  </script>
</body>
</html>`);
});

wss.on('connection', (ws) => {
  ws.subscribedScreenIndex = 0;

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString('utf8'));
      if (data.type === 'selectScreen') {
        ws.subscribedScreenIndex = data.index | 0;
        const inst = stressInstances[ws.subscribedScreenIndex];
        if (inst && inst.lastFrameBuf) ws.send(inst.lastFrameBuf);
      } else if (data.type === 'setSpamRate') {
        activeSpamRate = data.rate | 0;
      } else if (data.type === 'stopBench') {
        stopAllInstances();
      } else if (data.type === 'startBench') {
        startBenchmarkInstances(data.jar, data.count | 0, data.spam | 0, ws);
      }
    } catch(e) {}
  });
});

function stopAllInstances() {
  isRunningBench = false;
  stressInstances.forEach(inst => {
    if (inst.spamTimer) clearInterval(inst.spamTimer);
    if (inst.frameTimer) clearInterval(inst.frameTimer);
    try { if (inst.ws) inst.ws.close(); } catch(e) {}
  });
  stressInstances = [];
  console.log('[BENCH-3001] Đã dừng tất cả máy ảo benchmark.');
}

const REQ_FRAME_CMD = Buffer.from([15, 0, 0, 0, 0]);

function startBenchmarkInstances(jarPath, count, spamRate, clientWs) {
  stopAllInstances();
  isRunningBench = true;
  activeSpamRate = spamRate;
  count = Math.max(1, Math.min(1000, count));

  console.log(`[BENCH-3001] Bắt đầu benchmark: ${count} máy ảo, Rom=${jarPath}, spam=${spamRate} phím/s`);

  clientWs.send(JSON.stringify({ type: 'benchStarted', count }));

  for (let i = 0; i < count; i++) {
    const simUser = `sim_user_${i}_${Date.now().toString(36)}`;
    const emuWs = new WebSocket(`ws://127.0.0.1:${JAVA_WS_PORT}`);
    
    const instObj = {
      index: i,
      user: simUser,
      ws: emuWs,
      lastFrameBuf: null,
      spamTimer: null,
      frameTimer: null
    };
    stressInstances.push(instObj);

    emuWs.on('open', () => {
      const cfg = {
        width: 240,
        height: 320,
        phone: 0,
        rotate: 0,
        fps: 30,
        sound: 0,
        jar: jarPath,
        sessionId: simUser
      };
      emuWs.send(JSON.stringify(cfg));

      // Bơm lệnh xin Frame định kỳ (~30 FPS) để máy ảo vẽ LCD
      instObj.frameTimer = setInterval(() => {
        if (!isRunningBench || emuWs.readyState !== WebSocket.OPEN) return;
        emuWs.send(REQ_FRAME_CMD, { binary: true });
      }, 33);

      const randomKeys = [-5, -1, -2, -3, -4, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57];
      instObj.spamTimer = setInterval(() => {
        if (!isRunningBench || activeSpamRate <= 0 || emuWs.readyState !== WebSocket.OPEN) return;
        const k = randomKeys[Math.floor(Math.random() * randomKeys.length)];
        const downBuf = Buffer.alloc(5);
        downBuf[0] = 3;
        downBuf.writeInt32BE(k, 1);
        emuWs.send(downBuf, { binary: true });

        setTimeout(() => {
          if (emuWs.readyState === WebSocket.OPEN) {
            const upBuf = Buffer.alloc(5);
            upBuf[0] = 2;
            upBuf.writeInt32BE(k, 1);
            emuWs.send(upBuf, { binary: true });
          }
        }, 50);
      }, Math.max(20, Math.floor(1000 / Math.max(1, activeSpamRate))));
    });

    emuWs.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (buf.length >= 16 && buf[0] === 0xFE) {
          instObj.lastFrameBuf = buf;
          wss.clients.forEach(c => {
            if (c.readyState === WebSocket.OPEN && c.subscribedScreenIndex === i) {
              c.send(buf);
            }
          });
        }
      }
    });

    emuWs.on('close', () => {
      if (instObj.spamTimer) clearInterval(instObj.spamTimer);
      if (instObj.frameTimer) clearInterval(instObj.frameTimer);
    });
  }
}

server.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`[BENCH-3001] Giao diện Benchmark Đa máy ảo đang chạy tại http://localhost:${HTTP_PORT}`);
});
