/**
 * 模拟测试：WhatsApp 联系人采号逻辑（与 index.html 中同名函数行为对齐）。
 * normalizeWaChatKey / normalizePhone 等来自打包产物 FastGcWaShared（与 src/ TS 同源）。
 *
 * 运行：node scripts/simulate-wa-phone-sync.mjs
 */

import { loadFastGcWaShared } from './load-fastgc-bundle.mjs';

const { normalizePhone, normalizeWaChatKey, phoneFromWaChatKey, isWaGroupChatKey } =
  loadFastGcWaShared();

const digitsLookLikeMillisTimestamp = (digits) => {
  const d = normalizePhone(String(digits || ''));
  if (d.length < 12 || d.length > 14) return false;
  const n = Number(d);
  if (!Number.isFinite(n) || n < 1_000_000_000_000 || n > 20_000_000_000_000) return false;
  const y = new Date(n).getUTCFullYear();
  return y >= 2019 && y <= 2038;
};

const derivePhoneFromLooseText = (s) => {
  const m = String(s || '').match(/\+?\d[\d \t\u00a0\u202f().-]{5,}\d/g);
  if (!m || !m.length) return '';
  const scored = [...m]
    .map((x) => ({ raw: x, digits: normalizePhone(x) }))
    .filter((o) => o.digits && !digitsLookLikeMillisTimestamp(o.digits))
    .sort((a, b) => b.digits.length - a.digits.length);
  if (!scored.length) return '';
  return scored[0].digits;
};

const isPlausibleWaPhone = (raw) => {
  const d = normalizePhone(String(raw || ''));
  if (d.length < 8) return false;
  if (digitsLookLikeMillisTimestamp(d)) return false;
  return true;
};

/**
 * 与 index.html 内 unifiedResolvePrivatePhone 一致（含 snap.isGroup + 私聊 JID 兜底）。
 */
function createUnifiedResolve(peekProfile, peekChatKeyMap) {
  return function unifiedResolvePrivatePhone(snap, recPhoneFallback = '', opts = {}) {
    const allowRecordFallback = opts?.allowRecordFallback !== false;
    const allowCache = opts?.allowCache !== false;
    const chatKey = String(snap?.chatKey || '').trim();
    const chatKeyNorm = normalizeWaChatKey(chatKey);
    const jidIsGroupWa = isWaGroupChatKey(chatKeyNorm);
    const jidClearlyPrivateDm =
      !jidIsGroupWa &&
      (/^\d{8,16}@c\.us$/i.test(chatKeyNorm) || /^\d{5,}@lid\b/i.test(chatKeyNorm));
    const isGroup = jidIsGroupWa || (!jidClearlyPrivateDm && Boolean(snap?.isGroup));
    const snapTitle = String(snap?.title || '').trim();
    const sideListTitle = String(snap?.sideListTitle || '').trim();
    const profileNameForCache =
      sideListTitle || snapTitle || String(snap?.subtitle || '').trim() || chatKey;
    const profileSnapHint = { avatar: String(snap?.avatar || '').trim(), title: profileNameForCache };
    if (isGroup) {
      return { isGroup: true, phone: '', chatKey, profileNameForCache, profileSnapHint, source: '' };
    }
    let phone = normalizePhone(snap?.phone || '');
    let source = phone ? 'snapshot-phone' : '';
    if (!phone) {
      phone =
        derivePhoneFromLooseText(snap?.title) ||
        derivePhoneFromLooseText(snap?.subtitle) ||
        phoneFromWaChatKey(chatKeyNorm) ||
        derivePhoneFromLooseText(chatKey);
      if (phone) source = 'snapshot-text';
    }
    if (!phone && allowRecordFallback && isPlausibleWaPhone(recPhoneFallback)) {
      phone = normalizePhone(recPhoneFallback);
      source = 'record';
    }
    if (!isPlausibleWaPhone(phone)) phone = '';
    if (!phone && allowCache && chatKey) {
      const cached = peekChatKeyMap(chatKey);
      if (cached && isPlausibleWaPhone(cached)) {
        phone = cached;
        source = 'chat-cache';
      }
    }
    if (!phone && allowCache) {
      const profHit = peekProfile(snap?.avatar, profileNameForCache);
      if (isPlausibleWaPhone(profHit)) {
        phone = profHit;
        source = 'profile-cache';
      }
    }
    return {
      isGroup: false,
      phone: isPlausibleWaPhone(phone) ? normalizePhone(phone) : '',
      source,
      chatKey,
      profileNameForCache,
      profileSnapHint,
    };
  };
}

