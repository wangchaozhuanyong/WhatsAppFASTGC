/** 仅保留数字（与 main.js normalizePhoneForApi 一致）：+ 与空格等一律去掉 */
export function normalizePhone(phone = ''): string {
  const raw = String(phone || '').trim();
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  return digits;
}

export function normalizeWaChatKey(k = ''): string {
  const raw = String(k || '')
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!raw) return '';
  const jidMatch = raw.match(/([0-9]{5,}|[0-9-]{5,})@(c|g)\.us\b/);
  if (jidMatch) return `${jidMatch[1].replace(/\D/g, '')}@${jidMatch[2]}.us`;
  const lidMatch = raw.match(/([0-9]{5,})@lid\b/);
  if (lidMatch) return `${lidMatch[1]}@lid`;
  if (/@g\.us\b/.test(raw)) return raw.replace(/\s+/g, '');
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 8 && digits.length <= 16) return `${digits}@c.us`;
  return raw;
}

export function isWaGroupChatKey(k = ''): boolean {
  return /@g\.us\b/i.test(normalizeWaChatKey(k));
}

/** WhatsApp「动态 / Stories / Status」系统会话（侧栏常显示为「查看动态」等） */
export function isWaStatusFeedChatKey(k = ''): boolean {
  return normalizeWaChatKey(k) === 'status@broadcast';
}

type WaInboxStatusProbe = {
  chatId?: string;
  chatKey?: string;
  name?: string;
  sourceChat?: string;
  displayName?: string;
  phone?: string;
};

/**
 * 全局汇聚行是否为「动态」类会话：优先 JID，其次常见侧栏标题（多语言）。
 * 用于从「全部」等列表拆出，仅在「动态」标签展示。
 */
export function isWaGlobalInboxStatusFeedRow(row: WaInboxStatusProbe): boolean {
  if (isWaStatusFeedChatKey(row.chatId || '') || isWaStatusFeedChatKey(row.chatKey || '')) return true;
  const phone = normalizePhone(row.phone || '');
  const titles = [row.name, row.sourceChat, row.displayName].map((x) => String(x || '').trim());
  for (const t of titles) {
    if (!t) continue;
    if (t.includes('查看动态') || t.includes('查看動態')) return true;
    if (/\bview\s+status\b/i.test(t) || /\bview\s+updates\b/i.test(t)) return true;
    if (t.toLowerCase() === 'status' && !phone) return true;
  }
  return false;
}

export function phoneFromWaChatKey(k = ''): string {
  const ck = normalizeWaChatKey(k);
  if (!ck || isWaGroupChatKey(ck)) return '';
  const m = ck.match(/^(\d{8,16})@c\.us$/i);
  return m ? m[1] : '';
}
