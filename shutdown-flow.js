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

module.exports = { drainSessionsForExit };