function waPhoneCommitSourceRank(src = '') {
  const s = String(src || '').trim();
  if (s === 'drawer') return 400;
  if (s === 'manual') return 320;
  if (s === 'snapshot-phone') return 300;
  if (s === 'snapshot' || s === 'snapshot-text') return 200;
  if (s === 'profile-cache') return 150;
  if (s === 'chat-cache') return 120;
  return 100;
}

function isWaCommitDrawerPhoneMinimalSim(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return false;
  if (!/^\+?\s*[\d\s().\-]+$/.test(trimmed.replace(/\s+/g, ' '))) return false;
  const coreDigits = trimmed.startsWith('+')
    ? normalizePhone(trimmed.slice(1))
    : normalizePhone(trimmed);
  if (!coreDigits || coreDigits.length < 6) return false;
  if (digitsLookLikeMillisTimestamp(coreDigits)) return false;
  return true;
}

/**
 * 对齐宿主 commitWaPhoneToInboxContact 顺序：
 * token → chatKey → 号码（drawer 形状 / 其它 plausible）→ 同号（manual 除外）→ 来源秩
 */
function commitWouldAccept(opts) {
  const { waActiveChatKeyRef, chatKeyRaw, contactId, phoneRaw, source, row, requestTokenIncoming } = opts;
  const phone = normalizePhone(phoneRaw || '');
  const incomingSrc = String(source || '').trim();
  const fromDrawer = incomingSrc === 'drawer';
  const isManual = incomingSrc === 'manual';
  if (!contactId) return false;

  const rowTok =
    typeof row?.requestToken === 'number' && Number.isFinite(row.requestToken) && row.requestToken >= 0
      ? row.requestToken
      : 0;
  const incomingTok =
    typeof requestTokenIncoming === 'number' && Number.isFinite(requestTokenIncoming)
      ? requestTokenIncoming
      : null;
  if (incomingTok === null || incomingTok !== rowTok) return false;

  const commitKey = normalizeWaChatKey(chatKeyRaw || waActiveChatKeyRef.current);
  const activeKeyNow = normalizeWaChatKey(waActiveChatKeyRef.current);
  if (commitKey && activeKeyNow && commitKey !== activeKeyNow) return false;

  if (fromDrawer) {
    if (!isWaCommitDrawerPhoneMinimalSim(phoneRaw)) return false;
  } else if (!phone || !isPlausibleWaPhone(phone)) return false;

  /** 与宿主一致：同号不写但算成功（幂等），便于后续联系人同步 / 早退分支 */
  if (!fromDrawer && !isManual) {
    const pp = normalizePhone(row?.phone || '');
    if (pp && pp === phone) return true;
  }

  const incoming = incomingSrc;
  const prevNorm = normalizePhone(row?.phone || '');
  const nextNorm = phone;
  if (incoming === 'drawer') {
    return Boolean(nextNorm) && nextNorm.length >= 6 && !digitsLookLikeMillisTimestamp(nextNorm);
  }
  if (!isPlausibleWaPhone(nextNorm)) return false;
  if (!prevNorm || !isPlausibleWaPhone(prevNorm)) return true;
  if (prevNorm === nextNorm) return true;
  const rowCk = normalizeWaChatKey(row?.chatId || '');
  const act = String(activeKeyNow || '').trim();
  const drawerFinal =
    Boolean(row) &&
    row.pendingCollect === false &&
    row.profileCollected === true &&
    !!rowCk &&
    !!act &&
    rowCk === act;
  if (drawerFinal) return false;
  const prevRank = waPhoneCommitSourceRank(row?.profileSource || '');
  const incRank = waPhoneCommitSourceRank(incoming);
  if (incRank < prevRank) return false;
  return true;
}

/** upsert 内 rawPhone 推导（与当前 index 一致） */
function deriveUpsertRawPhone(snapshot) {
  return (
    normalizePhone(snapshot.phone || '') ||
    derivePhoneFromLooseText(snapshot.title) ||
    derivePhoneFromLooseText(snapshot.subtitle) ||
    phoneFromWaChatKey(snapshot.chatKey) ||
    derivePhoneFromLooseText(snapshot.chatKey)
  );
}

function assert(name, cond, detail = '') {
  if (!cond) {
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
    return false;
  }
  console.log(`OK: ${name}`);
  return true;
}

