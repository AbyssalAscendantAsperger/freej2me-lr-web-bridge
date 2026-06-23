#!/usr/bin/env node
/******************************************************************************
 * tools/integrate-fj2me-web.js
 *
 * Tự động patch freej2me-web (https://github.com/zb3/freej2me-web) để tích
 * hợp với Node.js bridge. Sau khi patch, freej2me-web sẽ có thêm:
 *   - Nút "☁ Bridge" trên mỗi game trong launcher (index.html).
 *   - Logic detect ?bridge=1&gameId=... trên run.html để stream frames từ
 *     Node.js bridge thay vì chạy qua CheerpJ WASM.
 *
 * Usage:
 *   node tools/integrate-fj2me-web.js <path-to-freej2me-web-dir> [--bridge-url=<url>] [--secret=<token>]
 *
 *   <path-to-freej2me-web-dir>: thư mục đã git clone freej2me-web.
 *     vd: node tools/integrate-fj2me-web.js ../freej2me-web
 *
 *   --bridge-url=<url>: URL của Node.js bridge server (vd: https://fj2me.example.com).
 *     Nếu bỏ qua, sẽ dùng cùng origin với freej2me-web.
 *
 *   --secret=<token>: Shared secret giống bridge.sharedSecret trong config.json.
 *     Nếu bridge không có shared secret thì bỏ qua.
 *
 *   --revert: gỡ bỏ patch đã apply (chỉ revert phần script tag và các thay đổi).
 *
 * Hoạt động:
 *   - Copy file public/fj2me-web-bridge-client.js vào <freej2me-web>/web/.
 *   - Patch <freej2me-web>/web/index.html: chèn <script> trước launcher.js.
 *   - Patch <freej2me-web>/web/run.html: chèn <script> trước main.js.
 *   - Tạo backup .bak cho mỗi file được patch.
 *
 * Không cần internet, không cần build lại freej2me-web. Sau khi patch, chỉ
 * cần serve thư mục web/ như bình thường (vd: `npx serve -u web`).
 *****************************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { positional: [], options: {} };
  argv.forEach((a) => {
    if (a.startsWith('--')) {
      const idx = a.indexOf('=');
      if (idx > 0) args.options[a.slice(2, idx)] = a.slice(idx + 1);
      else args.options[a.slice(2)] = true;
    } else {
      args.positional.push(a);
    }
  });
  return args;
}

function readIfExists(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }

function writeWithBackup(p, content) {
  const bak = p + '.bak';
  if (!fs.existsSync(bak) && fs.existsSync(p)) {
    fs.copyFileSync(p, bak);
    console.log('[backup] ' + bak);
  }
  fs.writeFileSync(p, content);
  console.log('[patched] ' + p);
}

function patchIndexHtml(webDir, bridgeUrl, secret) {
  const indexPath = path.join(webDir, 'index.html');
  let html = readIfExists(indexPath);
  if (!html) { console.warn('[skip] ' + indexPath + ' không tồn tại'); return false; }

  // Xoá script cũ nếu có (để idempotent).
  const tagRegex = /<script src="fj2me-web-bridge-client\.js"[^>]*><\/script>\s*/g;
  html = html.replace(tagRegex, '');

  const cfgLines = [
    '  <script>',
    '    window.FJ2ME_BRIDGE_CONFIG = ' + JSON.stringify({
      enabled: true,
      bridgeServerUrl: bridgeUrl || '',
      secretValue: secret || '',
    }) + ';',
    '  </script>',
    '  <script src="fj2me-web-bridge-client.js"></script>',
  ].join('\n');

  // Chèn trước <script type="module" src="src/launcher.js"></script>.
  const marker = '<script type="module" src="src/launcher.js"></script>';
  if (html.indexOf(marker) < 0) {
    console.warn('[warn] Không tìm thấy marker launcher.js trong index.html. Chèn trước </body>.');
    html = html.replace('</body>', cfgLines + '\n</body>');
  } else {
    html = html.replace(marker, cfgLines + '\n  ' + marker);
  }
  writeWithBackup(indexPath, html);
  return true;
}

