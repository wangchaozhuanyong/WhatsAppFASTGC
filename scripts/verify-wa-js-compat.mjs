import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import babel from '@babel/standalone';
import { patchWaJsForCurrentWhatsApp } from './wa-js-compat.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'node_modules/@wppconnect/wa-js/dist/wppconnect-wa.js'), 'utf8');
const patched = patchWaJsForCurrentWhatsApp(source);

function fanoutWrapper(code) {
  const { ast } = babel.transform(code, { ast: true, code: false, sourceType: 'script' });
  const matches = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.arguments[0]?.type === 'MemberExpression' &&
        node.arguments[0].property?.name === 'createFanoutMsgStanza' &&
        node.arguments[1]?.type === 'ArrowFunctionExpression') {
      matches.push(node.arguments[1]);
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object' && child.type) visit(child);
    }
  }
  visit(ast);
  assert.equal(matches.length, 1, 'locate the actual packaged fanout hook');
  const node = matches[0];
  return vm.runInNewContext(`(${code.slice(node.start, node.end)})`);
}

const original = fanoutWrapper(source);
const compatible = fanoutWrapper(patched);
const modernPayload = Object.freeze({ msg: Object.freeze({ id: 'regression-self-test' }) });
await assert.rejects(() => original(async () => 'native-ok', modernPayload), /reading 'id'/);

for (const args of [
  [modernPayload],
  [modernPayload, undefined],
  [modernPayload, null],
  [{}, { conversation: 'plain text' }],
  [{}, { id: 'legacy-msg' }, { conversation: 'plain text' }],
]) {
  const nativeResult = Object.freeze({ accepted: true });
  let calls = 0;
  const actual = await compatible(async (...received) => {
    calls++;
    assert.equal(received.length, args.length);
    received.forEach((value, i) => assert.equal(value, args[i]));
    return nativeResult;
  }, ...args);
  assert.equal(actual, nativeResult, 'preserve the native return value');
  assert.equal(calls, 1, 'delegate exactly once, without duplicate sends');
}

const nativeFailure = new Error('native-transport-failure');
await assert.rejects(() => compatible(async () => { throw nativeFailure; }, modernPayload), e => e === nativeFailure);

// 用实际生成的 Store 适配循环验证官网当前与旧版的消息集合都能解析。
const { ast: patchedAst } = babel.transform(patched, { ast: true, code: false, sourceType: 'script' });
let storeLoop;
function findStoreLoop(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'ForOfStatement' && patched.slice(node.start, node.end).includes('MsgStore"===e')) storeLoop = node;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(findStoreLoop);
    else if (value && typeof value === 'object' && value.type) findStoreLoop(value);
  }
}
findStoreLoop(patchedAst);
assert.ok(storeLoop, 'locate the packaged message Store adapter');
class MessageCollection {}
for (const modern of [true, false]) {
  const collection = new MessageCollection();
  const nativeModule = modern ? { Msg: collection } : { default: collection };
  const target = {};
  vm.runInNewContext(patched.slice(storeLoop.start, storeLoop.end), {
    c: ['MsgStore'], t: target, s: { MsgCollection: MessageCollection },
    u: { exportModule(exports, mappings, predicate) {
      assert.equal(predicate(nativeModule, modern ? 'WAWebCollections' : 'legacy-store'), true);
      assert.equal(predicate({ Msg: collection }, 'unrelated-module'), false);
      for (const [key, names] of Object.entries(mappings)) exports[key] = names.map(name => nativeModule[name]).find(Boolean);
    } },
  });
  assert.equal(target.MsgStore, collection);
}
assert.throws(() => patchWaJsForCurrentWhatsApp('unrecognised upstream bundle'), /review the installed WA-JS/);
console.log('PASS: reproduced the old send failure; modern/legacy arguments delegate once; both message Store exports resolve; native failures remain visible; unknown bundles fail packaging.');
