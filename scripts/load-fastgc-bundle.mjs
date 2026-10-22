/**
 * 同步加载 dist/fastgc-wa-shared.js，得到与 index.html / TypeScript 同源的 FastGcWaShared。
 * Node 脚本（模拟测试等）应由此消费，勿再复制 normalizeWaChatKey/normalizePhone。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const defaultProjRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} [projRoot] */
export function loadFastGcWaShared(projRoot = defaultProjRoot) {
  const bundlePath = path.join(projRoot, 'dist', 'fastgc-wa-shared.js');

  if (!fs.existsSync(bundlePath)) {
    console.error('[load-fastgc-bundle] 缺少 dist/fastgc-wa-shared.js，正在 npm run build:renderer-ts …');
    const r = spawnSync('npm', ['run', 'build:renderer-ts'], {
      cwd: projRoot,
      shell: true,
      stdio: 'inherit',
    });
    if (r.status !== 0 || !fs.existsSync(bundlePath)) {
      throw new Error('[load-fastgc-bundle] 仍无法加载 bundle，请先手动执行 npm run build:renderer-ts');
    }
  }

  const code = fs.readFileSync(bundlePath, 'utf8');
  try {
    const mod = new Function(`${code}\nreturn typeof FastGcWaShared !== 'undefined' ? FastGcWaShared : null;`)();
    if (!mod || typeof mod.normalizeWaChatKey !== 'function') {
      throw new Error('bundle 未导出有效的 FastGcWaShared');
    }
    return mod;
  } catch (e) {
    throw new Error(`[load-fastgc-bundle] 解析 bundle 失败: ${e.message || e}`);
  }
}
