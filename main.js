const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeImage, safeStorage, session, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { createCloudTranslation } = require('./cloud-translation');
const { validateDataTarget, migrateDataRootSync } = require('./data-root-migration');
const { armWindowsShutdownGuard } = require('./shutdown-guard');
const { drainSessionsForExit } = require('./shutdown-flow');

/** 与 package.json build.appId 一致：任务栏分组、快捷方式关联、单实例锁 */
const APP_ID = 'com.fastgc.whatsapp.shell';
/** 须在单实例锁之前定义：第二实例分支会读取界面语言文件 */
const UI_LOCALE_FILE = 'fastgc_ui_locale.txt';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  if (process.argv.includes('--smoke-diagnostics-exit')) {
    const m = process.env.FASTGC_SMOKE_DIAG_MARKER;
    if (m) {
      try {
        fs.writeFileSync(m, 'LOCK_HELD\n', 'utf8');
      } catch (_) {}
    }
    process.exit(2);
  }
  /** 第二进程：给用户可见说明，避免误以为双击无反应 */
  let secondInstLocale = 'zh';
  try {
    const p = path.join(app.getPath('userData'), UI_LOCALE_FILE);
    if (fs.existsSync(p) && fs.readFileSync(p, 'utf8').trim().toLowerCase() === 'en') secondInstLocale = 'en';
  } catch (_) {}
  try {
    if (secondInstLocale === 'en') {
      dialog.showMessageBoxSync({
        type: 'info',
        title: 'FastGC WhatsApp',
        message: 'The application is already running. Switch to the existing window.',
        buttons: ['OK'],
      });
    } else {
      dialog.showMessageBoxSync({
        type: 'info',
        title: 'FastGC WhatsApp',
        message: '程序已在运行，请使用已打开的窗口。',
        buttons: ['确定'],
      });
    }
  } catch (_) {}
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID);
}

const ACCESS_CONTROL_FILE = 'fastgc_access_control.json';
const BOOTSTRAP_CONFIG_FILE = 'fastgc_bootstrap_config.json';
const UPDATE_FEED_FILE = 'fastgc_update_feed.json';

const SEAT_CONFIG_FILE = 'fastgc_seat_config.json';
const APP_STORAGE_DB_FILE = 'fastgc_app_data.sqlite';
const SQLITE_MIGRATION_MARK_KEY = '__fastgc_sqlite_migration_v1__';
const SQLITE_MIGRATION_TRACKED_KEYS = [
  'fastgc_global_inbox',
  'content_manager_data',
  'reward_phone_system_data',
  'fastgc_custom_links',
];
const UPDATE_FEED_EDIT_ENV = 'FASTGC_ALLOW_UPDATE_FEED_EDIT';
const DIAGNOSTIC_LOG_FILE = 'fastgc-diagnostics.log';
const DIAGNOSTIC_LOG_MAX_BYTES = 512 * 1024;
const RENDER_RECOVERY_WINDOW_MS = 5 * 60 * 1000;
const RENDER_RECOVERY_MAX_ATTEMPTS = 2;

let updateListenersAttached = false;
let taskbarUnreadCount = 0;
let storageDb = null;
let storageDbReady = false;

function storageDbPath() {
  return path.join(app.getPath('userData'), APP_STORAGE_DB_FILE);
}

function getStorageDb() {
  if (storageDbReady) return storageDb;
  storageDbReady = true;
  try {
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(path.dirname(storageDbPath()), { recursive: true });
    const db = new DatabaseSync(storageDbPath());
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 3000;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    storageDb = db;
  } catch (error) {
    storageDb = null;
    writeDiagnosticLog('storage-open-failed', { message: String(error.message || error) });
  }
  return storageDb;
}

