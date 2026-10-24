const { contextBridge, ipcRenderer } = require('electron');
const preloadTiming = { started: performance.now() };

contextBridge.exposeInMainWorld('fastgcBridge', {
  uiStorageSnapshotSync() {
    return ipcRenderer.sendSync('app:ui-storage-snapshot-sync');
  },
  uiStorageMigrateSync(items) {
    return ipcRenderer.sendSync('app:ui-storage-migrate-sync', items);
  },
  uiStorageMutateSync(key, value, remove) {
    return ipcRenderer.sendSync('app:ui-storage-mutate-sync', { key, value, remove });
  },
  openExternal(url) {
    return ipcRenderer.invoke('app:open-external', { url });
  },
  getWhatsAppUserAgent() {
    return ipcRenderer.invoke('app:whatsapp-user-agent');
  },
  getAppVersion() {
    return ipcRenderer.invoke('app:get-app-version');
  },
  getWebviewTranslatePreloadUrl() {
    return ipcRenderer.invoke('app:webview-translate-preload-url');
  },
  waWebviewDevtoolsEnabled() {
    return ipcRenderer.invoke('app:wa-webview-devtools-enabled');
  },
  /** @wppconnect/wa-js 官方打包脚本（与源码 dist 一致），注入 WhatsApp WebView */
  readWaJsBundle() {
    return ipcRenderer.invoke('fastgc:wa-js-bundle');
  },
  setUiLocale(locale) {
    return ipcRenderer.invoke('app:set-ui-locale', locale);
  },
  getUiLocale() {
    return ipcRenderer.invoke('app:get-ui-locale');
  },
  getAccessControl() {
    return ipcRenderer.invoke('app:get-access-control');
  },
  setAccessControl(payload) {
    return ipcRenderer.invoke('app:set-access-control', payload);
  },
  verifyAccessPassword(password) {
    return ipcRenderer.invoke('app:verify-access-password', password);
  },
  getDataRoot() {
    return ipcRenderer.invoke('app:get-data-root');
  },
  setDataRoot(payload) {
    return ipcRenderer.invoke('app:set-data-root', payload);
  },
  browseDataRoot() {
    return ipcRenderer.invoke('app:browse-data-root');
  },
  getUpdateFeed() {
    return ipcRenderer.invoke('app:get-update-feed');
  },
  setUpdateFeed(payload) {
    return ipcRenderer.invoke('app:set-update-feed', payload);
  },
  checkUpdatesNow() {
    return ipcRenderer.invoke('app:check-updates-now');
  },
  setTaskbarUnreadCount(count) {
    return ipcRenderer.invoke('app:set-taskbar-unread-count', count);
  },
  getDiagnosticsSnapshot() {
    return ipcRenderer.invoke('app:get-diagnostics-snapshot');
  },
  getRuntimeSnapshot() {
    return ipcRenderer.invoke('app:get-runtime-snapshot');
  },
  clearTranslateCache() {
    return ipcRenderer.invoke('app:clear-translate-cache');
  },
  getCloudTranslation() {
    return ipcRenderer.invoke('app:get-cloud-translation');
  },
  setCloudTranslation(payload) {
    return ipcRenderer.invoke('app:set-cloud-translation', payload);
  },
  checkCloudTranslation() {
    return ipcRenderer.invoke('app:check-cloud-translation');
  },
  getSeatConfig() {
    return ipcRenderer.invoke('app:get-seat-config');
  },
  setSeatConfig(payload) {
    return ipcRenderer.invoke('app:set-seat-config', payload);
  },
  storageGet(payload) {
    return ipcRenderer.invoke('app:storage-get', payload);
  },
  storageGetSync(key) {
    return ipcRenderer.sendSync('app:storage-get-sync', { key });
  },
  storageSetSync(key, value) {
    return ipcRenderer.sendSync('app:storage-set-sync', { key, value });
  },
  storageSet(payload) {
    return ipcRenderer.invoke('app:storage-set', payload);
  },
  storageMigrateBatch(payload) {
    return ipcRenderer.invoke('app:storage-migrate-batch', payload);
  },
});

try {
  const started = performance.now();
  contextBridge.exposeInMainWorld('__FASTGC_SEAT_CONFIG__', ipcRenderer.sendSync('app:get-seat-config-sync'));
  preloadTiming.seatConfigMs = performance.now() - started;
} catch (_) {}
try {
  const started = performance.now();
  const snap = ipcRenderer.sendSync('app:storage-snapshot-sync', {
    keys: [
      'fastgc_global_inbox',
      'content_manager_data',
      'reward_phone_system_data',
      'fastgc_custom_links',
      '__fastgc_sqlite_migration_v1__',
    ],
  });
  contextBridge.exposeInMainWorld('__FASTGC_STORAGE_SNAPSHOT__', snap && snap.ok && snap.data ? snap.data : {});
  preloadTiming.storageSnapshotMs = performance.now() - started;
} catch (_) {}
try { contextBridge.exposeInMainWorld('__FASTGC_PRELOAD_TIMING__', { ...preloadTiming, completed: performance.now() }); } catch (_) {}
