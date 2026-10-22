import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const baseDir = path.join(root, 'publish', 'lan');
const port = Number(process.env.FASTGC_UPDATE_PORT || 9330);
const host = process.env.FASTGC_UPDATE_HOST || '0.0.0.0';

const MIME = {
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.blockmap': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    Connection: 'close',
  });
  res.end(body);
}

function safeResolve(urlPath) {
  const pathname = decodeURIComponent((urlPath || '/').split('?')[0]).replace(/\\/g, '/');
  const clean = pathname === '/' ? '/latest.yml' : pathname;
  const abs = path.resolve(baseDir, `.${clean}`);
  if (!abs.startsWith(baseDir)) return null;
  return abs;
}

const server = http.createServer((req, res) => {
  const abs = safeResolve(req.url || '/');
  if (!abs) {
    send(res, 403, 'Forbidden');
    return;
  }
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    send(res, 404, 'Not Found');
    return;
  }
  const ext = path.extname(abs).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': fs.statSync(abs).size,
    'Cache-Control': ext === '.exe' ? 'public, max-age=60' : 'no-cache',
    Connection: 'close',
  });
  fs.createReadStream(abs).pipe(res);
});

server.listen(port, host, () => {
  console.log(`[fastgc-update] serving ${baseDir}`);
  console.log(`[fastgc-update] listening http://${host}:${port}`);
});

server.on('error', (err) => {
  console.error('[fastgc-update] server error:', err && err.message ? err.message : err);
  process.exit(1);
});
