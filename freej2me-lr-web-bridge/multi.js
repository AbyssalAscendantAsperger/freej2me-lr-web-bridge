const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const os = require('os');
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

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function waitForPort(port, host = '127.0.0.1', timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const sock = net.createConnection({ host, port }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.setTimeout(800);
      sock.on('error', () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error(`Timeout waiting ${host}:${port}`));
        else setTimeout(tryConnect, 250);
      });
      sock.on('timeout', () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error(`Timeout waiting ${host}:${port}`));
        else setTimeout(tryConnect, 250);
      });
    };
    tryConnect();
  });
}

function buildBackendConfig(jarPath, simUser) {
  const safeUser = String(simUser).replace(/[^a-zA-Z0-9_.-]/g, '_');
  const dataDir = path.join(__dirname, 'freej2me_data', 'multi', safeUser, 'runtime');
  ensureDir(dataDir);
  return {
    sessionId: simUser,
    dataDir: path.resolve(dataDir),
    jar: path.resolve(jarPath),
    encoding: 'ISO_8859_1',
    width: 240,
    height: 320,
    rotate: 0,
    phone: 0,
    fps: 30,
    sound: 0,
    midi: 0,
    logLevel: 2,
    noAlpha: 1,
    backlight: 1,
    deleteKJX: 1,
    overridePlatform: 1
  };
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let javaProc = null;
let stressInstances = [];
let isRunningBench = false;
let activeSpamRate = 5;
let lastRequestedCount = 0;
let benchBaseline = null;

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
// Có 3 khái niệm khác nhau:
// - RSS/WorkingSet: RAM vật lý mà OS đang giữ cho process Java.
// - PrivateBytes: RAM riêng của process Java, gần Task Manager hơn trên Windows.
// - Java heap/managed: bộ nhớ do JVM quản lý, đọc bằng jstat nếu JDK/JRE có jstat.
let lastCpuSample = null;
let cachedJstatCmd = undefined;

function mb(bytes) { return Math.round((Number(bytes) || 0) / (1024 * 1024)); }
function kbToMb(kb) { return Math.round((Number(kb) || 0) / 1024); }
function safeNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function getJstatCommand() {
  if (cachedJstatCmd !== undefined) return cachedJstatCmd;
  cachedJstatCmd = null;
  try {
    const exe = process.platform === 'win32' ? 'jstat.exe' : 'jstat';
    const candidates = [];
    if (process.env.JSTAT_PATH) candidates.push(process.env.JSTAT_PATH);
    if (JAVA_CMD && path.isAbsolute(JAVA_CMD)) {
      const javaBin = path.dirname(JAVA_CMD);
      candidates.push(path.join(javaBin, exe));
      // config hiện trỏ tới .../jdk8u492-b09-jre/bin/java.exe; jstat thường nằm ở JDK sibling .../jdk.../bin/jstat.exe
      const maybeJreHome = path.dirname(javaBin);
      const parent = path.dirname(maybeJreHome);
      try {
        for (const d of fs.readdirSync(parent)) {
          if (/jdk|openjdk|temurin|zulu|corretto/i.test(d)) candidates.push(path.join(parent, d, 'bin', exe));
        }
      } catch(e) {}
    }
    if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin', exe));
    candidates.push(exe);
    for (const c of candidates) {
      try {
        if (c === exe || fs.existsSync(c)) { cachedJstatCmd = c; break; }
      } catch(e) {}
    }
  } catch(e) {}
  return cachedJstatCmd;
}

function getJavaManagedMemoryMetrics(pid) {
  const empty = { javaHeapUsedMb: 0, javaHeapCommittedMb: 0, javaMetaUsedMb: 0, javaManagedUsedMb: 0, jstatOk: false };
  const jstat = getJstatCommand();
  if (!jstat || !pid) return empty;
  try {
    const cmd = `"${jstat}" -gc ${pid} 1 1`;
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 }).trim();
    const lines = out.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    if (lines.length < 2) return empty;
    const names = lines[0].split(/\s+/);
    const vals = lines[1].split(/\s+/).map(Number);
    const m = {};
    names.forEach((name, i) => { m[name] = safeNum(vals[i]); });

    // jstat -gc trả đơn vị KB. Java 8 thường có S0/S1/Eden/Old/Metaspace/CompressedClass.
    const heapUsedKb = safeNum(m.S0U) + safeNum(m.S1U) + safeNum(m.EU) + safeNum(m.OU);
    const heapCommittedKb = safeNum(m.S0C) + safeNum(m.S1C) + safeNum(m.EC) + safeNum(m.OC);
    const metaUsedKb = safeNum(m.MU) + safeNum(m.CCSU);
    return {
      javaHeapUsedMb: kbToMb(heapUsedKb),
      javaHeapCommittedMb: kbToMb(heapCommittedKb),
      javaMetaUsedMb: kbToMb(metaUsedKb),
      javaManagedUsedMb: kbToMb(heapUsedKb + metaUsedKb),
      jstatOk: true
    };
  } catch(e) {
    return empty;
  }
}

