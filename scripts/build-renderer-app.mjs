import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Babel from '@babel/standalone';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const marker = '<script type="text/babel">';
const start = html.indexOf(marker);
const end = html.indexOf('</script>', start);
if (start < 0 || end < 0) throw new Error('Renderer source script missing');
const source = html.slice(start + marker.length, end);
// Preserve the existing standalone env+react transform semantics, including var hoisting.
const compiled = Babel.transform(source, { presets: ['env', 'react'], sourceType: 'script', comments: false, compact: true, filename: 'renderer-app.jsx' }).code;
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.mkdirSync(path.join(root, 'generated/renderer'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/renderer-app.js'), compiled);
html = html.slice(0, start) + '<script src="./dist/renderer-app.js"></script>' + html.slice(end + '</script>'.length);
html = html.replace(/\s*<script src="\.\/node_modules\/@babel\/standalone\/babel\.min\.js"><\/script>/, '');
const hashes = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
  .filter(match => !/\bsrc\s*=/.test(match[1]))
  .map(match => "'sha256-" + crypto.createHash('sha256').update(match[2]).digest('base64') + "'");
const policy = ["default-src 'self'", "script-src 'self' " + hashes.join(' '), "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https:", "font-src 'self' data:", "connect-src 'self' https://translate.googleapis.com https://translate.google.com", "frame-src https://web.whatsapp.com", "object-src 'none'", "base-uri 'none'", "form-action 'none'"].join('; ');
html = html.replace('<meta charset="UTF-8">', '<meta charset="UTF-8">\n    <meta http-equiv="Content-Security-Policy" content="' + policy + '">');
fs.writeFileSync(path.join(root, 'generated/production-index.html'), html);
fs.writeFileSync(path.join(root, 'generated/renderer/index.html'), html);
console.log('[build-renderer-app] compiled JSX and generated production HTML with CSP');
