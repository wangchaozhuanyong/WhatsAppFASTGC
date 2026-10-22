/**
 * 将构建输出目录中的安装包与 latest.yml 复制到 publish/lan/（内网静态服根目录）。
 * 默认目录与 package.json 的 build.directories.output 一致（当前为 electron-pack-output，避免与易误开的 release-build 路径抢锁）。
 * 覆盖目录：FASTGC_RELEASE_DIR=my-out node scripts/stage-lan-update.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const releaseDir = path.resolve(
  root,
  process.env.FASTGC_RELEASE_DIR || pkg.build?.directories?.output || 'electron-pack-output',
);
const outDir = path.join(root, 'publish', 'lan');
const ver = String(pkg.version || '').trim();
const productName = String(pkg.build?.productName || 'FastGC WhatsApp');
const artifactTpl = String(
  pkg.build?.win?.artifactName || '${productName}-Setup-${version}.${ext}',
);
/** 与 electron-builder 的 ${productName} / ${version} / ${ext} 对齐，避免改 artifactName 后 staging 仍写死文件名 */
const setupName = artifactTpl
  .replace(/\$\{productName\}/g, productName)
  .replace(/\$\{version\}/g, ver)
  .replace(/\$\{ext\}/g, 'exe');

const ymlPath = path.join(releaseDir, 'latest.yml');
if (!fs.existsSync(ymlPath)) {
  console.error(`未找到 ${ymlPath}，请先执行: npm run dist:win`);
  process.exit(1);
}

const setupPath = path.join(releaseDir, setupName);
if (!fs.existsSync(setupPath)) {
  console.error(`未找到 ${setupPath}，请确认 package.json 的 version 与安装包一致。`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(ymlPath, path.join(outDir, 'latest.yml'));
fs.copyFileSync(setupPath, path.join(outDir, setupName));

const blockmap = setupPath + '.blockmap';
if (fs.existsSync(blockmap)) {
  fs.copyFileSync(blockmap, path.join(outDir, path.basename(blockmap)));
}

const abs = path.resolve(outDir);
console.log('');
console.log('已复制到:', abs);
console.log('请将整个目录内容放到内网 HTTP 根路径（或子路径），例如:');
console.log('  http://192.168.x.x/fastgc/  → 能打开 http://192.168.x.x/fastgc/latest.yml');
console.log('客户端在「管理与配置」中填更新地址（不要末尾多余斜杠外的错误路径）:');
console.log('  http://192.168.x.x/fastgc');
console.log('');
