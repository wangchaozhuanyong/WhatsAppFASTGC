const { contextBridge, ipcRenderer } = require('electron');

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