function getJavaProcessMetrics(pid) {
  const r = { javaRssMb: 0, javaPrivateMb: 0, javaCpuSeconds: 0 };
  if (!pid) return r;
  try {
    if (process.platform === 'win32') {
      // Dùng PowerShell -EncodedCommand để tránh lỗi quote/escape khi Node chạy dưới .bat/cmd.
      // WorkingSet64 gần với cột Memory của Task Manager; PrivateMemorySize64 là private bytes.
      const ps = `$p=Get-Process -Id ${pid} -ErrorAction Stop; ` +
        `$o=[ordered]@{WorkingSet=$p.WorkingSet64;Private=$p.PrivateMemorySize64;CPU=[double]($p.CPU)}; ` +
        `[Console]::Out.Write(($o | ConvertTo-Json -Compress))`;
      const encoded = Buffer.from(ps, 'utf16le').toString('base64');
      const out = execSync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim();
      const j = JSON.parse(out);
      r.javaRssMb = mb(j.WorkingSet);
      r.javaPrivateMb = mb(j.Private);
      r.javaCpuSeconds = safeNum(j.CPU);
    } else {
      // Linux/macOS: RSS từ ps; CPU time ưu tiên /proc trên Linux.
      const out = execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000 }).trim();
      if (out) r.javaRssMb = Math.round(parseInt(out.split(/\s+/)[0], 10) / 1024);
      r.javaPrivateMb = r.javaRssMb;
      if (process.platform === 'linux' && fs.existsSync(`/proc/${pid}/stat`)) {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const after = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
        const utime = safeNum(after[11]);
        const stime = safeNum(after[12]);
        let hz = 100;
        try { hz = parseInt(execSync('getconf CLK_TCK', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 500 }).trim(), 10) || 100; } catch(e) {}
        r.javaCpuSeconds = (utime + stime) / hz;
      } else {
        const pcpu = execSync(`ps -o time= -p ${pid}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000 }).trim();
        // Fallback không tính chính xác CPU delta nếu không đọc được total CPU time.
      }
    }
  } catch(e) {}
  return r;
}

function snapshotProcessMetricsOnly() {
  const javaPid = javaProc && javaProc.pid ? javaProc.pid : 0;
  const proc = getJavaProcessMetrics(javaPid);
  const managed = getJavaManagedMemoryMetrics(javaPid);
  return { javaPid, ...proc, ...managed };
}

function getPerfMetrics() {
  const nodeMem = process.memoryUsage();
  const nodeRamMb = mb(nodeMem.rss);
  const nodeHeapUsedMb = mb(nodeMem.heapUsed);
  const nodeCpuUsage = process.cpuUsage();
  const nodeCpuSeconds = (nodeCpuUsage.user + nodeCpuUsage.system) / 1e6;

  const javaPid = javaProc && javaProc.pid ? javaProc.pid : 0;
  const proc = getJavaProcessMetrics(javaPid);
  const managed = getJavaManagedMemoryMetrics(javaPid);

  const nowMs = Date.now();
  const cpuCount = Math.max(1, os.cpus().length || 1);
  let nodeCpuPercent = 0;
  let javaCpuPercent = 0;
  if (lastCpuSample && nowMs > lastCpuSample.t) {
    const elapsedSec = (nowMs - lastCpuSample.t) / 1000;
    nodeCpuPercent = Math.max(0, ((nodeCpuSeconds - lastCpuSample.nodeCpuSeconds) / elapsedSec / cpuCount) * 100);
    javaCpuPercent = Math.max(0, ((proc.javaCpuSeconds - lastCpuSample.javaCpuSeconds) / elapsedSec / cpuCount) * 100);
  }
  lastCpuSample = { t: nowMs, nodeCpuSeconds, javaCpuSeconds: proc.javaCpuSeconds };

  const active = stressInstances.filter(x => x && x.ws && x.ws.readyState === WebSocket.OPEN).length;
  const requested = lastRequestedCount || stressInstances.length || active;
  const baseRss = benchBaseline ? benchBaseline.javaRssMb : 0;
  const basePrivate = benchBaseline ? benchBaseline.javaPrivateMb : 0;
  const baseHeap = benchBaseline ? benchBaseline.javaHeapUsedMb : 0;
  const deltaRssMb = Math.max(0, proc.javaRssMb - baseRss);
  const deltaPrivateMb = Math.max(0, proc.javaPrivateMb - basePrivate);
  const deltaHeapMb = managed.jstatOk && benchBaseline && benchBaseline.jstatOk ? Math.max(0, managed.javaHeapUsedMb - baseHeap) : 0;
  return {
    nodeRamMb,
    nodeHeapUsedMb,
    javaPid,
    javaRssMb: proc.javaRssMb,
    javaPrivateMb: proc.javaPrivateMb,
    javaHeapUsedMb: managed.javaHeapUsedMb,
    javaHeapCommittedMb: managed.javaHeapCommittedMb,
    javaMetaUsedMb: managed.javaMetaUsedMb,
    javaManagedUsedMb: managed.javaManagedUsedMb,
    jstatOk: managed.jstatOk,
    jstatPath: getJstatCommand() || '',
    baselineRssMb: baseRss,
    baselinePrivateMb: basePrivate,
    deltaRssMb,
    deltaPrivateMb,
    deltaHeapMb,
    javaPerInstanceRssMb: requested > 0 ? Math.round(deltaRssMb / requested) : 0,
    javaPerInstancePrivateMb: requested > 0 ? Math.round(deltaPrivateMb / requested) : 0,
    javaPerInstanceHeapMb: requested > 0 && deltaHeapMb > 0 ? Math.round(deltaHeapMb / requested) : 0,
    totalRamMb: nodeRamMb + proc.javaRssMb,
    totalPrivateMb: nodeRamMb + (proc.javaPrivateMb || proc.javaRssMb),
    cpuPercent: Math.round(nodeCpuPercent + javaCpuPercent),
    javaCpuPercent: Math.round(javaCpuPercent),
    nodeCpuPercent: Math.round(nodeCpuPercent),
    activeInstances: active,
    requestedInstances: requested
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
      <button class="btn-stop" id="btn-stop">🛑 Dừng & reset lõi Java</button>
    </div>
  </div>

  <div class="card">
    <div class="perf-box">
      <div class="metric"><h3>🧠 RAM Process</h3><div id="m-ram">0 MB</div></div>
      <div class="metric"><h3>⚡ CPU Node + Java</h3><div id="m-cpu">0 %</div></div>
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
          const heapTxt = msg.jstatOk ? (' | heap ' + msg.javaHeapUsedMb + '/' + msg.javaHeapCommittedMb + ' MB') : ' | heap n/a';
          const avgTxt = msg.requestedInstances > 0 ? (' | ΔRSS ' + msg.deltaRssMb + ' MB ≈ ' + msg.javaPerInstanceRssMb + ' MB/VM') : '';
          document.getElementById('m-ram').textContent = 'PID ' + msg.javaPid + ' | Java RSS ' + msg.javaRssMb + ' MB | Private ' + msg.javaPrivateMb + ' MB' + heapTxt + avgTxt;
          document.getElementById('m-cpu').textContent = msg.cpuPercent + ' % (Java ' + msg.javaCpuPercent + '%, Node ' + msg.nodeCpuPercent + '%)';
          document.getElementById('m-count').textContent = msg.activeInstances + ' / ' + (msg.requestedInstances || slideInstances.value);
        } else if (msg.type === 'benchStarted') {
          slideScreen.max = Math.max(0, msg.count - 1);
          slideScreen.disabled = msg.count <= 1;
          slideScreen.value = 0;
          currentSubscribed = 0;
          updateScreenLabel();
        }
      } else {
        const buf = new Uint8Array(e.data);
        // JavaBackend trả packet video dạng: 0xFE + header 16 byte + RGB24.
        // Không hard-code kích thước; đọc width/height từ header để tránh đen màn hình
        // khi profile/rotate/game trả kích thước khác 240x320.
        if (buf.length >= 16 && buf[0] === 0xFE) {
          const w = (buf[1] << 8) | buf[2];
          const h = (buf[3] << 8) | buf[4];
          const frameSize = w * h * 3;
          if (w > 0 && h > 0 && buf.length >= 16 + frameSize) {
            if (lcd.width !== w || lcd.height !== h) {
              lcd.width = w;
              lcd.height = h;
            }
            const rgb = buf.subarray(16, 16 + frameSize);
            const img = ctx.createImageData(w, h);
            for (let i = 0, j = 0; i < frameSize; i += 3, j += 4) {
              img.data[j]     = rgb[i];
              img.data[j + 1] = rgb[i + 1];
              img.data[j + 2] = rgb[i + 2];
              img.data[j + 3] = 255;
            }
            ctx.putImageData(img, 0, 0);
          }
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
      // Dừng benchmark và reset hẳn JavaBackend để Windows/JVM trả RAM về baseline.
      // Đây là cách chắc chắn nhất vì nhiều game J2ME giữ thread/buffer riêng và JVM thường không trả RSS ngay.
      ws.send(JSON.stringify({ type: 'stopBenchAndResetBackend' }));
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
        stopAllInstances({ resetCount: true });
      } else if (data.type === 'stopBenchAndResetBackend') {
        stopAllInstances({ resetCount: true });
        restartJavaBackendForCleanBenchmark();
      } else if (data.type === 'startBench') {
        startBenchmarkInstances(data.jar, data.count | 0, data.spam | 0, ws).catch(e => {
          console.error('[BENCH-3001 ERR] startBenchmarkInstances:', e);
          try { ws.send(JSON.stringify({ type: 'error', error: e.message })); } catch(_) {}
        });
      }
    } catch(e) {}
  });
});

function stopAllInstances(options = {}) {
  isRunningBench = false;
  stressInstances.forEach(inst => {
    if (inst.spamTimer) clearInterval(inst.spamTimer);
    if (inst.frameTimer) clearInterval(inst.frameTimer);
    try { if (inst.ws) inst.ws.close(); } catch(e) {}
  });
  stressInstances = [];
  if (options.resetCount) lastRequestedCount = 0;
  console.log('[BENCH-3001] Đã dừng tất cả máy ảo benchmark.');
}

function restartJavaBackendForCleanBenchmark() {
  try {
    const oldProc = javaProc;
    if (oldProc && oldProc.exitCode === null) {
      console.log('[BENCH-3001] Restart JavaBackend để đo benchmark sạch / giải phóng RAM cũ...');
      oldProc.removeAllListeners('exit');
      try { oldProc.kill(); } catch(e) {}
      // Rất quan trọng: chỉ kill process cũ. Không dùng biến global javaProc trong timeout,
      // vì lúc đó javaProc có thể đã trỏ sang process JavaBackend mới.
      setTimeout(() => {
        try {
          if (oldProc.exitCode === null && !oldProc.killed) oldProc.kill('SIGKILL');
        } catch(e) {}
      }, 1500);
      javaProc = null;
    }
  } catch(e) {}
  lastCpuSample = null;
  benchBaseline = null;
  ensureJavaBackend();
}

const REQ_FRAME_CMD = Buffer.from([15, 0, 0, 0, 0]);

async function startBenchmarkInstances(jarPath, count, spamRate, clientWs) {
  stopAllInstances({ resetCount: true });
  // Quan trọng: nếu chạy nhiều đợt benchmark trong cùng JVM, Java có thể giữ heap/thread/buffer cũ,
  // khiến RAM cao dù activeInstances=0. Restart backend trước mỗi đợt để baseline sạch và đo delta đúng.
  restartJavaBackendForCleanBenchmark();
  isRunningBench = true;
  activeSpamRate = spamRate;
  count = Math.max(1, Math.min(1000, count));
  lastRequestedCount = count;

  jarPath = path.resolve(String(jarPath || DEFAULT_ROM));
  if (!fs.existsSync(jarPath)) throw new Error(`Không tìm thấy ROM/JAR: ${jarPath}`);

  ensureJavaBackend();
  console.log(`[BENCH-3001] Đợi JavaBackend sẵn sàng tại ws://127.0.0.1:${JAVA_WS_PORT} ...`);
  await waitForPort(JAVA_WS_PORT, '127.0.0.1', 20000);
  await new Promise(r => setTimeout(r, 500));
  benchBaseline = snapshotProcessMetricsOnly();
  console.log(`[BENCH-3001] Baseline JavaBackend: PID=${benchBaseline.javaPid}, RSS=${benchBaseline.javaRssMb} MB, Private=${benchBaseline.javaPrivateMb} MB, heap=${benchBaseline.jstatOk ? benchBaseline.javaHeapUsedMb + ' MB' : 'n/a'}`);
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
      const cfg = buildBackendConfig(jarPath, simUser);
      emuWs.send(JSON.stringify(cfg));

      // Bơm lệnh xin Frame định kỳ (~30 FPS) để máy ảo vẽ LCD
      instObj.frameTimer = setInterval(() => {
        if (!isRunningBench || emuWs.readyState !== WebSocket.OPEN) return;
        emuWs.send(REQ_FRAME_CMD, { binary: true });
      }, 33);

      // LƯU Ý: WebSocketMain không nhận keycode J2ME/Java như -5, -1, 48..57.
      // Gói cmd 2/3 giống testaccount.js cần "libretro button index" 0..19.
      // Gửi 48/49/50/51 hoặc -1/-2 sẽ làm JavaBackend ném
      // ArrayIndexOutOfBoundsException trong LibretroTimerTask.
      const randomKeys = [
        0, 1, 2, 3,        // Up, Down, Left, Right
        4, 5, 6, 7,        // 9, 7, 0, Fire/Enter
        8, 9,              // soft keys
        10, 11, 12, 13,    // 1, 3, *, #
        14, 15, 16, 17, 18 // 2, 4, 6, 8, 5
        // 19 = Escape/Back, không spam mặc định vì dễ thoát game/menu
      ];
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
    emuWs.on('error', (err) => {
      console.error(`[BENCH-3001 ERR] VM ${i} backend WS: ${err.message}`);
    });
  }
}

server.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`[BENCH-3001] Giao diện Benchmark Đa máy ảo đang chạy tại http://localhost:${HTTP_PORT}`);
});
