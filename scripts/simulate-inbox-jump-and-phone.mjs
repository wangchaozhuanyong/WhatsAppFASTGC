/**
 * 模拟检测：全局汇聚左侧点击跳转聊天的目标推导 + 宿主内打开脚本链路结构；
 * 并复用打包后的 FastGcWaShared（与 index.html / TS 同源）。
 *
 * 运行：node scripts/simulate-inbox-jump-and-phone.mjs
 * （缺 bundle 时会由 load-fastgc-bundle 触发 npm run build:renderer-ts）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFastGcWaShared } from './load-fastgc-bundle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projRoot = path.resolve(__dirname, '..');
const indexPath = path.join(projRoot, 'index.html');

function assert(name, ok, detail = '') {
  if (!ok) {
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
    return false;
  }
  console.log(`OK: ${name}`);
  return true;
}

/** 与 index.html openContactRecord 内 itemChatId / phone / displayName / isGroup 推导一致 */
function deriveOpenContactJumpTarget(record, peekCachedPhoneForChatKey, S) {
  const itemChatId = S.normalizeWaChatKey(record.chatId || '');
  const cachedPhone = itemChatId ? peekCachedPhoneForChatKey(itemChatId) : '';
  const phone = S.normalizePhone(
    record.phone || cachedPhone || S.phoneFromWaChatKey(itemChatId) || '',
  );
  const displayName = String(record.sourceChat || record.name || '').trim();
  const isGroup = Boolean(record.isGroup || S.isWaGroupChatKey(itemChatId));
  return { itemChatId, phone, displayName, isGroup };
}

/** 与 index.html buildWaOpenChatByStableTargetScript 顶部 payload 一致 */
function buildStableTargetPayload(target, S) {
  return {
    chatId: S.normalizeWaChatKey(target.chatId || target.chatKey || ''),
    phone: S.normalizePhone(
      target.phone || S.phoneFromWaChatKey(target.chatId || target.chatKey || '') || '',
    ),
    displayName: String(target.displayName || target.title || '').trim(),
    isGroup: Boolean(target.isGroup || S.isWaGroupChatKey(target.chatId || target.chatKey || '')),
  };
}

function assertIndexHtmlJumpStructure(html) {
  const need = [
    'const openContactRecord = (record) =>',
    'buildWaOpenChatByStableTargetScript({',
    'chatId: itemChatId',
    'phone,',
    'displayName,',
    'isGroup,',
    'const clickToken = ++leftClickJumpTokenRef.current',
    'if (!isCurrentToken()) return',
    'leftClickJumpTokenRef.current === clickToken',
  ];
  for (const s of need) {
    assert(`index.html 含跳转/防串号片段: ${s.slice(0, 40)}…`, html.includes(s), `未找到: ${s}`);
  }
  /** 以「调用点」为准（函数声明顺序与执行顺序无关） */
  const iTryCall = html.indexOf('if (await tryInternalOpen()) return');
  const iPhoneCall = html.indexOf('const byPhone = await openByPhoneSearch()');
  const iNameCall = html.indexOf('const byName = await openByDisplayName()');
  assert(
    'buildWaOpenChatByStableTargetScript：先内部 openChat，再电话搜索，再显示名匹配',
    iTryCall !== -1 && iPhoneCall !== -1 && iNameCall !== -1 && iTryCall < iPhoneCall && iPhoneCall < iNameCall,
    `try=${iTryCall} phoneCall=${iPhoneCall} nameCall=${iNameCall}`,
  );
  const iGroupGuard = html.indexOf('if (!isGroup) {');
  const iPhoneBlock = html.indexOf('const byPhone = await openByPhoneSearch()');
  assert(
    '群聊不走电话搜索（isGroup 分支）',
    iGroupGuard !== -1 && iPhoneBlock !== -1 && iGroupGuard < iPhoneBlock,
  );
}

