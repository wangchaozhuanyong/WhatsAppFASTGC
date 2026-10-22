const assert = require('node:assert/strict');
const { drainSessionsForExit } = require('../shutdown-flow');
(async () => {
  const events = [];
  const session = {flushStorageData(){events.push('storage')},cookies:{async flushStore(){events.push('cookies')}},async closeAllConnections(){events.push('connections')}};
  const normal = await drainSessionsForExit([session,session]);
  assert.deepEqual(events,['storage','cookies','connections']);
  assert.deepEqual(normal,{sessionCount:1,connectionsClosed:1,connectionWarnings:0});
  let disconnected=false;
  const hanging = {flushStorageData(){},cookies:{flushStore(){return new Promise(()=>{})}},closeAllConnections(){disconnected=true}};
  await assert.rejects(drainSessionsForExit([hanging],{flushTimeoutMs:20}),{code:'SESSION_FLUSH_TIMEOUT'});
  assert.equal(disconnected,false);
  const failing = {...hanging,cookies:{async flushStore(){throw new Error('disk failure')}}};
  await assert.rejects(drainSessionsForExit([failing]),/disk failure/);assert.equal(disconnected,false);
  const network = {...session,closeAllConnections(){return new Promise(()=>{})}};
  const warned=await drainSessionsForExit([network],{connectionTimeoutMs:20});
  assert.equal(warned.connectionsClosed,0);assert.equal(warned.connectionWarnings,1);
  console.log(JSON.stringify({passed:true,duplicateSessionsFlushedOnce:true,storageFailureDoesNotDisconnect:true,flushDeadline:true,connectionDeadline:true}));
})().catch(error=>{console.error(error);process.exitCode=1});
