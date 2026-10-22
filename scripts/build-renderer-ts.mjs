/**
 * 将 src/renderer-entry.ts 打包为 index.html 可同步加载的 IIFE（全局 FastGcWaShared）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projRoot = path.resolve(scriptDir, '..');
const outDir = path.join(projRoot, 'dist');
const outfile = path.join(outDir, 'fastgc-wa-shared.js');

await fs.promises.mkdir(outDir, { recursive: true });

const pipelinePath = path.join(projRoot, 'generated', 'wa-send-pipeline-raw.js');
let pipelineJs = '';
try {
  pipelineJs = await fs.promises.readFile(pipelinePath, 'utf8');
} catch {
  console.warn(
    '[build-renderer-ts] 未找到 generated/wa-send-pipeline-raw.js，请先 npm run build:wa-send-pipeline',
  );
}

await esbuild.build({
  absWorkingDir: projRoot,
  entryPoints: [path.join(projRoot, 'src/renderer-entry.ts')],
  bundle: true,
  outfile,
  format: 'iife',
  globalName: 'FastGcWaShared',
  platform: 'browser',
  target: ['es2020'],
});

if (pipelineJs.length > 0) {
  let src = await fs.promises.readFile(outfile, 'utf8');
  const stripRe = /\n?;FastGcWaShared\.__INLINE_WA_SEND_PIPELINE_JS__=[\s\S]*$/;
  src = src.replace(stripRe, '');
  src +=
    '\n;FastGcWaShared.__INLINE_WA_SEND_PIPELINE_JS__=' +
    JSON.stringify(pipelineJs.endsWith('\n') ? pipelineJs : pipelineJs + '\n') +
    ';';
  await fs.promises.writeFile(outfile, src, 'utf8');
}

console.log('[build-renderer-ts] wrote', outfile);
