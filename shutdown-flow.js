function withDeadline(promise, timeoutMs, code) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

async function drainSessionsForExit(sessions, { flushTimeoutMs = 10000, connectionTimeoutMs = 2500 } = {}) {
  const active = [...new Set(sessions)];
  // Never arm a termination guard or disconnect sessions before all required
  // persistence operations have succeeded. A timeout returns to the open UI.
  await withDeadline(Promise.all(active.map(async current => {
    current.flushStorageData();
    await current.cookies.flushStore();
  })), flushTimeoutMs, 'SESSION_FLUSH_TIMEOUT');
  const connections = await Promise.allSettled(active.map(current =>
    withDeadline(Promise.resolve().then(() => current.closeAllConnections()), connectionTimeoutMs, 'SESSION_CONNECTION_TIMEOUT')
  ));
  return { sessionCount: active.length, connectionsClosed: connections.filter(result => result.status === 'fulfilled').length, connectionWarnings: connections.filter(result => result.status !== 'fulfilled').length };
}

async function stopGuestWorkersForExit(guests, { timeoutMs = 1200 } = {}) {
  const results = await Promise.allSettled([...new Set(guests)].map(async guest => {
    if (guest.isDestroyed()) return;
    const debuggerApi = guest.debugger;
    const attachedHere = !debuggerApi.isAttached();
    try {
      if (attachedHere) debuggerApi.attach('1.3');
      // Stop running workers without unregistering them or clearing account data.
      await withDeadline(debuggerApi.sendCommand('ServiceWorker.stopAllWorkers'), timeoutMs, 'WORKER_STOP_TIMEOUT');
    } finally {
      if (attachedHere && !guest.isDestroyed() && debuggerApi.isAttached()) debuggerApi.detach();
    }
  }));
  return { guests: results.length, stopped: results.filter(r => r.status === 'fulfilled').length, warnings: results.filter(r => r.status === 'rejected').length };
}

module.exports = { drainSessionsForExit, stopGuestWorkersForExit };
