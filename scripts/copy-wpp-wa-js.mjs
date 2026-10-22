/**
 * 将 @wppconnect/wa-js 官方打包产物复制到 dist/，供主进程读入后注入 WhatsApp WebView（与 wa-js 仓库用法一致）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchWaJsForCurrentWhatsApp } from './wa-js-compat.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const src = path.join(root, 'node_modules', '@wppconnect', 'wa-js', 'dist', 'wppconnect-wa.js');
const dest = path.join(root, 'dist', 'wppconnect-wa.js');

if (!fs.existsSync(src)) {
  console.error('[copy-wpp-wa-js] missing:', src);
  console.error('[copy-wpp-wa-js] run: npm install @wppconnect/wa-js');
  process.exit(1);
}
fs.mkdirSync(path.dirname(dest), { recursive: true });
// 保留官方文件；只对即将打包的副本应用经过回归检查的兼容保护。
const compatibleBundle = patchWaJsForCurrentWhatsApp(fs.readFileSync(src, 'utf8'));
fs.writeFileSync(dest, compatibleBundle, 'utf8');
console.log('[copy-wpp-wa-js] wrote', dest, 'bytes=', fs.statSync(dest).size);
