const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWhatsAppPermissionPolicy } = require('../whatsapp-permissions');
const contents = () => Object.assign(new EventEmitter(), { getURL: () => 'https://web.whatsapp.com/', getType: () => 'webview', isDestroyed: () => false });
const ask = (policy, wc, permission, details) => new Promise(resolve => policy.request(wc, permission, resolve, details));
(async () => {
  let prompts = 0, allow = false;
  const policy = createWhatsAppPermissionPolicy({ requestApproval: async () => { prompts++; return allow; } });
  const wc = contents(), audio = { isMainFrame: true, mediaTypes: ['audio'], requestingUrl: wc.getURL(), securityOrigin: 'https://web.whatsapp.com' };
  assert.equal(policy.check(wc, 'media', wc.getURL(), { mediaType: 'audio' }), false);
  assert.equal(await ask(policy, wc, 'media', audio), false);
  allow = true;
  assert.deepEqual(await Promise.all([ask(policy, wc, 'media', audio), ask(policy, wc, 'media', audio)]), [true, true]);
  assert.equal(prompts, 2);
  assert.equal(policy.check(wc, 'media', wc.getURL(), { mediaType: 'audio' }), true);
  assert.equal(policy.check(wc, 'media', wc.getURL(), { mediaType: 'video' }), false);
  assert.equal(policy.check(wc, 'media', wc.getURL(), { mediaType: 'unknown' }), false);
  assert.equal(policy.check(contents(), 'media', wc.getURL(), { mediaType: 'audio' }), false);
  for (const details of [{ ...audio, isMainFrame: false }, { ...audio, requestingUrl: 'https://attacker.example/' }, { ...audio, securityOrigin: 'https://web.whatsapp.com.attacker.example/' }, { ...audio, mediaTypes: [] }, { ...audio, mediaTypes: ['display'] }]) {
    assert.equal(await ask(policy, wc, 'media', details), false);
  }
  assert.equal(await ask(policy, wc, 'display-capture', audio), false);
  const broken = contents();broken.getURL = () => { throw Error('destroyed'); };
  assert.equal(await ask(policy, broken, 'media', audio), false);
  assert.equal(policy.check(null, 'notifications', 'https://web.whatsapp.com', {}), true);
  assert.equal(policy.check(null, 'notifications', 'https://attacker.example', {}), false);
  wc.emit('did-navigate');
  assert.equal(policy.check(wc, 'media', wc.getURL(), { mediaType: 'audio' }), false);
  assert.equal(await ask(policy, wc, 'notifications', { requestingUrl: wc.getURL() }), true);
  const closing = contents(); let approve;
  const delayed = createWhatsAppPermissionPolicy({ requestApproval: () => new Promise(resolve => { approve = resolve; }) });
  const result = ask(delayed, closing, 'media', audio); await Promise.resolve(); closing.isDestroyed = () => true; approve(true); assert.equal(await result, false);
  console.log(JSON.stringify({ passed: true, promptsRespectChoice: true, deduplicated: true, mediaTypesIndependent: true, scopesToWhatsAppMainFrame: true, otherSeatsNotGranted: true, navigationRevokes: true, destroyedRequestsDenied: true, hardwareAccessed: false }));
})().catch(error => { console.error(error); process.exitCode = 1; });