const staleCache = new Map([
  [normalizeWaChatKey('601128850888@c.us'), '601128850888'],
  /** 无号码可推导的 chatKey，仅用于测 chat-cache */
  [normalizeWaChatKey('customer-alice-local'), '601115096025'],
]);
const peekChatKey = (k) => staleCache.get(normalizeWaChatKey(k)) || '';
/** 模拟「侧栏曾缓存过旧号」：按资料身份命中 */
const peekProfileStale = () => '601115096025';

const unified = createUnifiedResolve(peekProfileStale, peekChatKey);
/** 仅验证 chatKey 缓存路径（资料缓存为空） */
const unifiedChatCacheOnly = createUnifiedResolve(() => '', peekChatKey);

// 1) 用户截图类场景：标题含正确号码时，不得再用旧的 inbox 兜底（allowRecordFallback:false）
const snapMalaysia = {
  chatKey: '+60 11-2885 0888',
  title: '+60 11-2885 0888',
  subtitle: '',
  phone: '',
  isGroup: false,
};
const u1 = unified(snapMalaysia, '601115096025', { allowRecordFallback: false, allowCache: false });
assert(
  '标题解析为新号码且忽略旧 inbox 兜底',
  u1.phone === '601128850888' && u1.source === 'snapshot-text',
  JSON.stringify(u1),
);

// 2) 关闭缓存时，即使本地 Map 有旧号也不得冒出来
const u2 = unified({ ...snapMalaysia, title: 'Some Name', phone: '', chatKey: 'Some Name' }, '', {
  allowRecordFallback: false,
  allowCache: false,
});
assert('无号码且无快照文本时返回空（不读缓存）', u2.phone === '' && u2.source === '', JSON.stringify(u2));

const u3 = unifiedChatCacheOnly(
  {
    ...snapMalaysia,
    title: 'Some Name',
    subtitle: '',
    phone: '',
    chatKey: 'customer-alice-local',
  },
  '',
  { allowRecordFallback: false, allowCache: true },
);
assert(
  '开启缓存时可回填 chat-cache',
  u3.source === 'chat-cache' && u3.phone === '601115096025',
  JSON.stringify(u3),
);

// 3) 同行同 chatId 时，快照可覆盖已有号码（不再用 profileCollected 锁）
const row = {
  id: 'c1',
  phone: '601115096025',
  profileCollected: false,
  pendingCollect: true,
  profileSource: 'snapshot-text',
  chatId: normalizeWaChatKey('601115096025@c.us'),
  requestToken: 11,
};
assert(
  'commit 快照可覆盖与 chatId 一致的旧号（采集中）',
  commitWouldAccept({
    waActiveChatKeyRef: { current: normalizeWaChatKey('601115096025@c.us') },
    chatKeyRaw: normalizeWaChatKey('601115096025@c.us'),
    contactId: 'c1',
    phoneRaw: '601128850888',
    source: 'snapshot-text',
    row,
    requestTokenIncoming: 11,
  }),
);

assert(
  'commit requestToken 不一致则丢弃（防旧异步）',
  !commitWouldAccept({
    waActiveChatKeyRef: { current: normalizeWaChatKey('601115096025@c.us') },
    chatKeyRaw: normalizeWaChatKey('601115096025@c.us'),
    contactId: 'c1',
    phoneRaw: '601128850888',
    source: 'snapshot-text',
    row,
    requestTokenIncoming: 10,
  }),
);

assert(
  '非 drawer 同号 commit 幂等成功（不二次写 UI，但算通过）',
  commitWouldAccept({
    waActiveChatKeyRef: { current: row.chatId },
    chatKeyRaw: row.chatId,
    contactId: 'c1',
    phoneRaw: '601115096025',
    source: 'snapshot-phone',
    row,
    requestTokenIncoming: 11,
  }),
);

assert(
  'manual 同号仍放行（格式修正语义）',
  commitWouldAccept({
    waActiveChatKeyRef: { current: row.chatId },
    chatKeyRaw: row.chatId,
    contactId: 'c1',
    phoneRaw: '601115096025',
    source: 'manual',
    row,
    requestTokenIncoming: 11,
  }),
);

