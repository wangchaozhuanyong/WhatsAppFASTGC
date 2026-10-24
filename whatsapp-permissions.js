const MEDIA_TYPES = new Set(['audio', 'video']);
const BASIC_PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write']);

function isWhatsAppMediaOrigin(value) {
  try { return new URL(String(value || '')).origin === 'https://web.whatsapp.com'; }
  catch (_) { return false; }
}

function createWhatsAppPermissionPolicy({ requestApproval }) {
  const grants = new WeakMap();
  const pending = new WeakMap();
  const watched = new WeakSet();
  const revisions = new WeakMap();
  const trusted = (contents, origin, details = {}) => {
    if (details.isMainFrame === false) return false;
    if (!contents || contents.isDestroyed?.()) return false;
    if (contents.getType?.() !== 'webview' || !isWhatsAppMediaOrigin(contents.getURL?.())) return false;
    return [origin, details.requestingUrl, details.securityOrigin, details.embeddingOrigin]
      .filter(value => value !== undefined && value !== '').every(isWhatsAppMediaOrigin);
  };
  const watch = contents => {
    if (watched.has(contents)) return;
    watched.add(contents);
    const revoke = () => { grants.delete(contents); revisions.set(contents, (revisions.get(contents) || 0) + 1); };
    contents.once?.('destroyed', () => { revoke(); pending.delete(contents); });
    contents.on?.('did-navigate', revoke);
  };
  return {
    check(contents, permission, origin, details = {}) {
      if (!contents && permission === 'notifications') return isWhatsAppMediaOrigin(origin) &&
        [details.requestingUrl, details.securityOrigin].filter(Boolean).every(isWhatsAppMediaOrigin);
      if (!trusted(contents, origin, details)) return false;
      if (BASIC_PERMISSIONS.has(permission)) return true;
      return permission === 'media' && MEDIA_TYPES.has(details.mediaType) &&
        Boolean(grants.get(contents)?.has(details.mediaType));
    },
    request(contents, permission, callback, details = {}) {
      let replied = false;
      const finish = allowed => { if (!replied) { replied = true; callback(Boolean(allowed)); } };
      if (!trusted(contents, undefined, details)) return finish(false);
      if (BASIC_PERMISSIONS.has(permission)) return finish(true);
      const types = details.mediaTypes;
      if (permission !== 'media' || !Array.isArray(types) || !types.length || types.some(type => !MEDIA_TYPES.has(type))) return finish(false);
      watch(contents);
      const existing = grants.get(contents) || new Set();
      if (types.every(type => existing.has(type))) return finish(true);
      let jobs = pending.get(contents);
      if (!jobs) { jobs = new Map(); pending.set(contents, jobs); }
      const key = [...new Set(types)].sort().join(',');
      let job = jobs.get(key);
      if (!job) {
        const revision = revisions.get(contents) || 0;
        job = Promise.resolve().then(() => requestApproval({ contents, mediaTypes: [...new Set(types)] }))
          .then(allowed => {
            if (!allowed || revision !== (revisions.get(contents) || 0) || !trusted(contents, undefined, details)) return false;
            const next = grants.get(contents) || new Set();
            types.forEach(type => next.add(type)); grants.set(contents, next);
            return true;
          }).catch(() => false).finally(() => jobs.delete(key));
        jobs.set(key, job);
      }
      void job.then(finish);
    },
  };
}

module.exports = { createWhatsAppPermissionPolicy, isWhatsAppMediaOrigin };