function patchRunHtml(webDir, bridgeUrl, secret) {
  const runPath = path.join(webDir, 'run.html');
  let html = readIfExists(runPath);
  if (!html) { console.warn('[skip] ' + runPath + ' không tồn tại'); return false; }

  const tagRegex = /<script src="fj2me-web-bridge-client\.js"[^>]*><\/script>\s*/g;
  html = html.replace(tagRegex, '');

  const cfgLines = [
    '    <script>',
    '      window.FJ2ME_BRIDGE_CONFIG = ' + JSON.stringify({
      enabled: true,
      bridgeServerUrl: bridgeUrl || '',
      secretValue: secret || '',
    }) + ';',
    '    </script>',
    '    <script src="fj2me-web-bridge-client.js"></script>',
  ].join('\n');

  const marker = '<script type="module" src="src/main.js"></script>';
  if (html.indexOf(marker) < 0) {
    console.warn('[warn] Không tìm thấy marker main.js trong run.html. Chèn trước </body>.');
    html = html.replace('</body>', cfgLines + '\n</body>');
  } else {
    html = html.replace(marker, cfgLines + '\n    ' + marker);
  }
  writeWithBackup(runPath, html);
  return true;
}

function copyBridgeClient(webDir, bridgeRoot) {
  const src = path.join(bridgeRoot, 'public', 'fj2me-web-bridge-client.js');
  const dst = path.join(webDir, 'fj2me-web-bridge-client.js');
  if (!fs.existsSync(src)) {
    console.error('[error] Không tìm thấy ' + src);
    return false;
  }
  fs.copyFileSync(src, dst);
  console.log('[copied] ' + src + ' -> ' + dst);
  return true;
}

function revertPatch(webDir) {
  const restores = [
    path.join(webDir, 'index.html'),
    path.join(webDir, 'run.html'),
  ];
  restores.forEach((p) => {
    const bak = p + '.bak';
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, p);
      fs.unlinkSync(bak);
      console.log('[reverted] ' + p + ' (từ ' + bak + ')');
    } else {
      console.log('[skip] không có backup cho ' + p);
    }
  });
  const client = path.join(webDir, 'fj2me-web-bridge-client.js');
  if (fs.existsSync(client)) {
    fs.unlinkSync(client);
    console.log('[removed] ' + client);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args.positional.length < 1 && !args.options.revert) {
    console.log('Usage:');
    console.log('  node tools/integrate-fj2me-web.js <path-to-freej2me-web-dir> [--bridge-url=<url>] [--secret=<token>]');
    console.log('  node tools/integrate-fj2me-web.js <path-to-freej2me-web-dir> --revert');
    process.exit(1);
  }
  const webDir = path.resolve(args.positional[0]);
  const bridgeRoot = path.resolve(__dirname, '..');
  const bridgeUrl = args.options['bridge-url'] || args.options.bridgeUrl || '';
  const secret = args.options.secret || '';

  if (!fs.existsSync(webDir)) {
    console.error('[error] Thư mục không tồn tại: ' + webDir);
    process.exit(2);
  }

  // Verify đây là freej2me-web (có index.html + run.html + src/launcher.js hoặc src/main.js).
  const sanityOk = ['index.html', 'run.html'].every((f) => fs.existsSync(path.join(webDir, f)));
  if (!sanityOk) {
    console.error('[error] ' + webDir + ' không có vẻ là freej2me-web (thiếu index.html hoặc run.html).');
    process.exit(3);
  }

  if (args.options.revert) {
    revertPatch(webDir);
    return;
  }

  console.log('[info] Bridge root: ' + bridgeRoot);
  console.log('[info] freej2me-web dir: ' + webDir);
  console.log('[info] bridgeUrl: ' + (bridgeUrl || '(cùng origin)'));
  if (secret) console.log('[info] secret: (set)');
  else console.log('[info] secret: (none)');

  copyBridgeClient(webDir, bridgeRoot);
  patchIndexHtml(webDir, bridgeUrl, secret);
  patchRunHtml(webDir, bridgeUrl, secret);

  console.log('');
  console.log('=== Hoàn tất! ===');
  console.log('Bây giờ serve thư mục freej2me-web/web/ như bình thường (vd: cd web && npx serve -u).');
  console.log('Mở launcher sẽ thấy nút "☁ Bridge" trên mỗi game.');
  console.log('Khi ấn, JAR + settings được đẩy sang Node.js bridge, sau đó redirect sang run.html?app=<id>&bridge=1&gameId=<hash>.');
  console.log('Trên run.html, bridge stream frames vẽ trực tiếp lên canvas#display (CheerpJ WASM không cần chạy game đó).');
}

main();