const rowDrawerFinal = {
  id: 'c2',
  phone: '601111111111',
  profileCollected: true,
  pendingCollect: false,
  profileSource: 'drawer',
  chatId: normalizeWaChatKey('601111111111@c.us'),
  requestToken: 12,
};
assert(
  'drawer 收束后弱来源不可改号',
  !commitWouldAccept({
    waActiveChatKeyRef: { current: rowDrawerFinal.chatId },
    chatKeyRaw: rowDrawerFinal.chatId,
    contactId: 'c2',
    phoneRaw: '601128850888',
    source: 'snapshot-text',
    row: rowDrawerFinal,
    requestTokenIncoming: 12,
  }),
);
assert(
  'drawer 收束后仍允许 drawer 覆盖',
  commitWouldAccept({
    waActiveChatKeyRef: { current: rowDrawerFinal.chatId },
    chatKeyRaw: rowDrawerFinal.chatId,
    contactId: 'c2',
    phoneRaw: '601199999999',
    source: 'drawer',
    row: rowDrawerFinal,
    requestTokenIncoming: 12,
  }),
);

const activeOther = normalizeWaChatKey('602222222222@c.us');
const rowMisaligned = {
  id: 'cMis',
  phone: '601100000001',
  profileCollected: true,
  pendingCollect: false,
  profileSource: 'snapshot-phone',
  chatId: normalizeWaChatKey('601111111111@c.us'),
  requestToken: 13,
};
assert(
  '行 chatId≠当前活跃会话时不触发收束锁，manual 可压 snapshot-phone',
  commitWouldAccept({
    waActiveChatKeyRef: { current: activeOther },
    chatKeyRaw: activeOther,
    contactId: 'cMis',
    phoneRaw: '601128850888',
    source: 'manual',
    row: rowMisaligned,
    requestTokenIncoming: 13,
  }),
);
assert(
  '同场景 snapshot-text 仍不可压过低优先级 snapshot-phone',
  !commitWouldAccept({
    waActiveChatKeyRef: { current: activeOther },
    chatKeyRaw: activeOther,
    contactId: 'cMis',
    phoneRaw: '601128850888',
    source: 'snapshot-text',
    row: rowMisaligned,
    requestTokenIncoming: 13,
  }),
);

// 4) commit：commitKey 与当前活跃会话不一致则拒绝（防竞态）；非 pendingCollect+row.chatId 硬拒
assert(
  'commit 拒绝跨会话竞态',
  !commitWouldAccept({
    waActiveChatKeyRef: { current: normalizeWaChatKey('+60 11-1111 1111') },
    chatKeyRaw: normalizeWaChatKey('+60 11-2885 0888'),
    contactId: 'c1',
    phoneRaw: '601128850888',
    source: 'snapshot-text',
    row,
    requestTokenIncoming: 11,
  }),
);

assert(
  'commit 同会话接受',
  commitWouldAccept({
    waActiveChatKeyRef: { current: normalizeWaChatKey('601128850888@c.us') },
    chatKeyRaw: normalizeWaChatKey('601128850888@c.us'),
    contactId: 'c1',
    phoneRaw: '601128850888',
    source: 'snapshot-text',
    row: {
      ...row,
      chatId: normalizeWaChatKey('601128850888@c.us'),
      phone: '',
      profileSource: 'snapshot-phone',
      requestToken: 14,
    },
    requestTokenIncoming: 14,
  }),
);

// 5) upsert rawPhone 推导
const raw = deriveUpsertRawPhone({
  phone: '',
  title: '+60 11-2885 0888',
  subtitle: '',
  chatKey: 'x',
});
assert('upsert 能从 title 抠号', raw === '601128850888', raw);

assert('chatKey 标准化为 JID', normalizeWaChatKey('+60 11-2885 0888') === '601128850888@c.us');
assert('JID 可直接推导号码', phoneFromWaChatKey('601128850888@c.us') === '601128850888');

const falseGroupSnap = unifiedChatCacheOnly(
  {
    chatKey: '601128850888@c.us',
    title: '',
    subtitle: '',
    phone: '',
    isGroup: true,
  },
  '',
  { allowRecordFallback: false, allowCache: false },
);
assert(
  'snap.isGroup 误判时：私聊 @c.us JID 仍采号（不被群逻辑挡掉）',
  !falseGroupSnap.isGroup &&
    falseGroupSnap.phone === '601128850888' &&
    falseGroupSnap.source === 'snapshot-text',
  JSON.stringify(falseGroupSnap),
);

