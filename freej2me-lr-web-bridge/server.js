const { spawn } = require('child_process');
const path = require('path');

console.log('====================================================================');
console.log('🚀 FREEJ2ME-PLUS MASTER SUPERVISOR GATEWAY (CỔNG 3000 & 3001)');
console.log('====================================================================');
console.log('Đang khởi chạy các dịch vụ cầu nối giả lập...\n');

function startWorker(scriptFile, serviceName, colorCode) {
  const fullPath = path.join(__dirname, scriptFile);
  console.log(`${colorCode}[SUPERVISOR] Khởi tạo dịch vụ ${serviceName} (${scriptFile})...\x1b[0m`);

  const worker = spawn(process.execPath, [fullPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env }
  });

  worker.stdout.on('data', chunk => {
    chunk.toString('utf8').trim().split('\n').forEach(line => {
      if (line) console.log(`${colorCode}[${serviceName}]\x1b[0m ${line}`);
    });
  });

  worker.stderr.on('data', chunk => {
    chunk.toString('utf8').trim().split('\n').forEach(line => {
      if (line) console.error(`${colorCode}[${serviceName} ERR]\x1b[0m ${line}`);
    });
  });

  worker.on('exit', (code, signal) => {
    console.warn(`${colorCode}[SUPERVISOR] ${serviceName} thoát (code=${code}, signal=${signal}). Boot lại sau 3s...\x1b[0m`);
    setTimeout(() => startWorker(scriptFile, serviceName, colorCode), 3000);
  });
}

// Khởi chạy Máy chủ chơi game chính (TestAccount - Cổng 3000)
startWorker('testaccount.js', 'WEB-3000', '\x1b[36m'); // Cyan

// Khởi chạy Máy chủ Benchmark & Stress Test Đa máy ảo (Multi - Cổng 3001)
setTimeout(() => {
  startWorker('multi.js', 'BENCH-3001', '\x1b[33m'); // Yellow
}, 1500);

// Giữ tiến trình cha hoạt động
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
