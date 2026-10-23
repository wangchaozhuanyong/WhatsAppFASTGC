// Google Cloud Translation Basic v2, explicitly pinned to the NMT model.
// Credentials stay in the main process and are encrypted by the operating system.
const fs = require('fs');
const path = require('path');
const { writeJsonDurably } = require('./durable-json');

const CONFIG_FILE = 'fastgc-cloud-translation.json';
const USAGE_FILE = 'fastgc-cloud-translation-usage.json';
const PERIOD_MS = 31 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_LIMIT = 450000;

function createCloudTranslation({ userDataDir, safeStorage, fetchImpl }) {
  let config;
  const controllers = new Set();
  const filePath = name => path.join(userDataDir(), name);
  const failure = error => ({ ok: false, error, provider: 'google-cloud-nmt', noFallback: true });
  const writeJson = (name, value) => {
    const file = filePath(name);
    writeJsonDurably(file, value);
  };
  const readConfig = () => {
    if (config) return config;
    try {
      if (!fs.existsSync(filePath(CONFIG_FILE))) return (config = { v: 1, provider: 'web', limit: DEFAULT_LIMIT });
      const saved = JSON.parse(fs.readFileSync(filePath(CONFIG_FILE), 'utf8'));
      if (saved.v !== 1 || !['web', 'google-cloud-nmt'].includes(saved.provider) ||
          !Number.isInteger(saved.limit) || saved.limit < 1 || saved.limit > DEFAULT_LIMIT) throw new Error('CONFIG_INVALID');
      return (config = saved);
    } catch (_) {
      // A damaged configuration must not silently switch the translation provider.
      return (config = { provider: 'google-cloud-nmt', limit: DEFAULT_LIMIT, error: 'CLOUD_CONFIG_UNREADABLE' });
    }
  };
  const getPolicy = () => {
    const saved = readConfig();
    return { ok: !saved.error, provider: saved.provider, error: saved.error || '' };
  };
  const readUsage = () => {
    const saved = readConfig();
    if (!fs.existsSync(filePath(USAGE_FILE))) {
      if (saved.usageRequired) throw new Error('CLOUD_USAGE_UNREADABLE');
      return { v: 1, buckets: [] };
    }
    const usage = JSON.parse(fs.readFileSync(filePath(USAGE_FILE), 'utf8'));
    if (usage.v !== 1 || !Array.isArray(usage.buckets) || usage.buckets.some(row =>
      !Array.isArray(row) || row.length !== 2 || !Number.isSafeInteger(row[0]) || row[0] < 0 ||
      !Number.isSafeInteger(row[1]) || row[1] < 0)) throw new Error('CLOUD_USAGE_UNREADABLE');
    return usage;
  };
  // Keep the entire oldest hour, so usage is never under-counted at a boundary.
  const recentBuckets = usage => usage.buckets.filter(([at]) => at + HOUR_MS > Date.now() - PERIOD_MS);
  const getStatus = () => {
    const saved = readConfig();
    let used = 0, error = saved.error || '';
    try { used = recentBuckets(readUsage()).reduce((sum, row) => sum + row[1], 0); }
    catch (_) { error = 'CLOUD_USAGE_UNREADABLE'; }
    return {
      ok: !error, error, provider: saved.provider, projectId: saved.projectId || '',
      hasKey: Boolean(saved.keyCipher), encryptionAvailable: safeStorage.isEncryptionAvailable(),
      limit: saved.limit, used, remaining: error ? 0 : Math.max(0, saved.limit - used), periodDays: 31,
    };
  };
  const saveConfig = payload => {
    const saved = readConfig();
    if (saved.error) return failure(saved.error);
    const provider = payload.provider;
    if (!['web', 'google-cloud-nmt'].includes(provider)) return failure('CLOUD_INVALID_PROVIDER');
    const projectId = String(payload.projectId || '').trim();
    const key = String(payload.apiKey || '').trim();
    const limit = Number(payload.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > DEFAULT_LIMIT) return failure('CLOUD_INVALID_LIMIT');
    if (provider === 'google-cloud-nmt' && !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) return failure('CLOUD_INVALID_PROJECT');
    if (key && !/^[A-Za-z0-9_-]{20,200}$/.test(key)) return failure('CLOUD_INVALID_KEY');
    if (provider === 'google-cloud-nmt' && projectId !== saved.projectId && !key) return failure('CLOUD_KEY_REQUIRED');
    if (provider === 'google-cloud-nmt' && !key && !saved.keyCipher) return failure('CLOUD_KEY_REQUIRED');
    try {
      if (key && !safeStorage.isEncryptionAvailable()) return failure('CLOUD_ENCRYPTION_UNAVAILABLE');
      const next = {
        v: 1, provider, projectId, limit, usageRequired: Boolean(saved.usageRequired),
        keyCipher: key ? safeStorage.encryptString(key).toString('base64') : (saved.keyCipher || ''),
      };
      if (provider === 'google-cloud-nmt') {
        // The ledger is shared across keys and providers; rotating keys cannot reset the limit.
        const usage = readUsage();
        writeJson(USAGE_FILE, usage);
        next.usageRequired = true;
      }
      writeJson(CONFIG_FILE, next);
      config = next;
      return getStatus();
    } catch (_) { return failure('CLOUD_SAVE_FAILED'); }
  };
  const reserveCharacters = count => {
    const saved = readConfig();
    const buckets = recentBuckets(readUsage());
    const used = buckets.reduce((sum, row) => sum + row[1], 0);
    if (used + count > saved.limit) return false;
    const hour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    const bucket = buckets.find(row => row[0] === hour);
    if (bucket) bucket[1] += count;
    else buckets.push([hour, count]);
    // Synchronous, durable reservation occurs before any await/network request.
    // Failed/ambiguous requests are deliberately not refunded or automatically retried.
    writeJson(USAGE_FILE, { v: 1, buckets });
    return true;
  };
  const translate = async (text, sourceLang, targetLang) => {
    const saved = readConfig();
    if (saved.error) return failure(saved.error);
    if (saved.provider !== 'google-cloud-nmt') return failure('CLOUD_NOT_SELECTED');
    if (!saved.keyCipher) return failure('CLOUD_KEY_REQUIRED');
    const count = Array.from(text).length;
    if (!count) return failure('EMPTY');
    if (count > 5000) return failure('CLOUD_TEXT_TOO_LONG');
    let key;
    try {
      if (!safeStorage.isEncryptionAvailable()) return failure('CLOUD_ENCRYPTION_UNAVAILABLE');
      key = safeStorage.decryptString(Buffer.from(saved.keyCipher, 'base64'));
    } catch (_) { return failure('CLOUD_KEY_UNREADABLE'); }
    try { if (!reserveCharacters(count)) return failure('CLOUD_LOCAL_LIMIT_REACHED'); }
    catch (_) { return failure('CLOUD_USAGE_UNREADABLE'); }
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 18000);
    try {
      const response = await fetchImpl('https://translation.googleapis.com/language/translate/v2', {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'X-goog-api-key': key },
        body: JSON.stringify({ q: text, target: targetLang, format: 'text', model: 'nmt', ...(sourceLang === 'auto' ? {} : { source: sourceLang }) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = response.status === 400 ? 'CLOUD_INVALID_REQUEST' :
          response.status === 401 ? 'CLOUD_KEY_REJECTED' :
          response.status === 403 ? 'CLOUD_PERMISSION_OR_BILLING' :
          response.status === 429 ? 'CLOUD_RATE_OR_QUOTA_LIMIT' : 'CLOUD_SERVICE_UNAVAILABLE';
        return { ...failure(error), status: response.status };
      }
      const body = await response.json();
      const out = body?.data?.translations?.[0]?.translatedText;
      if (typeof out !== 'string' || !out.trim()) return failure('CLOUD_EMPTY_RESPONSE');
      return { ok: true, text: out, provider: 'google-cloud-nmt', noFallback: true, characters: count };
    } catch (_) { return failure('CLOUD_NETWORK_OR_TIMEOUT'); }
    finally { clearTimeout(timer); controllers.delete(controller); key = ''; }
  };
  const cancelPending = () => { const count = controllers.size; for (const controller of controllers) controller.abort(); return count; };
  return { getPolicy, getStatus, saveConfig, translate, cancelPending };
}

module.exports = { createCloudTranslation };