function storageSet(key, value) {
  const db = getStorageDb();
  if (!db) return false;
  try {
    const stmt = db.prepare(
      `INSERT INTO app_kv (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    );
    stmt.run(String(key || '').trim(), String(value == null ? '' : value), Date.now());
    return true;
  } catch (_) {
    return false;
  }
}

function storageGet(key) {
  const db = getStorageDb();
  if (!db) return '';
  try {
    const row = db.prepare('SELECT value FROM app_kv WHERE key = ?').get(String(key || '').trim());
    return row && typeof row.value === 'string' ? row.value : '';
  } catch (_) {
    return '';
  }
}

function normalizeTaskbarUnreadCount(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function diagnosticLogPath() {
  try {
    return path.join(app.getPath('userData'), DIAGNOSTIC_LOG_FILE);
  } catch (_) {
    return path.join(os.tmpdir(), DIAGNOSTIC_LOG_FILE);
  }
}

function trimDiagnosticLogIfNeeded(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (!stat || stat.size <= DIAGNOSTIC_LOG_MAX_BYTES) return;
    const raw = fs.readFileSync(filePath, 'utf8');
    const keep = raw.slice(Math.max(0, raw.length - Math.floor(DIAGNOSTIC_LOG_MAX_BYTES * 0.75)));
    fs.writeFileSync(filePath, keep, 'utf8');
  } catch (_) {}
}

function writeDiagnosticLog(event, payload = {}) {
  try {
    const file = diagnosticLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    trimDiagnosticLogIfNeeded(file);
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        event: String(event || 'event'),
        version: app.getVersion ? app.getVersion() : '',
        packaged: Boolean(app.isPackaged),
        platform: process.platform,
        payload,
      }) + '\n';
    fs.appendFileSync(file, line, 'utf8');
  } catch (_) {}
}

process.on('uncaughtException', (err) => {
  writeDiagnosticLog('main-uncaught-exception', {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : '',
  });
});

process.on('unhandledRejection', (reason) => {
  writeDiagnosticLog('main-unhandled-rejection', {
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : '',
  });
});

/** 安装版走 app.isPackaged；从项目目录 / 启动.bat 调 electron 时提示用户改用安装包快捷方式 */
function maybeWarnNonPackagedStart() {
  if (app.isPackaged) return;
  if (String(process.env.FASTGC_ALLOW_DEV_START || '').trim() === '1') return;
  const batPath = path.join(__dirname, '启动.bat');
  if (!fs.existsSync(batPath)) return;
  const execLower = String(process.execPath || '').toLowerCase();
  const looksLikeBundledElectron =
    execLower.includes(`${path.sep}electron${path.sep}dist${path.sep}electron.exe`) ||
    execLower.includes(`${path.sep}node_modules${path.sep}electron${path.sep}`);
  if (!looksLikeBundledElectron && !execLower.endsWith('electron.exe')) return;
  try {
    const res = dialog.showMessageBoxSync({
      type: 'warning',
      title: '请使用安装版启动',
      message:
        '检测到当前是从开发目录或「启动.bat」启动，可能出现黑屏或依赖本机 Node/npm。\n\n正式使用请运行安装后的程序（npm run dist:win 生成的 Setup.exe），并用桌面快捷方式打开。',
      detail: '开发人员可在启动.bat 中设置 FASTGC_ALLOW_DEV_START=1，或设置同名环境变量后跳过此提示。',
      buttons: ['退出', '仍要继续'],
      defaultId: 0,
      cancelId: 0,
    });
    if (res === 0) {
      app.quit();
      process.exit(0);
    }
  } catch (_) {}
}

function bootstrapConfigPath() {
  return path.join(app.getPath('appData'), BOOTSTRAP_CONFIG_FILE);
}

function normalizeDataRoot(rawPath) {
  const p = String(rawPath || '').trim();
  if (!p) return '';
  try {
    return path.resolve(p);
  } catch (_) {
    return '';
  }
}

function readBootstrapConfigSync() {
  try {
    const p = bootstrapConfigPath();
    if (!fs.existsSync(p)) return { dataRoot: '' };
    const raw = JSON.parse(fs.readFileSync(p, 'utf8') || '{}');
    return { dataRoot: normalizeDataRoot(raw.dataRoot), pendingDataRoot: normalizeDataRoot(raw.pendingDataRoot) };
  } catch (_) {
    return { dataRoot: '' };
  }
}

function writeBootstrapConfigSync(payload = {}) {
  const dataRoot = normalizeDataRoot(payload.dataRoot);
  const data = { dataRoot, pendingDataRoot: normalizeDataRoot(payload.pendingDataRoot) };
  try {
    fs.writeFileSync(bootstrapConfigPath(), JSON.stringify(data, null, 2), 'utf8');
    if (fs.readFileSync(bootstrapConfigPath(), 'utf8') !== JSON.stringify(data, null, 2)) throw new Error('BOOTSTRAP_VERIFY_FAILED');
  } catch (error) { return { ok: false, error: String(error.message || error) }; }
  return { ok: true, ...data };
}

let bootstrapConfig = readBootstrapConfigSync();
let dataMigrationError = '';
if (bootstrapConfig.pendingDataRoot) {
  try {
    const source = bootstrapConfig.dataRoot ? path.join(bootstrapConfig.dataRoot, 'fastgc-whatsapp-userdata') : app.getPath('userData');
    migrateDataRootSync(source, path.join(bootstrapConfig.pendingDataRoot, 'fastgc-whatsapp-userdata'));
    const saved = writeBootstrapConfigSync({ dataRoot: bootstrapConfig.pendingDataRoot });
    if (!saved.ok) throw new Error(saved.error);
    bootstrapConfig = saved;
  } catch (error) {
    dataMigrationError = String(error.message || error);
    writeBootstrapConfigSync({ dataRoot: bootstrapConfig.dataRoot });
  }
}
if (bootstrapConfig.dataRoot) {
  try {
    fs.mkdirSync(bootstrapConfig.dataRoot, { recursive: true });
    app.setPath('userData', path.join(bootstrapConfig.dataRoot, 'fastgc-whatsapp-userdata'));
  } catch (_) {}
}

const cloudTranslation = createCloudTranslation({ userDataDir: () => app.getPath('userData'), safeStorage, fetchImpl: (...args) => fetch(...args) });

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

/** 忽略首尾空白与多余空格，重复句子与略有间距差异可共用缓存 */
function normalizeTextForTranslateCache(raw) {
  return String(raw || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 译文 LRU：同一原文+语种重复发送时零网络延迟 */
const FASTGC_TRANSLATE_CACHE_MAX = 600;
const fastgcTranslateLru = new Map();
/** 译文持久化缓存（跨重启），上限更高但仅用于减少网络；内存 LRU 仍优先 */
const FASTGC_TRANSLATE_PERSIST_MAX = 4000;
const FASTGC_TRANSLATE_PERSIST_FILE = 'fastgc-translate-cache.json';
let fastgcTranslatePersistLoaded = false;
let fastgcTranslatePersistWriteTimer = null;
let fastgcTranslatePersistDirty = false;
/** key -> { text: string, lastHitAt: number } */
const fastgcTranslatePersistMap = new Map();

function fastgcTranslatePersistPath() {
  try {
    return path.join(app.getPath('userData'), FASTGC_TRANSLATE_PERSIST_FILE);
  } catch (_) {
    return '';
  }
}

function fastgcTranslatePersistLoadOnce() {
  if (fastgcTranslatePersistLoaded) return;
  fastgcTranslatePersistLoaded = true;
  const p = fastgcTranslatePersistPath();
  if (!p) return;
  try {
    if (!fs.existsSync(p)) return;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8') || '{}');
    const entries = Array.isArray(raw.entries) ? raw.entries : [];
    for (const it of entries) {
      if (!Array.isArray(it) || it.length < 2) continue;
      const k = String(it[0] || '');
      const v = String(it[1] || '');
      const at = Number(it[2] || 0);
      if (!k || !v) continue;
      fastgcTranslatePersistMap.set(k, { text: v, lastHitAt: Number.isFinite(at) ? at : 0 });
    }
  } catch (_) {}
}

function fastgcTranslatePersistScheduleWrite() {
  if (fastgcTranslatePersistWriteTimer) return;
  fastgcTranslatePersistWriteTimer = setTimeout(() => {
    fastgcTranslatePersistWriteTimer = null;
    if (!fastgcTranslatePersistDirty) return;
    fastgcTranslatePersistDirty = false;
    const p = fastgcTranslatePersistPath();
    if (!p) return;
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const arr = Array.from(fastgcTranslatePersistMap.entries())
        .sort((a, b) => (Number(b[1]?.lastHitAt || 0) - Number(a[1]?.lastHitAt || 0)))
        .slice(0, FASTGC_TRANSLATE_PERSIST_MAX)
        .map(([k, v]) => [k, String(v.text || ''), Number(v.lastHitAt || 0)]);
      fs.writeFileSync(p, JSON.stringify({ v: 1, entries: arr }, null, 0), 'utf8');
    } catch (_) {}
  }, 1200);
}

function fastgcTranslateCacheKey(sourceLang, targetLang, normalizedText) {
  return `${String(sourceLang || 'auto')}\t${String(targetLang || 'en')}\t${sha256(normalizedText)}`;
}

function fastgcTranslateCacheGet(key) {
  const v = fastgcTranslateLru.get(key);
  if (v === undefined) return null;
  fastgcTranslateLru.delete(key);
  fastgcTranslateLru.set(key, v);
  return v;
}

function fastgcTranslateCacheSet(key, translated) {
  if (fastgcTranslateLru.has(key)) fastgcTranslateLru.delete(key);
  fastgcTranslateLru.set(key, translated);
  while (fastgcTranslateLru.size > FASTGC_TRANSLATE_CACHE_MAX) {
    const firstKey = fastgcTranslateLru.keys().next().value;
    fastgcTranslateLru.delete(firstKey);
  }
  try {
    fastgcTranslatePersistLoadOnce();
    fastgcTranslatePersistMap.set(String(key || ''), { text: String(translated || ''), lastHitAt: Date.now() });
    while (fastgcTranslatePersistMap.size > FASTGC_TRANSLATE_PERSIST_MAX * 1.2) {
      const firstKey = fastgcTranslatePersistMap.keys().next().value;
      fastgcTranslatePersistMap.delete(firstKey);
    }
    fastgcTranslatePersistDirty = true;
    fastgcTranslatePersistScheduleWrite();
  } catch (_) {}
}

function fastgcTranslatePersistGet(key) {
  try {
    fastgcTranslatePersistLoadOnce();
    const hit = fastgcTranslatePersistMap.get(key);
    if (!hit || !hit.text) return null;
    hit.lastHitAt = Date.now();
    fastgcTranslatePersistMap.delete(key);
    fastgcTranslatePersistMap.set(key, hit);
    fastgcTranslatePersistDirty = true;
    fastgcTranslatePersistScheduleWrite();
    return hit.text;
  } catch (_) {
    return null;
  }
}

/** 同 cacheKey 并发 `fastgc:google-translate` 合并为单次网络（多席位/多路同时译同句） */
const inflightGoogleTranslateByKey = new Map();

function clearFastgcTranslateCaches() {
  try {
    fastgcTranslateLru.clear();
  } catch (_) {}
  try {
    fastgcTranslatePersistMap.clear();
    fastgcTranslatePersistDirty = false;
    if (fastgcTranslatePersistWriteTimer) {
      clearTimeout(fastgcTranslatePersistWriteTimer);
      fastgcTranslatePersistWriteTimer = null;
    }
  } catch (_) {}
  try {
    const p = fastgcTranslatePersistPath();
    if (p && fs.existsSync(p)) fs.rmSync(p, { force: true });
  } catch (_) {}
}

function dirSizeBytesSafe(absPath, depth = 0) {
  try {
    if (!absPath) return 0;
    const st = fs.statSync(absPath);
    if (!st) return 0;
    if (!st.isDirectory()) return Number(st.size || 0);
    if (depth >= 20) return 0;
    let total = 0;
    const items = fs.readdirSync(absPath, { withFileTypes: true });
    for (const ent of items) {
      const p = path.join(absPath, ent.name);
      if (ent.isDirectory()) total += dirSizeBytesSafe(p, depth + 1);
      else {
        try {
          total += Number(fs.statSync(p).size || 0);
        } catch (_) {}
      }
    }
    return total;
  } catch (_) {
    return 0;
  }
}

function normalizeTranslateLang(raw, fallback = 'auto') {
  const v = String(raw || fallback || '').trim();
  if (!v) return fallback || 'auto';
  const low = v.toLowerCase();
  if (low === 'zh' || low === 'zh-cn' || low === 'cn') return 'zh-CN';
  if (low === 'zh-tw' || low === 'zh-hk') return v;
  return low === 'auto' ? 'auto' : v;
}

/** Google gtx JSON：data[0] 为分段 [ [译文片段, 原文片段, ...], ... ] */
function extractGoogleTranslateText(data) {
  if (!Array.isArray(data) || !Array.isArray(data[0])) return '';
  return data[0]
    .map((item) => {
      if (!Array.isArray(item) || item[0] == null) return '';
      return String(item[0]);
    })
    .join('')
    .trim();
}

function buildGoogleTranslateUrls(sourceLang, targetLang, text) {
  const query = new URLSearchParams({
    client: 'gtx',
    sl: sourceLang,
    tl: targetLang,
    dt: 't',
    ie: 'UTF-8',
    oe: 'UTF-8',
    q: text,
  });
  const qs = query.toString();
  return [
    `https://translate.googleapis.com/translate_a/single?${qs}`,
    `https://translate.google.com/translate_a/single?${qs}`,
  ];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchGoogleTranslateOnce(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(3000, Number(timeoutMs) || 12000));
  try {
    const response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        'User-Agent': chromeLikeUserAgent(),
        Accept: 'application/json,text/javascript,*/*;q=0.1',
        'Accept-Language': acceptLanguageForWhatsApp(),
      },
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      const retry = response.headers?.get?.('retry-after');
      const retryAfterMs = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now())) : 0;
      return { ok: false, error: `HTTP_${response.status}`, status: response.status, retryAfterMs, raw: '' };
    }
    let data = null;
    try {
      data = raw ? JSON.parse(raw.trim()) : null;
    } catch (_) {
      return { ok: false, error: 'PARSE_JSON', status: response.status, raw: raw.slice(0, 300) };
    }
    const translated = extractGoogleTranslateText(data);
    if (!translated) {
      return { ok: false, error: 'PARSE_EMPTY', status: response.status, raw: raw.slice(0, 300) };
    }
    return { ok: true, text: translated, status: response.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message || 'FETCH_ERROR', status: 0, raw: '' };
  } finally {
    clearTimeout(timer);
  }
}

