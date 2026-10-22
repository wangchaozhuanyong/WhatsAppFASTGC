/**
 * 宿主桥接一致性：静态校验 preload / 翻译 webview preload 里 ipcRenderer.invoke
 * 的 channel 在 main.js 均有 ipcMain.handle；index.html 中出现的 window.fastgcBridge.*
 * 均在 preload 暴露的方法集合内。
 *
 * 说明：无法替代真实 Electron + 已登录 WA 的端到端；用于防止改名漏接 handler。
 *
 * 运行: node scripts/simulate-host-bridge.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

/** @param {string} text */
function extractInvokeChannels(text) {
  const channels = new Set();
  const re = /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(text))) channels.add(m[1]);
  return channels;
}

/** @param {string} mainText */
function extractMainHandlers(mainText) {
  const channels = new Set();
  const re = /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(mainText))) channels.add(m[1]);
  return channels;
}

/**
 * 取出 fastgcBridge 对象体（首层花括号内），用于解析暴露的方法名。
 * @param {string} preloadText
 */
function extractFastgcBridgeObjectBody(preloadText) {
  const marker = /exposeInMainWorld\(\s*['"]fastgcBridge['"]\s*,/;
  const mm = preloadText.match(marker);
  if (!mm || mm.index === undefined) return null;
  let i = mm.index + mm[0].length;
  while (i < preloadText.length && /\s/.test(preloadText[i])) i++;
  if (preloadText[i] !== '{') return null;
  let depth = 0;
  const start = i;
  for (; i < preloadText.length; i++) {
    const c = preloadText[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return preloadText.slice(start + 1, i);
    }
  }
  return null;
}

/** @param {string} bridgeBody */
function extractExposedMethodNames(bridgeBody) {
  const names = new Set();
  const re = /^\s*([a-zA-Z0-9_]+)\s*\([^)]*\)\s*\{/gm;
  let m;
  while ((m = re.exec(bridgeBody))) names.add(m[1]);
  return names;
}

/** @param {string} htmlText */
function extractIndexFastgcBridgeCalls(htmlText) {
  const names = new Set();
  const re = /window\.fastgcBridge\.([a-zA-Z0-9_]+)/g;
  let m;
  while ((m = re.exec(htmlText))) names.add(m[1]);
  return names;
}

function main() {
  const preload = read('preload.js');
  const translatePreload = read('webview-translate-preload.js');
  const mainJs = read('main.js');
  const indexHtml = read('index.html');

  const handlers = extractMainHandlers(mainJs);
  const fromPreload = extractInvokeChannels(preload);
  const fromTranslate = extractInvokeChannels(translatePreload);

  const missingPreload = [...fromPreload].filter((c) => !handlers.has(c));
  const missingTranslate = [...fromTranslate].filter((c) => !handlers.has(c));

  if (missingPreload.length || missingTranslate.length) {
    console.error('— simulate-host-bridge: FAIL —');
    if (missingPreload.length) {
      console.error('preload invoke 缺少 main handler:', missingPreload.join(', '));
    }
    if (missingTranslate.length) {
      console.error('webview-translate-preload invoke 缺少 main handler:', missingTranslate.join(', '));
    }
    process.exit(1);
  }

  const bridgeBody = extractFastgcBridgeObjectBody(preload);
  if (!bridgeBody) {
    console.error('FAIL: 无法在 preload.js 中解析 fastgcBridge 对象体');
    process.exit(1);
  }
  const exposed = extractExposedMethodNames(bridgeBody);
  const indexCalls = extractIndexFastgcBridgeCalls(indexHtml);
  const unknownOnIndex = [...indexCalls].filter((n) => !exposed.has(n));

  if (unknownOnIndex.length) {
    console.error('— simulate-host-bridge: FAIL —');
    console.error('index.html 调用了 preload 未暴露的 fastgcBridge 方法:', unknownOnIndex.join(', '));
    process.exit(1);
  }

  console.log('— simulate-host-bridge: OK —');
  console.log(`main handlers: ${handlers.size} 个 channel`);
  console.log(`preload invoke: ${[...fromPreload].join(', ')}`);
  console.log(`translate preload invoke: ${[...fromTranslate].join(', ')}`);
  console.log(`index.html fastgcBridge 调用: ${[...indexCalls].join(', ') || '(无)'}`);
}

main();
