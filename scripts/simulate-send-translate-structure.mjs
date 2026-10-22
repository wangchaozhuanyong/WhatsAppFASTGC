/**
 * 静态模拟：校验 index.html 拼接 + dist/fastgc-wa-shared.js 内联/WhatsApp Web 管线结构。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const bundlePath = path.join(root, 'dist', 'fastgc-wa-shared.js');
let bundle = '';
try {
  bundle = fs.readFileSync(bundlePath, 'utf8');
} catch {
  /* missing until ci runs build */
}
const fused = html + '\n' + bundle;

function assert(name, ok, detail = '') {
  if (!ok) {
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
    return false;
  }
  console.log(`OK: ${name}`);
  return true;
}

const need = [
  ['index：buildWaSendAutoTranslateHookScript', /function\s+buildWaSendAutoTranslateHookScript\s*\(/],
  ['index：拼接 __INLINE_WA_SEND_PIPELINE_JS__', /__INLINE_WA_SEND_PIPELINE_JS__/],
  ['bundle：已生成（请先 npm run build:wa-send-pipeline && npm run build:renderer-ts）', /.+/],
  ['bundle：管线版本 SEND_TRANSLATE_PIPELINE_VERSION', /SEND_TRANSLATE_PIPELINE_VERSION[^;]{0,240}send-translate/i],
  ['bundle：非阻断宿主事件 send-translate-notify', /send-translate-notify/],
  ['bundle：延迟二次校验防回滚', /verifyInputStableAfterDeferredMs/],
  ['bundle：发送独占门闩', /__fastgcWaSendExclusiveGate/],
  ['bundle：写入期硬锁 writeComposerLock', /__fastgcWriteComposerLock/],
  ['bundle：门闩看门超时（watchdog）', /armWaSendExclusiveWatchdogFallback|EXCLUSIVE_WATCHDOG_MS|__fastgcWaSendExclusiveWatchdogId/s],
  ['bundle：双层 composer 校验', /verifyComposerLayersStable/],
  ['bundle：发送调试钩子 fgSendDbg', /function fgSendDbg/],
  ['bundle：发送后防抖重试点火', /fireWaDomDispatchOnce/],
  ['bundle：Enter 路由 routeComposerSendIntent（WebView bundle 不保留未引用的 sendPipeline）', /routeComposerSendIntent/],
  ['bundle：writeTextToWhatsAppInput', /writeTextToWhatsAppInput/],
  ['bundle：WPP setInputText 优先写入', /tryWriteComposerViaWpp/],
  ['bundle：失败回退原文 Composer', /restoreOriginalToComposer/],
  /** LRU 内存缓存（WA_INJECT_TRANSLATE_CORE 防误删） */
  ['index：fastgcLocalTransCache Map', /fastgcLocalTransCache/],
  ['index：translateTextFastgcDetailed 异步入口', /translateTextFastgcDetailed\s*=\s*async/],
];

for (const [label, re] of need) {
  const hay = label.startsWith('index：')
    ? html
    : label.startsWith('bundle：')
      ? bundle
      : fused;
  assert(label, re.test(hay), `未匹配 ${re}`);
}

if (process.exitCode) {
  console.error('\n发送翻译结构检测未通过（若缺 bundle，请先 npm run ci / build）。');
  process.exit(1);
}

console.log('\n说明：以上为静态结构检测；详见 src/wa/sendTranslatePipeline.ts。');
console.log('全部发送翻译结构断言通过。\n');
