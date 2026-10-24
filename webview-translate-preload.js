const { contextBridge, ipcRenderer } = require('electron');
const { installSeatFingerprint } = require('./seat-fingerprint');

if (process.isMainFrame && location.protocol === 'https:' && location.hostname === 'web.whatsapp.com') {
  try {
    const profile = ipcRenderer.sendSync('fastgc:seat-environment-profile');
    if (!profile?.ok) throw new Error(profile?.error || 'SEAT_ENVIRONMENT_UNAVAILABLE');
    const status = contextBridge.executeInMainWorld({ func: installSeatFingerprint, args: [profile.profile] });
    if (!status?.ok) throw new Error('SEAT_ENVIRONMENT_INSTALL_FAILED');
    ipcRenderer.send('fastgc:seat-environment-status', status);
  } catch (_) {
    ipcRenderer.send('fastgc:seat-environment-status', { ok: false, error: 'SEAT_ENVIRONMENT_INSTALL_FAILED' });
  }
}

contextBridge.exposeInMainWorld('__fastgcTranslateBridge', {
  getPolicy() {
    return ipcRenderer.sendSync('fastgc:translate-policy');
  },
  translate(text, sourceLang, targetLang) {
    return ipcRenderer.invoke('fastgc:google-translate', { text, sourceLang, targetLang });
  },
});

contextBridge.exposeInMainWorld('__fastgcHostBridge', {
  emit(eventName, payload) {
    try {
      ipcRenderer.sendToHost('fastgc-wa-event', {
        event: String(eventName || ''),
        payload: payload == null ? null : payload,
        ts: Date.now(),
      });
      return true;
    } catch (_) {
      return false;
    }
  },
});

contextBridge.exposeInMainWorld('__fastgcClipboardBridge', {
  copyText(text) {
    return ipcRenderer.invoke('fastgc:clipboard-write-text', String(text || ''));
  },
  copyImageBuffer(bytes) {
    return ipcRenderer.invoke('fastgc:clipboard-write-image-buffer', { bytes });
  },
});
