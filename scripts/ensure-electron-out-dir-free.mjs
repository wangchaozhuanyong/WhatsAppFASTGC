/**
 * 在 electron-builder 开始前尽量释放对 win-unpacked（尤其 resources/app.asar）的占用，
 * 避免 Windows 上反复出现 EBUSY /「被另一进程使用」导致打包失败。
 *
 * - 从 package.json 读取 build.directories.output（与 electron-builder 一致）
 * - Windows：结束 productName 对应的 .exe（默认 FastGC WhatsApp.exe）
 * - 删除 <output>/win-unpacked（带重试；支持 Node 的 maxRetries/retryDelay）
 * - 设置 FASTGC_SKIP_PACK_KILL=1 可跳过结束进程（仍尝试删目录）
 *
 * 用法：npm run ensure:win-pack-output-free 或 node scripts/ensure-electron-out-dir-free.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readBuilderOutputDir() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return String(pkg.build?.directories?.output || 'electron-pack-output').replace(/\\/g, '/');
}

function killPackBlockersOnWindows(exeName) {
  if (process.platform !== 'win32') return;
  spawnSync('taskkill', ['/F', '/T', '/IM', exeName], { stdio: 'ignore', windowsHide: true });
}

function rmWinUnpackedOnce(abs) {
  const busy = { recursive: true, force: true, maxRetries: 12, retryDelay: 280 };
  try {
    fs.rmSync(abs, busy);
  } catch (_) {
    fs.rmSync(abs, { recursive: true, force: true });
  }
}

async function main() {
  const outRel = readBuilderOutputDir();
  const outAbs = path.join(root, outRel);
  const winUnpacked = path.join(outAbs, 'win-unpacked');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const productName = String(pkg.build?.productName || 'FastGC WhatsApp');
  const exeName = `${productName}.exe`;

  if (!fs.existsSync(winUnpacked)) {
    console.log(`[ensure-electron-out-dir-free] 无占用目标: ${winUnpacked}`);
    return;
  }

  if (process.env.FASTGC_SKIP_PACK_KILL === '1') {
    console.log('[ensure-electron-out-dir-free] FASTGC_SKIP_PACK_KILL=1，跳过结束进程');
  } else if (process.platform === 'win32') {
    console.log(`[ensure-electron-out-dir-free] 尝试结束可能占用 asar 的进程: ${exeName}`);
    killPackBlockersOnWindows(exeName);
    await sleep(450);
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      rmWinUnpackedOnce(winUnpacked);
      console.log(`[ensure-electron-out-dir-free] 已删除: ${winUnpacked}`);
      return;
    } catch (e) {
      const msg = e?.message || String(e);
      if (attempt === 7) {
        console.error(
          `[ensure-electron-out-dir-free] 无法删除 ${winUnpacked}（已重试）。请关闭「${productName}」或从该目录启动的实例后重试。\n${msg}`,
        );
        process.exit(1);
      }
      if (process.platform === 'win32' && process.env.FASTGC_SKIP_PACK_KILL !== '1') {
        killPackBlockersOnWindows(exeName);
      }
      await sleep(500 + attempt * 250);
    }
  }
}

await main();
