/**
 * 诊断页「清理缓存」接线校验：IPC / preload / index 中 localStorage 与 cleanupTranslateUi 委托。
 * 主进程文件级清理由 `npm run test:smoke-diagnostics`（Electron）验证。
 *
 * 运行: node scripts/verify-diagnostics-cleanup.mjs
 * CI / 无显示环境: node scripts/verify-diagnostics-cleanup.mjs --skip-electron-smoke
 * 仅主进程清理冒烟: node scripts/verify-diagnostics-cleanup.mjs --electron-smoke-only
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function fail(msg) {
  console.error('— verify-diagnostics-cleanup: FAIL —', msg);
  process.exit(1);
}

/** 通过 FASTGC_SMOKE_DIAG_MARKER 文件与退出码判定（Windows 下 stdout 可能不可见） */
function runElectronDiagSmoke(projectRoot) {
  const electronBin =
    process.platform === 'win32'
      ? path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
      : path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron');
  if (!fs.existsSync(electronBin)) {
    console.warn('— verify-diagnostics-cleanup: 跳过 smoke（未找到 electron 二进制），请先 npm ci');
    return;
  }
  const marker = path.join(os.tmpdir(), `fastgc-smoke-diag-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  try {
    if (fs.existsSync(marker)) fs.unlinkSync(marker);
  } catch (_) {}

  const r = spawnSync(electronBin, ['.', '--smoke-diagnostics-exit'], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, FASTGC_SMOKE_DIAG_MARKER: marker },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
  let body = '';
  try {
    body = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '';
  } catch (_) {}

  if (r.status === 2 || body === 'LOCK_HELD') {
    fail('Electron smoke 未运行：已有实例占用单实例锁，请先关闭本应用后再试');
  }
  if (r.status !== 0) {
    if (out) console.error(out);
    fail(`Electron smoke 退出码 ${r.status}${body ? `，marker: ${body}` : ''}`);
  }
  if (body !== 'OK') {
    if (out) console.error(out);
    fail(`Electron smoke marker 异常: ${body || '(无文件)'}`);
  }
  console.log('— verify-diagnostics-cleanup: smoke OK —');
}

function main() {
  const smokeOnly = process.argv.includes('--electron-smoke-only');
  const skipSmoke =
    process.argv.includes('--skip-electron-smoke') ||
    process.env.SKIP_ELECTRON_SMOKE === '1' ||
    process.env.CI === 'true';

  if (smokeOnly) {
    runElectronDiagSmoke(root);
    return;
  }

  const mainJs = read('main.js');
  const preload = read('preload.js');
  const indexHtml = read('index.html');

  if (!/ipcMain\.handle\(\s*['"]app:clear-translate-cache['"]/.test(mainJs)) {
    fail('main.js 缺少 app:clear-translate-cache handler');
  }
  if (!/clearFastgcTranslateCaches\s*\(\s*\)/.test(mainJs)) {
    fail('main.js 未调用 clearFastgcTranslateCaches');
  }
  if (!/ipcMain\.handle\(\s*['"]app:get-diagnostics-snapshot['"]/.test(mainJs)) {
    fail('main.js 缺少 app:get-diagnostics-snapshot handler');
  }

  if (!/invoke\(\s*['"]app:clear-translate-cache['"]/.test(preload)) {
    fail('preload 未 invoke app:clear-translate-cache');
  }
  if (!/clearTranslateCache\s*\(/.test(preload)) {
    fail('preload 未暴露 clearTranslateCache');
  }

  const diagStart = indexHtml.indexOf('diagnosticsProps={{');
  if (diagStart < 0) fail('index.html 缺少 diagnosticsProps');
  const diagBlock = indexHtml.slice(diagStart, diagStart + 4000);
  if (!/onCleanupTranslateUiActiveSeat:\s*\(\)\s*=>\s*cleanupTranslateUi/.test(diagBlock)) {
    fail('diagnosticsProps 未委托 cleanupTranslateUi');
  }

  const mustHave = [
    'GLOBAL_INBOX_KEY',
    'GLOBAL_INBOX_VIEW_KEY',
    'GLOBAL_INBOX_HIDDEN_MERGE_KEYS_KEY',
    'fastgc_global_inbox_order',
    'WA_PHONE_CHATKEY_CACHE_KEY',
    'WA_PHONE_VERIFIED_AT_KEY',
    'WA_DRAWER_PHONE_DONE_KEY',
    'WA_DRAWER_TRUTH_MAP_KEY',
    'appStorage.removeItem',
    'setGlobalInbox',
    'writeCachedInbox',
  ];
  for (const s of mustHave) {
    if (!diagBlock.includes(s)) fail(`diagnosticsProps 块缺少片段: ${s}`);
  }

  if (!/getDiagnosticsSnapshot\s*\(/.test(indexHtml) || !/clearTranslateCache\s*\(/.test(indexHtml)) {
    fail('index.html 未调用 getDiagnosticsSnapshot / clearTranslateCache');
  }

  console.log('— verify-diagnostics-cleanup: static OK —');

  if (skipSmoke) {
    console.log('（跳过 Electron smoke：使用 --skip-electron-smoke 或环境变量）');
    return;
  }

  runElectronDiagSmoke(root);
}

main();