/** 全局汇聚「8-15」误判为日期 12:00 的修复：宿主 + WA_COLLECT_SCRIPT 对齐 + fallback + 展示兜底 */
function assertIndexHtmlInboxTimeSemantics(html) {
  assert(
    'parseInboxTimeTextToTs：无年 hyphen 两段不解析为日期',
    html.includes("if (!yRaw && sep === '-') return 0;"),
    '未找到 hyphen 无年分支',
  );
  assert(
    'parseInboxTimeTextToTs：无年且 slash 两段均 ≤12 视为歧义',
    html.includes("if (!yRaw && sep === '/' && p1 <= 12 && p2 <= 12) return 0;"),
    '未找到 slash 歧义分支',
  );
  assert(
    'normalizeInboxRecord：fallback 优先 lastMessage 时刻再 chatTimeText',
    html.includes('const fallbackTs = msgTimeTs || chatTs;'),
    '未找到 fallbackTs 顺序',
  );
  assert(
    'WA_COLLECT_SCRIPT.parseChatTime：与宿主 hyphen 规则一致',
    html.includes("if (!yRaw && sep === '-') return { text: '', ts: 0 };"),
    '未找到注入侧 hyphen 分支',
  );
  assert(
    'pickTimeTokenFromRowText：跳过纯 d-d 与歧义 d/d 候选',
    html.includes('if (/^\\\\d{1,2}-\\\\d{1,2}$/.test(cand)) continue;'),
    '未找到 hyphen token 过滤',
  );
  assert(
    'formatInboxTimeLabel：lastMessage 兜底匹配含 AM/PM',
    html.includes('const m = msg.match(/(\\d{1,2}:\\d{2}(?:\\s?[AP]M)?)(?!.*\\d{1,2}:\\d{2})/i);'),
    '未找到 AM/PM lastMessage 正则',
  );
}

const S = loadFastGcWaShared(projRoot);

// —— TS bundle 与采号前置条件 ——
assert('FastGcWaShared.normalizeWaChatKey(JID)', S.normalizeWaChatKey('601128850888@c.us') === '601128850888@c.us');
assert(
  'FastGcWaShared.phoneFromWaChatKey',
  S.phoneFromWaChatKey('601128850888@c.us') === '601128850888',
);
assert('群 @g.us 判组', S.isWaGroupChatKey('120363123456789@g.us') === true);
assert('status@broadcast 为动态会话', S.isWaStatusFeedChatKey('status@broadcast') === true);
assert(
  '侧栏标题「查看动态」归为动态行',
  S.isWaGlobalInboxStatusFeedRow({ name: '查看动态', phone: '' }) === true,
);
assert(
  '普通私聊不是动态行',
  S.isWaGlobalInboxStatusFeedRow({ name: 'Ali', chatId: '601128850888@c.us', phone: '601128850888' }) === false,
);

// —— 左侧点击：有 chatId 时电话可从 JID 推导 ——
const t1 = deriveOpenContactJumpTarget(
  { chatId: '601128850888@c.us', phone: '', sourceChat: 'Ali', name: 'Ali' },
  () => '',
  S,
);
assert(
  '跳转目标：仅有 JID 时仍得到 phone + displayName',
  t1.itemChatId === '601128850888@c.us' &&
    t1.phone === '601128850888' &&
    t1.displayName === 'Ali' &&
    t1.isGroup === false,
  JSON.stringify(t1),
);

// —— 缓存回填 ——
const t2 = deriveOpenContactJumpTarget(
  { chatId: '601199900000@c.us', phone: '', sourceChat: 'Bob' },
  (k) => (k === '601199900000@c.us' ? '601199900000' : ''),
  S,
);
assert('跳转目标：chatId 命中 peek 缓存时合并号码', t2.phone === '601199900000', JSON.stringify(t2));

// —— 群聊：无电话、isGroup ——
const t3 = deriveOpenContactJumpTarget(
  { chatId: '120363123456789@g.us', phone: '999', sourceChat: 'Team' },
  () => '',
  S,
);
assert(
  '跳转目标：群聊标记 isGroup + 保留 record.phone（宿主 normalizePhone 链不强制清空；打开脚本仍会跳过电话搜索）',
  t3.isGroup === true && t3.phone === '999' && t3.displayName === 'Team',
  JSON.stringify(t3),
);

// —— 打开脚本 payload（将嵌入 WebView） ——
const p1 = buildStableTargetPayload(
  { chatId: t1.itemChatId, phone: t1.phone, displayName: t1.displayName, isGroup: t1.isGroup },
  S,
);
assert(
  'stable payload 与推导一致',
  p1.chatId === '601128850888@c.us' && p1.phone === '601128850888' && p1.displayName === 'Ali',
  JSON.stringify(p1),
);
const embedded = JSON.stringify(p1);
assert('payload JSON 可被注入（无未转义换行）', !embedded.includes('\n') && embedded.includes('601128850888'), embedded);

// —— 静态检查宿主 HTML ——
const html = fs.readFileSync(indexPath, 'utf8');
assertIndexHtmlJumpStructure(html);
assertIndexHtmlInboxTimeSemantics(html);

if (process.exitCode) {
  console.error('\n部分断言失败。');
  process.exit(1);
}

console.log('\n【模拟检测】左侧面板跳转目标推导 + index.html 打开链路结构：全部通过。');
console.log('说明：真实 WebView 内 WPP/Store/DOM 需在应用内手动点一次验证。');