let webTranslateRetryAt = 0;
async function requestGoogleTranslateWithRetry(sourceLang, targetLang, normalizedText) {
  if (Date.now() < webTranslateRetryAt) {
    return { ok: false, error: 'WEB_RATE_LIMITED', status: 429, noFallback: true, retryAfterMs: webTranslateRetryAt - Date.now() };
  }
  const urls = buildGoogleTranslateUrls(sourceLang, targetLang, normalizedText);
  let last = { ok: false, error: 'NO_ATTEMPT', status: 0, raw: '' };
  for (let attempt = 0; attempt < urls.length; attempt += 1) {
    const r = await fetchGoogleTranslateOnce(urls[attempt], 7000);
    if (r.ok) return { ...r, attempt: attempt + 1 };
    last = r;
    if (r.status === 429) {
      webTranslateRetryAt = Date.now() + Math.max(60000, Math.min(24 * 60 * 60 * 1000, Number(r.retryAfterMs) || 60000));
      return { ok: false, error: 'WEB_RATE_LIMITED', status: 429, noFallback: true, retryAfterMs: webTranslateRetryAt - Date.now() };
    }
    if (r.status >= 400 && r.status < 500) break;
  }
  return { ...last, ok: false, noFallback: true };
}

function readAccessControlRawSync() {
  try {
    const p = path.join(app.getPath('userData'), ACCESS_CONTROL_FILE);
    if (!fs.existsSync(p)) return { enabled: false, allowIps: [], adminPasswordHash: '' };
    const raw = JSON.parse(fs.readFileSync(p, 'utf8') || '{}');
    const enabled = Boolean(raw.enabled);
    const allowIps = Array.isArray(raw.allowIps)
      ? raw.allowIps.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    const adminPasswordHash = String(raw.adminPasswordHash || '').trim();
    return { enabled, allowIps, adminPasswordHash };
  } catch (_) {
    return { enabled: false, allowIps: [], adminPasswordHash: '' };
  }
}

function writeAccessControlSync(payload = {}) {
  const current = readAccessControlRawSync();
  const enabled = Boolean(payload.enabled);
  const allowIps = Array.isArray(payload.allowIps)
    ? payload.allowIps.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  let adminPasswordHash = String(current.adminPasswordHash || '');
  if (payload.clearPassword) {
    adminPasswordHash = '';
  } else if (String(payload.newPassword || '').trim()) {
    adminPasswordHash = sha256(String(payload.newPassword || '').trim());
  }
  const data = { enabled, allowIps, adminPasswordHash };
  try {
    const p = path.join(app.getPath('userData'), ACCESS_CONTROL_FILE);
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
    if (fs.readFileSync(p, 'utf8') !== JSON.stringify(data, null, 2)) throw new Error('ACCESS_CONFIG_VERIFY_FAILED');
  } catch (error) { return { ok: false, error: String(error.message || error) }; }
  return { ok: true, enabled, allowIps, hasPassword: Boolean(adminPasswordHash) };
}

function getLocalIPv4Set() {
  const net = os.networkInterfaces();
  const set = new Set();
  Object.values(net).forEach((list) => {
    (list || []).forEach((item) => {
      if (!item || item.internal) return;
      if (item.family === 'IPv4' || item.family === 4) set.add(item.address);
    });
  });
  return set;
}