const group = unifiedChatCacheOnly(
  /** @g.us 在 JID 上即群聊，与快照 isGroup 无关 */
  { title: 'Team', chatKey: '120363123456789@g.us', isGroup: false },
  '',
  { allowRecordFallback: true, allowCache: true },
);
assert(
  '群聊 @g.us 不采号',
  group.isGroup && group.phone === '',
  JSON.stringify(group),
);

const jidCacheHit = unifiedChatCacheOnly(
  { title: 'Anna', chatKey: '601128850888@c.us', phone: '', isGroup: false },
  '',
  { allowRecordFallback: false, allowCache: true },
);
assert(
  'chatKey(JID) 文本可推导为同一号码（或 chat-cache）',
  jidCacheHit.phone === '601128850888',
  JSON.stringify(jidCacheHit),
);

assert(
  'commit 手动来源亦可覆盖与 chatId 一致的旧号（优先于 snapshot-phone）',
  commitWouldAccept({
    waActiveChatKeyRef: { current: row.chatId },
    chatKeyRaw: row.chatId,
    contactId: 'c1',
    phoneRaw: '601128850888',
    source: 'manual',
    row: { ...row, profileSource: 'snapshot-phone', requestToken: 15 },
    requestTokenIncoming: 15,
  }),
);

// —— 「能否采到号」扩展场景（对齐宿主解析顺序） ——
const uSnapPhone = unified(
  { chatKey: 'x', title: '乱码 💬 骚扰', subtitle: '', phone: '+86 1390 0133 4455', isGroup: false },
  '601115096025',
  { allowRecordFallback: true, allowCache: false },
);
assert(
  '快照显式 phone 优先于兜底与噪音标题',
  uSnapPhone.phone === '86139001334455' && uSnapPhone.source === 'snapshot-phone',
  JSON.stringify(uSnapPhone),
);

const uSub = unified(
  { chatKey: 'contact-x', title: '仅昵称', subtitle: '备用 +1 (415) 555-0199', phone: '', isGroup: false },
  '',
  { allowRecordFallback: false, allowCache: false },
);
assert(
  '副标题可抠出手机号',
  uSub.phone === '14155550199' && uSub.source === 'snapshot-text',
  JSON.stringify(uSub),
);

const cacheWinMap = new Map([
  [normalizeWaChatKey('priority-chat-key'), '601100011222'],
]);
const peekCacheWin = (k) => cacheWinMap.get(normalizeWaChatKey(k)) || '';
const peekProfileOther = () => '601199933344';
const unifiedCacheFirst = createUnifiedResolve(peekProfileOther, peekCacheWin);
const uCacheOrder = unifiedCacheFirst(
  { chatKey: 'priority-chat-key', title: '', subtitle: '', phone: '', isGroup: false },
  '',
  { allowRecordFallback: false, allowCache: true },
);
assert(
  'chatKey 绑定缓存优先于资料身份缓存（与宿主 peek 顺序一致）',
  uCacheOrder.phone === '601100011222' && uCacheOrder.source === 'chat-cache',
  JSON.stringify(uCacheOrder),
);

const peekAlice = (_av, disp) => (/alice/i.test(String(disp)) ? '6011555666777' : '');
const unifiedAlice = createUnifiedResolve(peekAlice, () => '');
const uProfFill = unifiedAlice(
  { chatKey: 'no-hit-key-xyz', title: 'Alice 客服', phone: '', subtitle: '', isGroup: false },
  '',
  { allowRecordFallback: false, allowCache: true },
);
assert(
  '无文本号码且 chat-cache 未命中时可走 profile-cache（头像+标题键）',
  uProfFill.phone === '6011555666777' && uProfFill.source === 'profile-cache',
  JSON.stringify(uProfFill),
);

const uMillisNoise = unified(
  { chatKey: '', title: '状态 1735689600123', subtitle: '', phone: '', isGroup: false },
  '',
  { allowRecordFallback: false, allowCache: false },
);
assert(
  '13 位毫秒时间戳误判已过滤（不当作手机号）',
  uMillisNoise.phone === '' && uMillisNoise.source === '',
  JSON.stringify(uMillisNoise),
);

if (process.exitCode) {
  console.error('\n部分断言失败。');
  process.exit(1);
}
console.log('\n全部模拟断言通过。');
console.log(
  '结论：在「快照字段 + 缓存顺序 + 防时间戳误采」等规则下逻辑自洽；若要验证“每次都能采到”，仍需在应用内对真实联系人/抽屉跑一次。',
);
