/**
 * 将 WhatsApp Web 发送翻译管线打成 IIFE JS 源码，供 build-renderer-ts 挂到 FastGcWaShared.__INLINE_WA_SEND_PIPELINE_JS__，
 * index.html 再与 WA_INJECT_TRANSLATE_CORE 拼成 executeJavaScript 字符串。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const outfile = path.join(root, 'generated', 'wa-send-pipeline-raw.js');

await fs.promises.mkdir(path.dirname(outfile), { recursive: true });

await esbuild.build({
  absWorkingDir: root,
  entryPoints: [path.join(root, 'src/wa/sendTranslatePipeline.webview.ts')],
  bundle: true,
  outfile,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  minify: false,
});

const len = (await fs.promises.stat(outfile)).size;
console.log('[build-wa-send-pipeline] wrote', path.relative(root, outfile), '(bytes=' + len + ')');