function ipv4ToInt(ip) {
  const m = String(ip || '').trim().match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  const octets = m.slice(1).map((x) => Number(x));
  if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return (((octets[0] << 24) >>> 0) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function isIpInCidr(ip, cidr) {
  const parts = String(cidr || '').trim().split('/');
  if (parts.length !== 2) return false;
  const baseInt = ipv4ToInt(parts[0]);
  const ipInt = ipv4ToInt(ip);
  const prefix = Number(parts[1]);
  if (baseInt === null || ipInt === null || Number.isNaN(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (baseInt & mask) === (ipInt & mask);
}

function isEntryMatched(ip, entry) {
  const e = String(entry || '').trim();
  if (!e) return false;
  if (e.includes('/')) return isIpInCidr(ip, e);
  return ip === e;
}

function isIpAllowedByPolicy(policy) {
  if (!policy || !policy.enabled) return true;
  const allowIps = Array.isArray(policy.allowIps) ? policy.allowIps : [];
  if (!allowIps.length) return true;
  const localIps = getLocalIPv4Set();
  for (const localIp of localIps) {
    if (allowIps.some((entry) => isEntryMatched(localIp, entry))) return true;
  }
  return false;
}

function readUiLocaleSync() {
  try {
    const p = path.join(app.getPath('userData'), UI_LOCALE_FILE);
    if (fs.existsSync(p)) {
      const v = fs.readFileSync(p, 'utf8').trim().toLowerCase();
      if (v === 'en') return 'en';
    }
  } catch (_) {}
  return 'zh';
}

function writeUiLocaleSync(locale) {
  const next = locale === 'en' ? 'en' : 'zh';
  try {
    const p = path.join(app.getPath('userData'), UI_LOCALE_FILE);
    fs.writeFileSync(p, next, 'utf8');
  } catch (_) {}
  return next;
}

/** 与界面语言一致，供 WhatsApp Web 请求使用 Accept-Language（影响官网显示语言） */
let appUiLocale = 'zh';

function acceptLanguageForWhatsApp() {
  if (appUiLocale === 'en') {
    return 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7';
  }
  return 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7';
}

// Default to OS GPU rendering; retain a driver compatibility switch.
if (process.env.FASTGC_DISABLE_GPU === '1' || process.argv.includes('--disable-gpu')) app.disableHardwareAcceleration();

/** 主窗口加载 UI 所用分区（与 index.html 里 webview 的席位分区不同，必须分别配置） */
const WINDOW_PARTITION = 'persist:fastgc-wa';
/** 与 index.html 中 WA_PARTITION_PREFIX + seatId 一致 */
const WA_SEAT_PARTITION_PREFIX = 'persist:fastgc-wa-seat-';
const DEFAULT_WA_SEAT_COUNT = 10;

function normalizeSeatCount(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_WA_SEAT_COUNT;
  return Math.max(1, Math.min(50, Math.floor(n)));
}

function readSeatConfigSync() {
  try {
    const p = path.join(app.getPath('userData'), SEAT_CONFIG_FILE);
    if (!fs.existsSync(p)) return { seatCount: DEFAULT_WA_SEAT_COUNT };
    const j = JSON.parse(fs.readFileSync(p, 'utf8') || '{}');
    return { seatCount: normalizeSeatCount(j.seatCount) };
  } catch (_) {
    return { seatCount: DEFAULT_WA_SEAT_COUNT };
  }
}

function writeSeatConfigSync(payload = {}) {
  const data = { seatCount: normalizeSeatCount(payload.seatCount) };
  try {
    fs.writeFileSync(path.join(app.getPath('userData'), SEAT_CONFIG_FILE), JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {}
  return data;
}

function getEffectiveSeatCount() {
  return readSeatConfigSync().seatCount;
}

/** 与当前 Electron 内置 Chromium 版本一致，避免 UA / Client Hints 与真实引擎严重不符 */
function chromeLikeUserAgent() {
  const chromeVersion = process.versions.chrome || '131.0.0.0';
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOpenExternalUrl(raw) {
  const next = String(raw || '').trim();
  if (!/^https?:\/\//i.test(next)) return '';
  try {
    const u = new URL(next);
    if (!/^https?:$/i.test(u.protocol)) return '';
    return u.toString();
  } catch (_) {
    return '';
  }
}

const activeBrowserSessions = new Set();
function attachWhatsAppPartitionBehavior(ses) {
  if (!ses || activeBrowserSessions.has(ses)) return;
  activeBrowserSessions.add(ses);
  const ua = chromeLikeUserAgent();
  const chromeMajor = (process.versions.chrome || '131').split('.')[0];
  const secChUa = `"Chromium";v="${chromeMajor}", "Google Chrome";v="${chromeMajor}", "Not-A.Brand";v="24"`;
  ses.setUserAgent(ua);
  const waEmbedAllowPermissions = [
    'notifications',
    /** 默认仅保留基础剪贴板写入能力；敏感权限不默认放开 */
    'clipboard-sanitized-write',
  ];
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    const pageUrl = String((wc && typeof wc.getURL === 'function' && wc.getURL()) || '').trim();
    callback(waEmbedAllowPermissions.includes(permission) && isWhatsAppEmbeddedNavigationUrl(pageUrl));
  });
  try {
    ses.setPermissionCheckHandler((_wc, permission) => waEmbedAllowPermissions.includes(permission));
  } catch (_) {}
  // 部分环境下仅靠 setUserAgent 仍会在请求里带上 Electron；对 WhatsApp 相关域强制标准 Chrome UA
  const filter = {
    urls: ['*://web.whatsapp.com/*', '*://*.whatsapp.net/*', '*://*.whatsapp.com/*', '*://translate.googleapis.com/*'],
  };
  ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const headers = {
      ...details.requestHeaders,
      'User-Agent': ua,
      'Sec-CH-UA': secChUa,
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': '"Windows"',
      'Accept-Language': acceptLanguageForWhatsApp(),
    };
    callback({ requestHeaders: headers });
  });
  // Electron uses only the last listener for a webRequest event. Keep WhatsApp
  // and translation in one filter so neither policy overwrites the other.
  ses.webRequest.onBeforeRequest((details, callback) => {
    try {
      const type = String(details.resourceType || '');
      if (type !== 'mainFrame' && type !== 'subFrame') {
        callback({ cancel: false });
        return;
      }
      const url = String(details.url || '').trim();
      if (!/^https?:\/\//i.test(url)) {
        callback({ cancel: false });
        return;
      }
      callback({ cancel: !isWhatsAppEmbeddedNavigationUrl(url) });
    } catch (_) {
      callback({ cancel: true });
    }
  });
}

/** 与 index.html normalizePhone 一致：只保留数字；+6565655555、+65 6565 5555 与 6565655555 查询相同 */

/**
 * 开放 API 订单列表（单页）。queryExtras：phone（可选）、status（如 completed）、start_date / end_date。
 */

ipcMain.handle('app:whatsapp-user-agent', () => chromeLikeUserAgent());
ipcMain.handle('app:get-app-version', () => {
  try {
    return {
      ok: true,
      version: app.getVersion ? app.getVersion() : '',
      packaged: Boolean(app.isPackaged),
      execPath: String(process.execPath || ''),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

/** 排障：FASTGC_WA_WEBVIEW_DEVTOOLS=1 时 WhatsApp 嵌入 webview 在 dom-ready 自动打开开发者工具 */
ipcMain.handle('app:wa-webview-devtools-enabled', () => String(process.env.FASTGC_WA_WEBVIEW_DEVTOOLS || '').trim() === '1');

ipcMain.handle('app:webview-translate-preload-url', () => {
  try {
    const abs = path.resolve(__dirname, 'webview-translate-preload.js');
    // Electron <webview> 的 preload 需绝对路径；file:// URL 在部分版本下无法加载，会导致翻译桥接失效
    return abs.replace(/\\/g, '/');
  } catch (_) {
    return '';
  }
});

/** 与 @wppconnect/wa-js 一致：官方 dist 注入 webview，供 WPP.contact.getPnLidEntry 等采号（主进程缓存一份） */
let waJsBundleMainCache = null;
ipcMain.handle('fastgc:wa-js-bundle', () => {
  if (waJsBundleMainCache !== null) return waJsBundleMainCache;
  try {
    const p = path.join(__dirname, 'dist', 'wppconnect-wa.js');
    if (!fs.existsSync(p)) {
      waJsBundleMainCache = '';
      return '';
    }
    waJsBundleMainCache = fs.readFileSync(p, 'utf8');
    return waJsBundleMainCache;
  } catch (_) {
    waJsBundleMainCache = '';
    return '';
  }
});

ipcMain.handle('fastgc:clipboard-write-text', (_event, text) => {
  const value = String(text || '').trim();
  if (!value) return { ok: false, error: 'EMPTY' };
  try {
    clipboard.writeText(value);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('fastgc:clipboard-write-image-buffer', (_event, payload = {}) => {
  try {
    const raw = payload && payload.bytes;
    const buffer = Buffer.isBuffer(raw)
      ? raw
      : raw instanceof ArrayBuffer
        ? Buffer.from(raw)
        : ArrayBuffer.isView(raw)
          ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
          : null;
    if (!buffer || buffer.length <= 0) return { ok: false, error: 'EMPTY' };
    if (buffer.length > 25 * 1024 * 1024) return { ok: false, error: 'TOO_LARGE' };
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) return { ok: false, error: 'BAD_IMAGE' };
    clipboard.writeImage(image);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

const isTranslationSettingsHost = event => {
  const expected = pathToFileURL(path.join(__dirname, 'index.html')).href;
  return event.senderFrame === event.sender.mainFrame && event.sender.getURL().split(/[?#]/)[0] === expected;
};
ipcMain.on('fastgc:translate-policy', event => { event.returnValue = cloudTranslation.getPolicy(); });
ipcMain.handle('app:get-cloud-translation', event => isTranslationSettingsHost(event) ? cloudTranslation.getStatus() : { ok: false, error: 'FORBIDDEN' });
ipcMain.handle('app:set-cloud-translation', (event, payload = {}) => isTranslationSettingsHost(event) ? cloudTranslation.saveConfig(payload) : { ok: false, error: 'FORBIDDEN' });
ipcMain.handle('app:check-cloud-translation', async event => {
  if (!isTranslationSettingsHost(event)) return { ok: false, error: 'FORBIDDEN' };
  const result = await cloudTranslation.translate('Hello', 'en', 'zh-CN');
  return { ...result, settings: cloudTranslation.getStatus() };
});

ipcMain.handle('fastgc:google-translate', async (_event, payload = {}) => {
  const policy = cloudTranslation.getPolicy();
  if (!policy.ok) return { ok: false, error: policy.error, noFallback: true };
  const official = policy.provider === 'google-cloud-nmt';
  const text = String(payload.text || '');
  const sourceLang = normalizeTranslateLang(payload.sourceLang, 'auto');
  const targetLang = normalizeTranslateLang(payload.targetLang, 'en');
  const normalized = normalizeTextForTranslateCache(text);
  if (!normalized) return { ok: false, error: 'EMPTY' };
  if (sourceLang !== 'auto' && sourceLang.toLowerCase() === targetLang.toLowerCase()) {
    return { ok: true, text: normalized, skipped: 'same-language' };
  }
  const baseKey = fastgcTranslateCacheKey(sourceLang, targetLang, normalized);
  const cacheKey = official ? `google-cloud-nmt-v1\t${baseKey}` : baseKey;
  const cached = fastgcTranslateCacheGet(cacheKey);
  if (cached != null) {
    return { ok: true, text: cached, cached: true };
  }
  const diskCached = fastgcTranslatePersistGet(cacheKey);
  if (diskCached != null) {
    fastgcTranslateCacheSet(cacheKey, diskCached);
    return { ok: true, text: diskCached, cached: true, persisted: true };
  }
  const reuse = inflightGoogleTranslateByKey.get(cacheKey);
  if (reuse) return reuse;
  const job = (async () => {
    try {
      const result = official
        ? await cloudTranslation.translate(normalized, sourceLang, targetLang)
        : await requestGoogleTranslateWithRetry(sourceLang, targetLang, normalized);
      if (!result.ok) {
        return {
          ok: false,
          error: result.error || 'TRANSLATE_FAILED',
          status: result.status || 0,
          raw: result.raw || '',
          noFallback: official || Boolean(result.noFallback),
          retryAfterMs: Number(result.retryAfterMs) || 0,
        };
      }
      const out = result.text;
      fastgcTranslateCacheSet(cacheKey, out);
      return { ok: true, text: out, status: result.status || 200, attempt: result.attempt || 1 };
    } catch (err) {
      return official
        ? { ok: false, error: 'CLOUD_TRANSLATE_FAILED', noFallback: true }
        : { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      inflightGoogleTranslateByKey.delete(cacheKey);
    }
  })();
  inflightGoogleTranslateByKey.set(cacheKey, job);
  return job;
});

ipcMain.handle('app:set-ui-locale', (_event, locale) => {
  appUiLocale = writeUiLocaleSync(locale);
  return { ok: true, locale: appUiLocale };
});

ipcMain.handle('app:get-ui-locale', () => appUiLocale);
ipcMain.handle('app:get-access-control', () => {
  const raw = readAccessControlRawSync();
  return { enabled: raw.enabled, allowIps: raw.allowIps, hasPassword: Boolean(raw.adminPasswordHash) };
});
const adminGrants = new Map();
function isAdminAuthorized(event) {
  if (!isTranslationSettingsHost(event)) return false;
  const current = readAccessControlRawSync();
  if (!current.adminPasswordHash) return true;
  const grant = adminGrants.get(event.sender.id);
  return Boolean(grant && grant.hash === current.adminPasswordHash && grant.expires > Date.now());
}
ipcMain.handle('app:set-access-control', (event, payload) => {
  if (!isAdminAuthorized(event)) return { ok: false, error: 'ADMIN_AUTH_REQUIRED' };
  const result = writeAccessControlSync(payload || {});
  if (result.ok) adminGrants.delete(event.sender.id);
  return result;
});
ipcMain.handle('app:verify-access-password', (event, password) => {
  if (!isTranslationSettingsHost(event)) return { ok: false, verified: false, error: 'FORBIDDEN' };
  const raw = readAccessControlRawSync();
  const hash = String(raw.adminPasswordHash || '');
  if (!hash) return { ok: true, verified: true, hasPassword: false };
  const provided = sha256(String(password || '').trim());
  const verified = provided.length === hash.length && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(hash));
  if (verified) adminGrants.set(event.sender.id, { hash, expires: Date.now() + 5 * 60 * 1000 });
  else adminGrants.delete(event.sender.id);
  return { ok: true, verified, hasPassword: true };
});
ipcMain.handle('app:get-data-root', () => {
  const cfg = readBootstrapConfigSync();
  return { dataRoot: cfg.pendingDataRoot || cfg.dataRoot || '', pending: Boolean(cfg.pendingDataRoot) };
});
ipcMain.handle('app:set-data-root', (event, payload = {}) => {
  if (!isAdminAuthorized(event)) return { ok: false, error: 'ADMIN_AUTH_REQUIRED' };
  const nextRoot = normalizeDataRoot(payload.dataRoot);
  if (!nextRoot) return { ok: false, error: 'INVALID_PATH' };
  try {
    fs.mkdirSync(nextRoot, { recursive: true });
    const cfg = readBootstrapConfigSync();
    if (nextRoot === cfg.dataRoot) return { ok: true, dataRoot: nextRoot, restartRequired: false };
    validateDataTarget(app.getPath('userData'), path.join(nextRoot, 'fastgc-whatsapp-userdata'));
    const saved = writeBootstrapConfigSync({ dataRoot: cfg.dataRoot, pendingDataRoot: nextRoot });
    if (!saved.ok) return saved;
    return { ok: true, dataRoot: nextRoot, restartRequired: true, migrationPending: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});
ipcMain.handle('app:browse-data-root', async () => {
  try {
    const cfg = readBootstrapConfigSync();
    const res = await dialog.showOpenDialog({
      title: '选择数据存储目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: cfg.dataRoot || app.getPath('documents'),
    });
    if (res.canceled || !res.filePaths?.[0]) return { ok: true, canceled: true, dataRoot: '' };
    return { ok: true, canceled: false, dataRoot: res.filePaths[0] };
  } catch (err) {
    return { ok: false, canceled: true, error: err instanceof Error ? err.message : String(err), dataRoot: '' };
  }
});

function normalizeUpdateBaseUrl(raw) {
  const normalized = String(raw || '')
    .trim()
    .replace(/\/+$/, '');
  if (!normalized) return '';
  try {
    const u = new URL(normalized);
    if (u.protocol !== 'https:') return '';
    return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
  } catch (_) {
    return '';
  }
}

function readUpdateFeedSync() {
  try {
    const p = path.join(app.getPath('userData'), UPDATE_FEED_FILE);
    if (!fs.existsSync(p)) return { baseUrl: '' };
    const j = JSON.parse(fs.readFileSync(p, 'utf8') || '{}');
    return { baseUrl: normalizeUpdateBaseUrl(j.baseUrl) };
  } catch (_) {
    return { baseUrl: '' };
  }
}

function writeUpdateFeedSync(payload = {}) {
  const baseUrl = normalizeUpdateBaseUrl(payload.baseUrl);
  const data = { baseUrl };
  try {
    fs.writeFileSync(path.join(app.getPath('userData'), UPDATE_FEED_FILE), JSON.stringify(data, null, 2), 'utf8');
    if (fs.readFileSync(path.join(app.getPath('userData'), UPDATE_FEED_FILE), 'utf8') !== JSON.stringify(data, null, 2)) throw new Error('UPDATE_CONFIG_VERIFY_FAILED');
  } catch (error) { return { ok: false, error: String(error.message || error) }; }
  return { ok: true, ...data };
}

function getEffectiveUpdateBaseUrl() {
  const env = normalizeUpdateBaseUrl(process.env.FASTGC_UPDATE_URL);
  if (env) return env;
  return readUpdateFeedSync().baseUrl || '';
}

function getAutoUpdater() {
  if (!app.isPackaged) return null;
  try {
    return require('electron-updater').autoUpdater;
  } catch (_) {
    return null;
  }
}

function applyUpdateFeedUrl() {
  const base = getEffectiveUpdateBaseUrl();
  // Do not synchronously load the updater dependency tree when no feed is set.
  if (!base) return false;
  const autoUpdater = getAutoUpdater();
  if (!autoUpdater) return false;
  autoUpdater.setFeedURL({ provider: 'generic', url: `${base}/` });
  return true;
}

function ensureUpdateListeners() {
  if (updateListenersAttached) return;
  const autoUpdater = getAutoUpdater();
  if (!autoUpdater) return;
  updateListenersAttached = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  if (process.platform === 'win32') {
    try {
      autoUpdater.verifyUpdateCodeSignature = true;
    } catch (_) {}
  }

  autoUpdater.on('update-available', (info) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const payload = {
      type: 'info',
      title: '发现新版本',
      message: `新版本 ${info.version} 正在下载，请稍候…`,
    };
    if (win && !win.isDestroyed()) {
      dialog.showMessageBox(win, payload);
    } else {
      dialog.showMessageBox(payload);
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const opts = {
      type: 'question',
      buttons: ['立即重启安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
      title: '更新已下载',
      message: `新版本 ${info.version} 已就绪，是否立即重启完成安装？`,
    };
    const p = win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
    p.then((r) => {
      if (r.response === 0) autoUpdater.quitAndInstall(false, true);
    }).catch(() => {});
  });

  autoUpdater.on('error', (err) => {
    writeDiagnosticLog('auto-updater-error', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : '',
    });
    console.warn('[autoUpdater]', err);
  });
}

function startUpdateChecker() {
  if (!app.isPackaged) return;
  if (!applyUpdateFeedUrl()) return;
  ensureUpdateListeners();
  const autoUpdater = getAutoUpdater();
  if (!autoUpdater) return;
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((e) => {
      writeDiagnosticLog('auto-updater-check-failed', {
        message: e instanceof Error ? e.message : String(e),
      });
      console.warn('checkForUpdates', e);
    });
  }, 10000);
  setInterval(() => {
    autoUpdater.checkForUpdates().catch((e) => {
      writeDiagnosticLog('auto-updater-periodic-check-failed', {
        message: e instanceof Error ? e.message : String(e),
      });
    });
  }, 6 * 60 * 60 * 1000);
}

ipcMain.handle('app:get-update-feed', () => {
  const saved = readUpdateFeedSync();
  const env = normalizeUpdateBaseUrl(process.env.FASTGC_UPDATE_URL);
  return { baseUrl: saved.baseUrl || '', effectiveUrl: getEffectiveUpdateBaseUrl(), fromEnv: Boolean(env), editable: !app.isPackaged || process.env[UPDATE_FEED_EDIT_ENV] === '1' };
});

ipcMain.handle('app:set-update-feed', (event, payload = {}) => {
  if (!isAdminAuthorized(event)) return { ok: false, error: 'ADMIN_AUTH_REQUIRED' };
  const allowEdit = String(process.env[UPDATE_FEED_EDIT_ENV] || '').trim() === '1';
  if (app.isPackaged && !allowEdit) {
    return { ok: false, error: `Update feed edit is locked (set ${UPDATE_FEED_EDIT_ENV}=1 to allow)` };
  }
  if (!isPlainObject(payload)) return { ok: false, error: 'INVALID_PAYLOAD' };
  if (!normalizeUpdateBaseUrl(payload.baseUrl)) return { ok: false, error: 'Only HTTPS update URL is allowed' };
  const data = writeUpdateFeedSync(payload || {});
  if (!data.ok) return data;
  if (app.isPackaged && data.baseUrl) {
    applyUpdateFeedUrl();
    ensureUpdateListeners();
    const au = getAutoUpdater();
    if (au) au.checkForUpdates().catch((e) => {
      writeDiagnosticLog('auto-updater-set-feed-check-failed', {
        message: e instanceof Error ? e.message : String(e),
      });
    });
  }
  return { ok: true, ...data };
});

ipcMain.on('app:get-seat-config-sync', (event) => {
  event.returnValue = { seatCount: getEffectiveSeatCount() };
});
ipcMain.handle('app:get-seat-config', () => readSeatConfigSync());
ipcMain.handle('app:set-seat-config', (_event, payload = {}) => {
  if (!isPlainObject(payload)) return { ok: false, error: 'INVALID_PAYLOAD' };
  return { ok: true, ...writeSeatConfigSync(payload) };
});

const isStorageKey = key => [...SQLITE_MIGRATION_TRACKED_KEYS, SQLITE_MIGRATION_MARK_KEY].includes(key);
ipcMain.on('app:storage-get-sync', (event, payload = {}) => {
  const key = String(payload.key || '').trim();
  if (!isTranslationSettingsHost(event) || !isStorageKey(key)) { event.returnValue = { ok: false, error: 'FORBIDDEN' }; return; }
  const db = getStorageDb();
  try {
    const row = db?.prepare('SELECT value FROM app_kv WHERE key = ?').get(key);
    event.returnValue = { ok: Boolean(db), found: Boolean(row), value: row?.value || '' };
  } catch (_) { event.returnValue = { ok: false, error: 'STORAGE_READ_FAILED' }; }
});
ipcMain.on('app:storage-set-sync', (event, payload = {}) => {
  const key = String(payload.key || '').trim();
  if (!isTranslationSettingsHost(event) || !isStorageKey(key)) { event.returnValue = { ok: false, error: 'FORBIDDEN' }; return; }
  event.returnValue = { ok: storageSet(key, payload.value), key };
});
ipcMain.handle('app:storage-get', (event, payload = {}) => {
  if (!isTranslationSettingsHost(event)) return { ok: false, error: 'FORBIDDEN' };
  if (!isPlainObject(payload)) return { ok: false, key: '', value: '' };
  const key = String(payload.key || '').trim();
  if (!key) return { ok: false, key, value: '' };
  if (!isStorageKey(key)) return { ok: false, key, error: 'INVALID_KEY' };
  return { ok: Boolean(getStorageDb()), key, value: storageGet(key) };
});

ipcMain.handle('app:storage-set', (event, payload = {}) => {
  if (!isTranslationSettingsHost(event)) return { ok: false, error: 'FORBIDDEN' };
  if (!isPlainObject(payload)) return { ok: false, key: '' };
  const key = String(payload.key || '').trim();
  if (!isStorageKey(key)) return { ok: false, key };
  return { ok: storageSet(key, String(payload.value == null ? '' : payload.value)), key };
});

ipcMain.handle('app:storage-migrate-batch', (event, payload = {}) => {
  if (!isTranslationSettingsHost(event)) return { ok: false, saved: 0, error: 'FORBIDDEN' };
  if (!isPlainObject(payload)) return { ok: false, saved: 0 };
  const items = Array.isArray(payload.items) ? payload.items : [];
  const db = getStorageDb();
  if (!db) return { ok: false, saved: 0, error: 'STORAGE_UNAVAILABLE' };
  let saved = 0;
  try {
    db.exec('BEGIN IMMEDIATE');
    const insert = db.prepare('INSERT INTO app_kv (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO NOTHING');
    for (const it of items) {
      const key = String(it && it.key || '').trim();
      if (!SQLITE_MIGRATION_TRACKED_KEYS.includes(key)) throw new Error('INVALID_MIGRATION_KEY');
      insert.run(key, String(it.value == null ? '' : it.value), Date.now());
      saved += 1;
    }
    if (!storageSet(SQLITE_MIGRATION_MARK_KEY, '1')) throw new Error('MIGRATION_MARK_FAILED');
    db.exec('COMMIT');
    return { ok: true, saved };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    return { ok: false, saved: 0, error: String(error.message || error) };
  }
});

ipcMain.on('app:storage-snapshot-sync', (event, payload = {}) => {
  if (!isTranslationSettingsHost(event)) { event.returnValue = { ok: false, data: {} }; return; }
  if (!isPlainObject(payload)) {
    event.returnValue = { ok: false, data: {} };
    return;
  }
  const keys = Array.isArray(payload.keys) ? payload.keys : [];
  const data = {};
  for (const rawKey of keys) {
    const key = String(rawKey || '').trim();
    if (!key) continue;
    if (isStorageKey(key)) data[key] = storageGet(key);
  }
  event.returnValue = { ok: Boolean(getStorageDb()), data };
});

ipcMain.handle('app:check-updates-now', async () => {
  if (!app.isPackaged) return { ok: false, reason: 'not_packaged' };
  if (!applyUpdateFeedUrl()) return { ok: false, reason: 'no_feed' };
  ensureUpdateListeners();
  try {
    const au = getAutoUpdater();
    if (!au) return { ok: false, reason: 'no_updater' };
    const r = await au.checkForUpdates();
    return { ok: true, updateInfo: r?.updateInfo || null };
  } catch (err) {
    writeDiagnosticLog('auto-updater-manual-check-failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('app:open-external', async (_event, payload = {}) => {
  if (!isPlainObject(payload)) return { ok: false, error: 'INVALID_PAYLOAD' };
  const next = normalizeOpenExternalUrl(payload.url);
  if (!next) return { ok: false, error: 'INVALID_URL' };
  try {
    await shell.openExternal(next);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('app:clear-translate-cache', () => {
  clearFastgcTranslateCaches();
  return { ok: true };
});

ipcMain.handle('app:get-diagnostics-snapshot', async () => {
  let memInfo = null;
  try {
    if (typeof process.getProcessMemoryInfo === 'function') {
      memInfo = await process.getProcessMemoryInfo();
    }
  } catch (_) {}
  let mu = null;
  try {
    mu = process.memoryUsage();
  } catch (_) {}
  const userData = (() => {
    try {
      return app.getPath('userData');
    } catch (_) {
      return '';
    }
  })();
  const userDataBytes = userData ? dirSizeBytesSafe(userData) : 0;
  const translateCachePath = fastgcTranslatePersistPath();
  const translateCacheBytes = (() => {
    try {
      if (!translateCachePath) return 0;
      if (!fs.existsSync(translateCachePath)) return 0;
      return Number(fs.statSync(translateCachePath).size || 0);
    } catch (_) {
      return 0;
    }
  })();
  const translateCacheEntries = (() => {
    try {
      fastgcTranslatePersistLoadOnce();
      return fastgcTranslatePersistMap.size;
    } catch (_) {
      return 0;
    }
  })();
  const sqlitePath = storageDbPath();
  const sqliteBytes = (() => {
    try {
      if (!sqlitePath || !fs.existsSync(sqlitePath)) return 0;
      return Number(fs.statSync(sqlitePath).size || 0);
    } catch (_) {
      return 0;
    }
  })();
  const sqliteAvailable = Boolean(getStorageDb());
  const sqliteMigrationDone = String(storageGet(SQLITE_MIGRATION_MARK_KEY) || '').trim() === '1';
  const sqliteMigratedKeys = SQLITE_MIGRATION_TRACKED_KEYS.filter((k) => String(storageGet(k) || '').trim() !== '');
  return {
    ok: true,
    memInfo,
    memoryUsage: mu,
    userDataPath: userData,
    userDataBytes,
    translateCachePath,
    translateCacheBytes,
    translateCacheEntries,
    sqlitePath,
    sqliteBytes,
    sqliteAvailable,
    sqliteMigrationDone,
    sqliteMigratedKeysCount: sqliteMigratedKeys.length,
    sqliteMigrationTrackedCount: SQLITE_MIGRATION_TRACKED_KEYS.length,
    activeSessionCount: activeBrowserSessions.size,
  };
});

function taskbarBadgeSvgDataUrl(count) {
  const n = normalizeTaskbarUnreadCount(count);
  if (n <= 0) return '';
  const label = n > 99 ? '99+' : String(n);
  const fontSize = label.length >= 3 ? 23 : label.length === 2 ? 30 : 36;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <circle cx="32" cy="32" r="30" fill="#ef4444"/>
      <circle cx="32" cy="32" r="29" fill="none" stroke="#ffffff" stroke-width="4"/>
      <text x="32" y="34" text-anchor="middle" dominant-baseline="central"
        font-family="Segoe UI, Arial, sans-serif" font-size="${fontSize}" font-weight="800" fill="#ffffff">${label}</text>
    </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function applyTaskbarUnreadCount(win, count) {
  if (!win || win.isDestroyed()) return;
  const n = normalizeTaskbarUnreadCount(count);
  try {
    app.setBadgeCount(n);
  } catch (_) {}
  if (process.platform !== 'win32' || typeof win.setOverlayIcon !== 'function') return;
  try {
    if (n <= 0) {
      win.setOverlayIcon(null, '');
      return;
    }
    const img = nativeImage.createFromDataURL(taskbarBadgeSvgDataUrl(n));
    win.setOverlayIcon(img, `Unread messages: ${n}`);
  } catch (_) {
    try {
      win.setOverlayIcon(null, '');
    } catch (_) {}
  }
}

ipcMain.handle('app:set-taskbar-unread-count', (event, count) => {
  taskbarUnreadCount = normalizeTaskbarUnreadCount(count);
  BrowserWindow.getAllWindows().forEach((win) => applyTaskbarUnreadCount(win, taskbarUnreadCount));
  return { ok: true, count: taskbarUnreadCount };
});

function createWindow() {
  const accessPolicy = readAccessControlRawSync();
  const accessAllowed = isIpAllowedByPolicy(accessPolicy);
  let shown = false;
  /** 仅当 FASTGC_NO_BACKGROUND_THROTTLE=1：失焦时少节流定时器，切回更顺；默认不关（省电） */
  const noBackgroundThrottle = String(process.env.FASTGC_NO_BACKGROUND_THROTTLE || '').trim() === '1';
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: '#ffffff',
    ...(noBackgroundThrottle ? { backgroundThrottling: false } : {}),
    webPreferences: {
      webviewTag: true,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      /** 宿主壳 UI 无需拼写检查；减轻大列表/多输入场景下的编辑器开销（WhatsApp 在独立 webview 内，不受影响） */
      spellcheck: false,
      partition: WINDOW_PARTITION,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (accessAllowed) {
    win.loadFile(path.join(__dirname, 'index.html'));
  } else {
    const blockedHtml = `
      <!doctype html><html><head><meta charset="utf-8"><title>Access Restricted</title></head>
      <body style="margin:0;background:#fff;color:#111;font-family:Segoe UI,Arial,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">
        <div style="text-align:center;opacity:.72;">
          <div style="font-size:16px;font-weight:700;margin-bottom:8px;">访问受限</div>
          <div style="font-size:12px;">当前设备 IP 不在白名单内</div>
        </div>
      </body></html>`;
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(blockedHtml)}`);
  }

  const showSafely = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
  };

  // 常规路径：首次可渲染时显示
  win.once('ready-to-show', showSafely);
  // 兜底路径：即使 ready-to-show 漏触发，也在页面完成加载后显示
  win.webContents.once('did-finish-load', showSafely);
  // 最后兜底：极端情况下超时显示白底窗口，避免黑屏闪烁
  setTimeout(() => {
    if (shown || win.isDestroyed()) return;
    try {
      win.setBackgroundColor('#ffffff');
    } catch (_) {}
    showSafely();
  }, 12000);

  const renderRecoveryAttempts = [];
  const reloadMainWindow = (reason, details = {}) => {
    if (win.isDestroyed()) return false;
    const now = Date.now();
    while (renderRecoveryAttempts.length && now - renderRecoveryAttempts[0] > RENDER_RECOVERY_WINDOW_MS) {
      renderRecoveryAttempts.shift();
    }
    renderRecoveryAttempts.push(now);
    writeDiagnosticLog('main-window-render-recovery', {
      reason,
      details,
      attemptsInWindow: renderRecoveryAttempts.length,
    });
    if (renderRecoveryAttempts.length > RENDER_RECOVERY_MAX_ATTEMPTS) return false;
    try {
      if (accessAllowed) {
        win.loadFile(path.join(__dirname, 'index.html'));
      } else {
        win.reload();
      }
      return true;
    } catch (err) {
      writeDiagnosticLog('main-window-render-recovery-failed', {
        reason,
        message: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };

  win.webContents.on('render-process-gone', (_event, details) => {
    if (win.isDestroyed()) return;
    const payload = {
      reason: details && details.reason ? String(details.reason) : '',
      exitCode: details && details.exitCode != null ? details.exitCode : null,
    };
    if (reloadMainWindow('render-process-gone', payload)) return;
    try {
      dialog.showMessageBox(win, {
        type: 'error',
        title: '界面异常',
        message: '页面渲染进程多次异常，自动恢复失败。请完全关闭后重新启动应用。',
        detail: payload.reason,
      });
    } catch (_) {}
  });

  win.webContents.on('unresponsive', () => {
    writeDiagnosticLog('main-window-unresponsive', {});
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    writeDiagnosticLog('main-window-did-fail-load', {
      errorCode,
      errorDescription,
      validatedURL,
    });
  });

  // Optional: open DevTools when debugging WA issues
  // win.webContents.openDevTools({ mode: 'detach' });
  applyTaskbarUnreadCount(win, taskbarUnreadCount);
}

/**
 * 扫码登录等流程会在 web.whatsapp.com 内触发整页跳转或 window.open 到 *.whatsapp.com / *.whatsapp.net。
 * 若一律 openExternal，部分机器会跳到系统浏览器看起来像「离开壳子」；同生态 URL 留在当前 WebContents。
 */
function isWhatsAppEmbeddedNavigationUrl(raw) {
  const s = String(raw || '').trim();
  if (!/^https?:\/\//i.test(s)) return false;
  try {
    const u = new URL(s);
    const h = u.hostname.toLowerCase();
    if (h === 'web.whatsapp.com' || h === 'www.whatsapp.com' || h === 'whatsapp.com') return true;
    if (h.endsWith('.whatsapp.com') || h.endsWith('.whatsapp.net')) return true;
    return false;
  } catch (_) {
    return false;
  }
}

function bindExternalOpenForContents(contents) {
  if (!contents || contents.isDestroyed?.()) return;
  try {
    contents.setWindowOpenHandler(({ url }) => {
      const next = String(url || '').trim();
      if (!/^https?:\/\//i.test(next)) return { action: 'allow' };
      if (isWhatsAppEmbeddedNavigationUrl(next)) {
        try {
          setImmediate(() => {
            if (contents.isDestroyed?.()) return;
            contents.loadURL(next).catch(() => {});
          });
        } catch (_) {}
        return { action: 'deny' };
      }
      shell.openExternal(next).catch(() => {});
      return { action: 'deny' };
    });
  } catch (_) {}
  try {
    contents.on('context-menu', (_event, params = {}) => {
      const ef = params.editFlags || {};
      const ift = String(params.inputFieldType || '').toLowerCase();
      /** WhatsApp 会话框多为 contenteditable；部分 Chromium 版本不置 isEditable，但会置 canPaste / inputFieldType */
      const inEditableField =
        Boolean(params.isEditable) ||
        Boolean(ef.canPaste) ||
        (ift !== '' && ift !== 'none');
      const template = [];
      if (inEditableField) {
        template.push(
          { role: 'undo', label: '撤销' },
          { role: 'redo', label: '重做' },
          { type: 'separator' },
          { role: 'cut', label: '剪切' },
          { role: 'copy', label: '复制' },
          { role: 'paste', label: '粘贴' },
          { role: 'pasteAndMatchStyle', label: '粘贴为纯文本' },
          { type: 'separator' },
          { role: 'selectAll', label: '全选' },
        );
      } else if (String(params.selectionText || '').trim()) {
        template.push(
          { role: 'copy', label: '复制' },
          { type: 'separator' },
          { role: 'selectAll', label: '全选' },
        );
      }
      if (!template.length) return;
      _event.preventDefault();
      Menu.buildFromTemplate(template).popup({
        window: BrowserWindow.fromWebContents(contents) || BrowserWindow.getFocusedWindow() || undefined,
      });
    });
  } catch (_) {}
  try {
    contents.on('will-navigate', (event, url) => {
      const next = String(url || '').trim();
      if (!/^https?:\/\//i.test(next)) return;
      if (isWhatsAppEmbeddedNavigationUrl(next)) return;
      event.preventDefault();
      shell.openExternal(next).catch(() => {});
    });
  } catch (_) {}
  try {
    contents.on('will-redirect', (event, url) => {
      const next = String(url || '').trim();
      if (!/^https?:\/\//i.test(next)) return;
      if (isWhatsAppEmbeddedNavigationUrl(next)) return;
      event.preventDefault();
      shell.openExternal(next).catch(() => {});
    });
  } catch (_) {}
}

app.whenReady().then(() => {
  if (dataMigrationError) {
    dialog.showMessageBoxSync({ type: 'warning', title: 'FastGC WhatsApp', message: '数据目录迁移未完成，继续使用原目录。\nData migration failed; the original directory is still in use.', detail: dataMigrationError });
  }
  /** 无窗口：验证 clearFastgcTranslateCaches 与持久化文件一致（供 `npm run test:smoke-diagnostics`） */
  if (process.argv.includes('--smoke-diagnostics-exit')) {
    try {
      clearFastgcTranslateCaches();
      const p = fastgcTranslatePersistPath();
      if (!p) throw new Error('no translate persist path');
      const sample = { v: 1, entries: [['smoke-key', 'smoke-val', Date.now()]] };
      fs.writeFileSync(p, JSON.stringify(sample), 'utf8');
      fastgcTranslatePersistLoadOnce();
      if (fastgcTranslatePersistMap.size < 1) throw new Error('persist map not loaded from file');
      clearFastgcTranslateCaches();
      if (fastgcTranslatePersistMap.size !== 0) throw new Error('persist map not cleared');
      if (fs.existsSync(p)) throw new Error('translate cache file still exists after clear');
      const marker = process.env.FASTGC_SMOKE_DIAG_MARKER;
      if (marker) {
        try {
          fs.writeFileSync(marker, 'OK\n', 'utf8');
        } catch (_) {}
      }
      app.exit(0);
    } catch (err) {
      const marker = process.env.FASTGC_SMOKE_DIAG_MARKER;
      if (marker) {
        try {
          fs.writeFileSync(marker, `FAIL:${err instanceof Error ? err.message : String(err)}\n`, 'utf8');
        } catch (_) {}
      }
      app.exit(1);
    }
    return;
  }

  // 旧会员功能的本地密钥仅做定点清理，不读取或保留其内容。
  try { fs.rmSync(path.join(app.getPath('userData'), 'fastgc_api_secret.bin'), { force: true }); } catch (_) {}
  maybeWarnNonPackagedStart();
  /** Windows / Linux：去掉默认「文件 / 编辑 / 查看…」顶栏；macOS 仍保留系统菜单栏习惯 */
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
  }
  appUiLocale = readUiLocaleSync();
  attachWhatsAppPartitionBehavior(session.fromPartition(WINDOW_PARTITION));
  app.on('web-contents-created', (_event, contents) => {
    /** 仅 WA 内嵌 <webview> 的 guest：勿绑到主窗口 file:// 壳，否则 window.open/跳转误命中会把整壳 loadURL 成 WhatsApp 全页，看起来像卡住退不出 */
    try {
      if (typeof contents.getType === 'function' && contents.getType() !== 'webview') return;
    } catch (_) {
      return;
    }
    attachWhatsAppPartitionBehavior(contents.session);
    bindExternalOpenForContents(contents);
  });
  createWindow();
  // Allow the initial UI/preload IPC to finish before loading optional updates.
  const updateStartupTimer = setTimeout(startUpdateChecker, 5000);
  updateStartupTimer.unref();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function releaseStorageForExit() {
  const errors = [];
  // Explicitly release native SQLite handles before Electron destroys its Node environment.
  if (fastgcTranslatePersistWriteTimer) {
    clearTimeout(fastgcTranslatePersistWriteTimer);
    fastgcTranslatePersistWriteTimer = null;
  }
  if (fastgcTranslatePersistDirty) {
    try {
      const entries = Array.from(fastgcTranslatePersistMap.entries())
        .sort((a,b) => b[1].lastHitAt - a[1].lastHitAt)
        .slice(0, FASTGC_TRANSLATE_PERSIST_MAX)
        .map(([key,value]) => [key,value.text,value.lastHitAt]);
      const descriptor = fs.openSync(fastgcTranslatePersistPath(), 'w');
      try {
        fs.writeFileSync(descriptor, JSON.stringify({v:1,entries}), 'utf8');
        fs.fsyncSync(descriptor);
      } finally { fs.closeSync(descriptor); }
      fastgcTranslatePersistDirty = false;
    } catch (error) { errors.push(String(error.message || error)); }
  }
  if (storageDb) {
    try { storageDb.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (error) { errors.push(String(error.message || error)); }
    try { storageDb.close(); storageDb = null; storageDbReady = false; } catch (error) { errors.push(String(error.message || error)); }
  }
  return { ok: errors.length === 0, errors };
}

let finalExitStarted = false;
app.on('window-all-closed', () => {
  if (process.platform === 'darwin' || finalExitStarted) return;
  finalExitStarted = true;
  void (async () => {
    const storage = releaseStorageForExit();
    if (!storage.ok) throw new Error('Storage flush failed: ' + storage.errors.join('; '));
    // Guests have unloaded; persist session cookies before arming any exit guard.
    const drained = await drainSessionsForExit(activeBrowserSessions);
    writeDiagnosticLog('shutdown-storage-flushed', drained);
    try {
      const guard = await armWindowsShutdownGuard({ logFile: diagnosticLogPath() });
      writeDiagnosticLog('shutdown-guard-armed', guard);
    } catch (error) { writeDiagnosticLog('shutdown-guard-unavailable', { message: String(error.message || error) }); }
    app.quit();
  })().catch(error => {
    finalExitStarted = false;
    writeDiagnosticLog('shutdown-flush-failed', { message: String(error.message || error) });
    createWindow();
    dialog.showMessageBox({ type: 'error', title: 'FastGC WhatsApp', message: '数据尚未完成保存，已保留程序窗口。请稍后重试退出。\nData could not be fully saved. The application remains open; retry closing it shortly.' }).catch(() => {});
  });
});

app.on('will-quit', releaseStorageForExit);
