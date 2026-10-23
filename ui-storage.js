(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FastgcUiStorage = api;
})(typeof window === 'object' ? window : globalThis, function () {
  const migrationKey = '__fastgc_host_ui_storage_v1__';
  const retiredKeys = ['fastgc_api_config', 'fastgc_crm_right_panel_width_px', 'fastgc_crm_right_panel_collapsed'];
  const isKey = key => typeof key === 'string' && !retiredKeys.includes(key) && /^(fastgc_[a-z0-9_]{1,100}|__fastgc_sqlite_migration_v1__|__fastgcWaPhoneRequestTokenSeed|content_manager_data|reward_phone_system_data)$/.test(key);
  function createBackend(getDb) {
    const snapshot = () => {
      const db = getDb();
      if (!db) return { ok: false, error: 'STORAGE_UNAVAILABLE' };
      const data = {};
      for (const row of db.prepare('SELECT key,value FROM app_kv').all()) if (isKey(row.key)) data[row.key] = row.value;
      return { ok: true, migrated: db.prepare('SELECT value FROM app_kv WHERE key=?').get(migrationKey)?.value === '1', data };
    };
    return {
      snapshot,
      migrate(items) {
        const db = getDb();
        if (!db || !Array.isArray(items) || items.some(item => !isKey(item?.key) || typeof item.value !== 'string')) return { ok: false, error: 'INVALID_MIGRATION' };
        try {
          db.exec('BEGIN IMMEDIATE');
          // SQLite records, including intentional empty values, are authoritative.
          const insert = db.prepare('INSERT INTO app_kv(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING');
          for (const item of items) insert.run(item.key, item.value, Date.now());
          db.prepare('INSERT INTO app_kv(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(migrationKey, '1', Date.now());
          db.exec('COMMIT');
          return snapshot();
        } catch (_) { try { db.exec('ROLLBACK'); } catch (_) {} return { ok: false, error: 'MIGRATION_FAILED' }; }
      },
      mutate(key, value, remove) {
        const db = getDb();
        if (!db || !isKey(key) || (!remove && typeof value !== 'string')) return { ok: false, error: 'INVALID_STORAGE_WRITE' };
        try {
          if (remove) db.prepare('DELETE FROM app_kv WHERE key=?').run(key);
          else db.prepare('INSERT INTO app_kv(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(key, value, Date.now());
          return { ok: true };
        } catch (_) { return { ok: false, error: 'STORAGE_WRITE_FAILED' }; }
      },
    };
  }
  function createClient(bridge, legacyFactory, onError = () => {}) {
    let state = bridge.uiStorageSnapshotSync();
    const fail = () => { onError(); throw new Error('UI_STORAGE_UNAVAILABLE'); };
    if (!state?.ok) return fail();
    const migratedNow = !state.migrated;
    if (!state.migrated) {
      // Access Chromium DOMStorage only for the one-time migration. A failed
      // enumeration never writes a completion marker or replaces saved state.
      const legacy = legacyFactory(), items = [];
      for (let i = 0; i < legacy.length; i++) {
        const key = legacy.key(i);
        if (isKey(key)) items.push({ key, value: String(legacy.getItem(key) ?? '') });
      }
      state = bridge.uiStorageMigrateSync(items);
      if (!state?.ok || !state.migrated) return fail();
      for (const key of retiredKeys) { try { legacy.removeItem(key); } catch (_) {} }
    }
    const values = new Map(Object.entries(state.data));
    return {
      migratedNow,
      get length() { return values.size; },
      key(index) { return [...values.keys()][Number(index)] ?? null; },
      getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
      setItem(key, value) {
        key = String(key); value = String(value);
        if (values.has(key) && values.get(key) === value) return;
        if (!isKey(key) || !bridge.uiStorageMutateSync(key, value, false)?.ok) return fail();
        values.set(key, value);
      },
      removeItem(key) {
        key = String(key);
        if (retiredKeys.includes(key) || !values.has(key)) return;
        if (!bridge.uiStorageMutateSync(key, '', true)?.ok) return fail();
        values.delete(key);
      },
    };
  }
  return { createBackend, createClient, isKey, migrationKey, retiredKeys };
});
