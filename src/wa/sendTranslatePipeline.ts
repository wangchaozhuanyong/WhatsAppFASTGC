/**
 * WhatsApp Web 发送翻译：稳定写入 contenteditable → 校验 → DOM 触发发送。
 * 依赖同一外层闭包内的 WA_INJECT_TRANSLATE_CORE。
 *
 * 产品策略（Enter / 点发送 → `translateComposerAndSend`）：
 * - **翻译失败**（`translateMessage` 未 ok）：**不发送**，不自动回落原文，防误发。
 * - **翻译成功**：**不因内容类型**（表情、符号、多语言混排等）拦截；以译文为准写入并发送；与原文同形时仍发送（表情/数字等常见）。
 * - `sendPipeline` 等路径可能含「失败回落原文再发」的兜底语义，与上不同；宿主主交互以 `translateComposerAndSend` 为准。
 *
 * 模块边界（宿主/测试可按名对应）：
 * - translateMessage / sendPipeline（翻译→写入→校验→发送）
 * - writeTextToWhatsAppInput（insertText 与 textContent+事件）
 * - verifyInputText / verifyInputStableAfterDeferredMs（延迟二次校验防 WA 回滚）
 * - performWaDomSend（按钮优先、Enter 兜底）
 * - restoreOriginalToComposer / sendWithFallback — notifyNonBlocking
 */

declare global {
  interface Window {
    __fastgcSendTranslateConfig?: {
      enabled?: boolean;
      /** 与 index.html 注入一致：宿主「发送翻译」开时置 true，历史字段 `enabled` 常为 false */
      manualEnabled?: boolean;
      sourceLang?: string;
      targetLang?: string;
    };
    __fastgcSendTranslateLastError?: { reason?: string; at?: number; kind?: string };
    __fastgcHostBridge?: { emit?: (name: string, payload?: unknown) => void };
    __fastgcSendPipelineInstalled?: boolean;
    __fastgcSendPipelineVersion?: string;
    __fastgcSendAutoTranslateInstalled?: boolean;
    __fastgcSendAutoTranslateVersion?: string;
    __fastgcSendInFlight?: string;
    __fastgcSendPipelineBusy?: string;
    __fastgcSendButtonGestureBusy?: string;
    __fastgcInternalSend?: string;
    __fastgcManualTranslateComposer?: () => Promise<{
      ok: boolean;
      handled: boolean;
      reason?: string;
      translated?: string;
      unchanged?: boolean;
      sent?: boolean;
    }>;
    __fastgcManualTranslateAndSend?: Window['__fastgcManualTranslateComposer'];
    __fastgcWaUserTypingUntil?: number;
    __fastgcWaUserSentMessage?: number;
    __fastgcFastgcWaSendCapturedAt?: number;
    /** 同步门闩：防止 beforeinput/keydown/pointerdown 并发进入同一发送管线导致双发或状态错乱 */
    __fastgcWaSendExclusiveGate?: string;
    /** 浏览器：`window.setTimeout` 句柄为 number（与 `@types/node` 下 `NodeJS.Timeout` 区分） */
    __fastgcWaSendExclusiveWatchdogId?: number;
    /** 单次 processSend：`performWaDomSend` 外入口至多消费一次（内部清空检测的重试不占第二次） */
    __fastgcWaDomSendConsumed?: string;
    /** 写入 composer 硬锁：可信 keydown/beforeinput/发送点击 不得再进翻译管线（合成事件 isTrusted=false 不受阻） */
    __fastgcWriteComposerLock?: string;
    __FASTGC_SEND_DEBUG?: boolean | number;
    WPP?: {
      chat?: {
        getActiveChat?: () => unknown;
        /** @wppconnect/wa-js：与 Store 内 composer 同步，比纯 DOM paste 更不易被 WA 回滚 */
        setInputText?: (text: string, chatId?: string) => Promise<unknown>;
        sendTextMessage?: (id: string, body: string, opts?: unknown) => Promise<unknown>;
      };
    };
    Store?: { Chat?: { get?: (id: string) => unknown; _models?: unknown[]; models?: unknown[] } };
  }
}

export const SEND_TRANSLATE_PIPELINE_VERSION = '2026-05-04-send-translate-single-click-listener';

export function captureActiveConversation(): string {
  try {
    const chat = window.WPP?.chat?.getActiveChat?.() as { id?: { _serialized?: string; toString?: () => string } } | undefined;
    const id = chat?.id?._serialized || chat?.id?.toString?.() || '';
    return /^[^\s@]+@[a-z0-9.]+$/i.test(id) ? id : '';
  } catch { return ''; }
}

export function requireActiveConversation(expected: string): void {
  if (!expected || captureActiveConversation() !== expected) throw new Error('manual-translate-chat-changed');
}

const DEFER_VERIFY_MS_MIN = 30;
const DEFER_VERIFY_MS_RANGE = 51;
const EXCLUSIVE_WATCHDOG_MS = 2000;
/** WA 发送与输入框清空异步；门闩过早释放时可信 insertParagraph/beforeinput 会再次顶进翻译管线 → 环路粘贴/连发 */
const EXCLUSIVE_RELEASE_TAIL_MS = 900;
/**
 * DOM 派发发送后 React 可能在后续 tick 才处理；沿用 0ms 清空 __fastgcInternalSend 会令内部发送标记早于合成事件着陆。
 * 与独占门闩错开但仍短于 EXCLUSIVE_RELEASE_TAIL_MS，避免与真实 trusted 手势重叠过久。
 */
const INTERNAL_SEND_HOLD_MS = 140;

let internalSendClearId: number | undefined;

function scheduleInternalSendRelease(): void {
  if (internalSendClearId !== undefined) {
    window.clearTimeout(internalSendClearId);
    internalSendClearId = undefined;
  }
  internalSendClearId = window.setTimeout(() => {
    internalSendClearId = undefined;
    try {
      window.__fastgcInternalSend = '0';
    } catch {
      /* empty */
    }
  }, INTERNAL_SEND_HOLD_MS);
}

/** 对外：翻译一步（封装 translateTextFastgcDetailed + 超时）。失败由调用方决定不发；成功则返回任意非空/同形译文。 */
export async function translateMessage(
  plainText: string,
  sourceLangNorm: string,
  targetLangNorm: string,
  timeoutMs: number,
): Promise<{ ok: boolean; translated: string; error?: string }> {
  const raw = String(plainText || '').trim();
  if (!raw) return { ok: false, translated: '', error: 'EMPTY' };

  type Detailed = {
    ok?: boolean;
    text?: string;
    error?: string;
    bridgeError?: string;
  };
  /** 与 index.html WA_INJECT_TRANSLATE_CORE 串行预算一致，避免调用方传入过小 timeout 导致误超时 */
  const translateInjectBaselineMs = Math.min(
    125000,
    Math.max(9000, FASTGC_BRIDGE_MS + FASTGC_FALLBACK_FETCH_MS + 2200),
  );
  const asked = Number(timeoutMs);
  const effectiveRaceMs = Math.min(
    125000,
    Math.max(translateInjectBaselineMs, Number.isFinite(asked) && asked > 0 ? asked : translateInjectBaselineMs),
  );
  const withTimeout = <T>(p: Promise<T>, ms: number, fb: T) =>
    Promise.race([
      Promise.resolve(p),
      new Promise<T>((resolve) => setTimeout(() => resolve(fb), Math.max(400, ms))),
    ]);

  const fb: Detailed = { ok: false, error: 'TRANSLATE_TIMEOUT' };
  const res = await withTimeout(
    translateTextFastgcDetailed(raw, sourceLangNorm, targetLangNorm),
    effectiveRaceMs,
    fb,
  );
  if (!res || !res.ok) {
    const err =
      String((res?.error ?? res?.bridgeError) ?? fb.error ?? 'TRANSLATE_FAILED').slice(0, 120);
    return { ok: false, translated: '', error: err };
  }
  return { ok: true, translated: String(res.text ?? '').trim() };
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function acquireWriteComposerLock(): void {
  try {
    window.__fastgcWriteComposerLock = '1';
  } catch {
    /* empty */
  }
}

function releaseWriteComposerLock(): void {
  try {
    window.__fastgcWriteComposerLock = '0';
  } catch {
    /* empty */
  }
}

/** 清空或强改 DOM 后连跑两帧 rAF + 微任务，减轻 WA/React 与真实节点脱节导致的拼接幽灵 */
async function yieldAfterComposerClear(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
  await Promise.resolve();
}

function isFastgcSendDebugEnabled(): boolean {
  try {
    if (typeof window !== 'undefined' && Number(window.__FASTGC_SEND_DEBUG) === 1) return true;
  } catch {
    /* empty */
  }
  try {
    return typeof window !== 'undefined' && window.localStorage?.getItem?.('FASTGC_SEND_DEBUG') === '1';
  } catch {
    return false;
  }
}

/** 仅在 `window.__FASTGC_SEND_DEBUG=1` 或 localStorage FASTGC_SEND_DEBUG=1 时输出 */
export function fgSendDbg(label: string, payload?: Record<string, unknown>): void {
  if (!isFastgcSendDebugEnabled()) return;
  try {
    const snippet = (v: unknown) => {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      const t = s.length > 360 ? `${s.slice(0, 360)}…` : s;
      return t;
    };
    const flat: Record<string, string> = {};
    if (payload)
      Object.keys(payload).forEach((k) => {
        flat[k] = snippet(payload[k]);
      });
    // eslint-disable-next-line no-console
    console.warn('[FastGC send]', label, flat);
  } catch {
    /* empty */
  }
}

/** 宿主非阻断 Toast：仅通知，不改变「稍后会触发发送」的语义 */
export function notifyNonBlocking(reasonCode: string, detail?: string): void {
  const code = String(reasonCode || '').trim() || 'unknown';
  const d = detail ? String(detail).trim() : '';
  const reason = d ? `${code}:${d.slice(0, 160)}` : code;
  try {
    window.__fastgcSendTranslateLastError = { reason, at: Date.now(), kind: 'soft' };
  } catch {
    /* empty */
  }
  try {
    const emit = window.__fastgcHostBridge?.emit;
    if (typeof emit === 'function') emit('send-translate-notify', { reason, kind: 'soft' });
  } catch {
    /* empty */
  }
}

/** 可读文本比对（兼容 NBSP） */
export function normalizeComposeValue(value: string | null | undefined): string {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 导出：校验编辑器当前文本是否与目标一致 */
export function verifyInputText(box: HTMLElement | null, expected: string): boolean {
  const want = normalizeComposeValue(expected);
  if (!want) return true;
  if (!box) return false;
  const got = normalizeComposeValue((box.innerText || box.textContent || '').slice(0));
  return got === want;
}

/** normalize 对齐 + 「仅 NBSP 归一」的 textContent 与期望逐字对齐，防静默换皮 */
export function verifyComposerLayersStable(box: HTMLElement | null, expected: string): boolean {
  const want = normalizeComposeValue(expected);
  if (!want) return true;
  if (!box) return false;
  const el = currentComposeBox(box) || box;

  const rawTc = String(el.textContent ?? '').replace(/\u00a0/g, ' ');
  const rawExp = String(expected ?? '').replace(/\u00a0/g, ' ');
  if (rawTc !== rawExp) return false;

  const nt = normalizeComposeValue(el.innerText);
  const nc = normalizeComposeValue(el.textContent ?? '');
  if (nt !== want || nc !== want) return false;
  return true;
}

/**
 * WhatsApp 偶于微任务后因内部状态还原 composer。
 * 先做多层一致性校验，再在 30～80ms 后复验；任一步失败视为不稳定。
 */
export async function verifyInputStableAfterDeferredMs(
  box: HTMLElement | null,
  expected: string,
): Promise<boolean> {
  if (!verifyComposerLayersStable(box, expected)) return false;
  await wait(DEFER_VERIFY_MS_MIN + Math.floor(Math.random() * DEFER_VERIFY_MS_RANGE));
  const bx = currentComposeBox(box) || box;
  return verifyComposerLayersStable(bx, expected);
}

export function composerVisible(node: Node | null | undefined): boolean {
  return !!(node && (node as HTMLElement).getClientRects && (node as HTMLElement).getClientRects()?.length > 0);
}

function isEditableComposeNode(node: HTMLElement | null): boolean {
  return !!(node && composerVisible(node) && (node.isContentEditable || node.getAttribute('contenteditable') === 'true'));
}

function resolveEditableCompose(node: HTMLElement | null): HTMLElement | null {
  if (!node) return null;
  if (isEditableComposeNode(node)) return node;
  const inner =
    node.querySelector?.('[contenteditable="true"][role="textbox"], [contenteditable="true"]') ||
    node.querySelector?.('[contenteditable="true"]');
  return inner && inner instanceof HTMLElement && isEditableComposeNode(inner) ? inner : null;
}

export function findComposeBox(): HTMLElement | null {
  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc) return null;

  let activeEditable: HTMLElement | null = null;
  try {
    const active = doc.activeElement;
    if (active instanceof HTMLElement)
      activeEditable =
        resolveEditableCompose(active) ||
        (typeof active.closest === 'function'
          ? resolveEditableCompose(
              active.closest(
                'footer [contenteditable="true"], [role="textbox"][contenteditable="true"], [data-testid="conversation-compose-box-input"]',
              ) as HTMLElement | null,
            )
          : null);
  } catch {
    activeEditable = null;
  }

  if (activeEditable) return activeEditable;

  const cands = doc.querySelectorAll(
    '#main footer [contenteditable="true"], footer [contenteditable="true"][role="textbox"], footer [contenteditable="true"], [role="textbox"][contenteditable="true"], div[spellcheck][contenteditable="true"]',
  );
  for (let i = 0; i < cands.length; i++) {
    const el = cands[i];
    if (el instanceof HTMLElement && composerVisible(el)) return el;
  }

  const box =
    doc.querySelector('[data-testid="conversation-compose-box-input"]') ||
    doc.querySelector('footer [data-testid="compose-box-input"]');

  let editable =
    box && box instanceof HTMLElement
      ? resolveEditableCompose(box)
      : typeof box?.querySelector === 'function'
        ? resolveEditableCompose(box!.querySelector('[contenteditable="true"]') as HTMLElement | null)
        : null;

  if (editable) return editable;
  return box instanceof HTMLElement && composerVisible(box) ? box : null;
}

export function currentComposeBox(anchor: HTMLElement | null): HTMLElement | null {
  const editable = resolveEditableCompose(anchor);
  if (editable) return editable;
  if (anchor?.isConnected && composerVisible(anchor)) return anchor;
  return findComposeBox();
}

export function readComposeText(box: HTMLElement | null): string {
  const target = currentComposeBox(box);
  return normalizeComposeValue(target ? target.innerText || target.textContent : '');
}

async function waitForComposeText(box: HTMLElement | null, expected: string, maxMs: number): Promise<boolean> {
  const want = normalizeComposeValue(expected);
  const deadline = Date.now() + Math.max(200, maxMs || 900);
  while (Date.now() <= deadline) {
    if (normalizeComposeValue(readComposeText(box)) === want) return true;
    await wait(16);
  }
  return normalizeComposeValue(readComposeText(box)) === want;
}

function selectComposeContents(box: HTMLElement): boolean {
  const sel = window.getSelection?.();
  if (sel && document.createRange && box.childNodes.length >= 0) {
    try {
      const range = document.createRange();
      range.selectNodeContents(box);
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    } catch {
      /* empty */
    }
  }
  try {
    return document.execCommand('selectAll', false, undefined);
  } catch {
    return false;
  }
}

function dispatchInputLike(box: HTMLElement, inputType: string, data?: string | null): void {
  try {
    box.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType,
        data: data ?? undefined,
      }),
    );
  } catch {
    try {
      box.dispatchEvent(document.createEvent('Event'));
    } catch {
      /* empty */
    }
  }

  try {
    box.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType,
        data: data ?? undefined,
      }),
    );
  } catch {
    try {
      box.dispatchEvent(new Event('input', { bubbles: true }));
    } catch {
      /* empty */
    }
  }
}

/** 清空 composer（不改变发送意图） */
export async function clearWhatsAppComposer(anchorBox: HTMLElement | null): Promise<HTMLElement | null> {
  const target = currentComposeBox(anchorBox);
  if (!target) return null;
  try {
    target.focus();
    selectComposeContents(target);
    try {
      document.execCommand('delete', false, undefined);
    } catch {
      /* empty */
    }
    dispatchInputLike(target, 'deleteContentBackward', null);
    if (!(await waitForComposeText(target, '', 420))) {
      target.textContent = '';
      dispatchInputLike(target, 'deleteContentBackward', null);
    }
  } catch {
    try {
      target.textContent = '';
      dispatchInputLike(target, 'deleteContentBackward', null);
    } catch {
      /* empty */
    }
  }
  await waitForComposeText(target, '', 320);
  return currentComposeBox(target) || target;
}

/** execCommand 失败或未稳定时：textContent + input/beforeinput 事件 */
function applyInsertedTextViaTextContent(box: HTMLElement | null, text: string): void {
  if (!box) return;
  const want = String(text ?? '');
  try {
    box.focus();
    dispatchBeforeInsert(box, want);
    box.textContent = want;
  } catch {
    try {
      box.textContent = '';
      box.textContent = want;
    } catch {
      /* empty */
    }
  }
  dispatchInputLike(box, 'insertText', want);
}

/**
 * 导出：写入 WhatsApp contenteditable。
 * 主路径：仅做「全选 + paste」一次原子替换；若失败，直接 textContent 字面覆盖，彻底避免二次插入链造成偶发拼接。
 */
export async function writeTextToWhatsAppInput(
  anchorBox: HTMLElement | null,
  text: string,
  expectedConversation?: string,
): Promise<{ ok: boolean; activeBox: HTMLElement | null }> {
  const checkConversation = () => { if (expectedConversation !== undefined) requireActiveConversation(expectedConversation); };
  checkConversation();
  let target = currentComposeBox(anchorBox);
  if (!target)
    return {
      ok: false,
      activeBox: null,
    };

  const want = String(text ?? '');

  const attemptWrite = async (): Promise<boolean> => {
    checkConversation();
    target = currentComposeBox(anchorBox) || currentComposeBox(target);
    if (!target) return false;

    /** 与 @wppconnect/wa-js 一致：优先走 WPP 内部 composer，减少 paste 与 React 状态打架 */
    if (await tryWriteComposerViaWpp(want)) {
      checkConversation();
      target = currentComposeBox(anchorBox) || currentComposeBox(target) || target;
      fgSendDbg('attemptWrite-wpp-setInputText-ok');
      return true;
    }

    checkConversation();
    target.focus();
    selectComposeContents(target);

    const dt = new DataTransfer();
    dt.setData('text/plain', want);
    try {
      const pasteEvt = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clipboardData: dt,
      } as ClipboardEventInit);
      target.dispatchEvent(pasteEvt);
    } catch {
      /* empty */
    }

    let bx = currentComposeBox(target) || target;
    const okPath =
      (await waitComposeStablePoll(bx, want, 600)) && (await verifyInputStableAfterDeferredMs(bx, want));

    target = currentComposeBox(target) || bx;
    fgSendDbg('attemptWrite-atomic-paste-only', { okPath });
    return Boolean(okPath);
  };

  acquireWriteComposerLock();
  try {
    /** 仅一次纯 paste；失败立即走硬兜底，避免把失败状态再扩散一轮。 */
    const okRound = await attemptWrite();
    checkConversation();
    if (okRound) return { ok: true, activeBox: currentComposeBox(target) || target };

    const fallbackBox = currentComposeBox(target) || target;
    if (fallbackBox) {
      applyInsertedTextViaTextContent(fallbackBox, want);
      await waitComposeStablePoll(fallbackBox, want, 520);
      if (await verifyInputStableAfterDeferredMs(fallbackBox, want)) {
        target = currentComposeBox(fallbackBox) || fallbackBox;
        fgSendDbg('attemptWrite-fallback-textcontent-ok');
        return { ok: true, activeBox: target };
      }
    }

    /** 兜底失败后再短重试一次 paste，给 WA 选择器漂移一个恢复窗口。 */
    for (let i = 0; i < 2; i++) {
      // eslint-disable-next-line no-await-in-loop
      const okRoundRetry = await attemptWrite();
      checkConversation();
      if (okRoundRetry) return { ok: true, activeBox: currentComposeBox(target) || target };
      // eslint-disable-next-line no-await-in-loop
      await wait(90 + i * 70);
    }

    target = currentComposeBox(anchorBox) || target;
    return { ok: false, activeBox: target };
  } finally {
    releaseWriteComposerLock();
  }
}

function dispatchBeforeInsert(box: HTMLElement, text: string): void {
  try {
    dispatchInputLike(box, 'deleteByComposition', null);
    dispatchInputLike(box, 'insertCompositionText', '');
  } catch {
    /* empty */
  }
  dispatchBeforeInputCompat(box, 'insertText', text);
}

function dispatchBeforeInputCompat(box: HTMLElement, inputType: string, data?: string): void {
  try {
    box.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType,
        data,
      }),
    );
  } catch {
    try {
      const ev = document.createEvent('Event');
      ev.initEvent('beforeinput', true, true);
      box.dispatchEvent(ev);
    } catch {
      /* empty */
    }
  }
}

async function waitComposeStablePoll(box: HTMLElement | null, expected: string, maxMs: number): Promise<boolean> {
  return waitForComposeText(box, expected, maxMs);
}

/**
 * 参考 wa-js `chat/setInputText`：经 WPP 写入 WhatsApp 内部 composer，再与 DOM contenteditable 对齐校验。
 * 失败时返回 false，由既有 paste / textContent 路径接管。
 */
async function tryWriteComposerViaWpp(want: string): Promise<boolean> {
  const text = String(want ?? '');
  if (!text) return false;
  try {
    const wpp = window.WPP as { chat?: { setInputText?: (t: string, id?: string) => Promise<unknown> } } | undefined;
    const chat = wpp?.chat;
    const fn = chat?.setInputText;
    if (typeof fn !== 'function' || !chat) return false;
    await Promise.resolve(fn.call(chat, text));
    await wait(48);
    const box = findComposeBox();
    if (!box) return false;
    if (!(await waitComposeStablePoll(box, text, 720))) return false;
    return verifyInputStableAfterDeferredMs(box, text);
  } catch {
    return false;
  }
}

/** 尽最大努力恢复原文到输入框（无 Toast，由上层决定提示） */
export async function restoreOriginalToComposer(anchorBox: HTMLElement | null, original: string): Promise<void> {
  const orig = String(original ?? '');
  if (!normalizeComposeValue(orig)) return;
  const bx = currentComposeBox(anchorBox) || findComposeBox() || anchorBox;
  applyInsertedTextViaTextContent(bx, orig);
  await waitComposeStablePoll(bx, orig, 520);
}

/** notify + 恢复原文字面意义的「兜底发送准备」 */
export async function sendWithFallback(
  box: HTMLElement | null,
  originalText: string,
  notifyReason?: string,
): Promise<void> {
  const r = notifyReason?.trim();
  if (r) notifyNonBlocking(r);
  await restoreOriginalToComposer(box, originalText);
}

function getConfig(): { enabled: boolean; sourceLang: string; targetLang: string } {
  const cfg = window.__fastgcSendTranslateConfig;
  /** 注入层用 `manualEnabled` 表示「发送翻译」总开关；`enabled` 曾固定为 false 仅保留兼容 */
  const enabled = Boolean(cfg?.enabled || cfg?.manualEnabled);
  const sourceLang = cfg?.sourceLang || 'auto';
  const targetLang = cfg?.targetLang || 'en';
  return { enabled, sourceLang, targetLang };
}

/** 宿主侧仍可收到 chat-dirty */
function notifyHostChatDirty(): void {
  try {
    const emit = window.__fastgcHostBridge?.emit;
    if (typeof emit === 'function') emit('chat-dirty', { from: 'post-send' });
  } catch {
    /* empty */
  }
}

function markSentForGlobalInbox(): void {
  try {
    window.__fastgcWaUserSentMessage = Date.now();
  } catch {
    /* empty */
  }
}

function markComposeActivity(): void {
  try {
    window.__fastgcWaUserTypingUntil = Date.now() + 1800;
  } catch {
    /* empty */
  }
}

function finishWaSendFlightFlags(): void {
  window.__fastgcSendPipelineBusy = '0';
  window.__fastgcSendInFlight = '0';
  window.__fastgcSendButtonGestureBusy = '0';
}

function clearWaSendExclusiveWatchdog(): void {
  const id = window.__fastgcWaSendExclusiveWatchdogId;
  if (id != null) {
    window.clearTimeout(id);
    window.__fastgcWaSendExclusiveWatchdogId = undefined;
  }
}

/** 异常未走 finally 时仍释放门闩，避免永久拦截发送 */
function armWaSendExclusiveWatchdogFallback(): void {
  clearWaSendExclusiveWatchdog();
  window.__fastgcWaSendExclusiveWatchdogId = window.setTimeout(() => {
    window.__fastgcWaSendExclusiveWatchdogId = undefined;
    fgSendDbg('exclusive-watchdog-force-release');
    try {
      window.__fastgcWaSendExclusiveGate = '0';
    } catch {
      /* empty */
    }
    finishWaSendFlightFlags();
  }, EXCLUSIVE_WATCHDOG_MS);
}

function scheduleReleaseWaSendExclusive(delayMs = 200): void {
  clearWaSendExclusiveWatchdog();
  const ms = Math.max(60, delayMs, EXCLUSIVE_RELEASE_TAIL_MS);
  window.setTimeout(() => {
    try {
      window.__fastgcWaSendExclusiveGate = '0';
    } catch {
      /* empty */
    }
    finishWaSendFlightFlags();
  }, ms);
}

/** 同步抢占：同一时间只允许一条发送管线 */
function tryTakeWaSendExclusiveGate(): boolean {
  if (window.__fastgcWaSendExclusiveGate === '1') return false;
  window.__fastgcWaSendExclusiveGate = '1';
  window.__fastgcSendInFlight = '1';
  window.__fastgcSendPipelineBusy = '1';
  armWaSendExclusiveWatchdogFallback();
  return true;
}

/** 实际触发 WA：优先按钮点击，其次 Enter（内部可调用两次做「未清空重试」，不计入外层双发计数） */
function fireWaDomDispatchOnce(boxFallback: HTMLElement | null): 'button' | 'enter' | 'none' {
  const doc = document;
  let sendBtn = doc.querySelector('button[data-testid="send"]') as HTMLElement | null;
  if (!sendBtn) {
    const icon = doc.querySelector('span[data-icon="send"]');
    if (icon && icon.closest)
      sendBtn = icon.closest('button,[role="button"]') as HTMLElement | null;
  }
  if (!sendBtn) {
    const buttons = doc.querySelectorAll('button,[role="button"]');
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i] as HTMLElement;
      const al = String(b.getAttribute('aria-label') || '').toLowerCase();
      if (al === 'send' || al.includes('发送')) {
        sendBtn = b;
        break;
      }
    }
  }

  const canClick =
    sendBtn &&
    typeof sendBtn.getAttribute === 'function' &&
    sendBtn.getAttribute('aria-disabled') !== 'true' &&
    !(sendBtn as HTMLButtonElement).disabled;

  if (canClick && sendBtn) {
    window.__fastgcInternalSend = '1';
    try {
      sendBtn.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }),
      );
      sendBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      sendBtn.click();
    } finally {
      scheduleInternalSendRelease();
    }
    return 'button';
  }

  const bx = currentComposeBox(boxFallback) || findComposeBox();
  if (!bx) return 'none';
  window.__fastgcInternalSend = '1';
  try {
    bx.focus();
    bx.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }),
    );
  } finally {
    scheduleInternalSendRelease();
  }
  return 'enter';
}

function finalizeDomSendNotifyHostOnce(): void {
  markSentForGlobalInbox();
  notifyHostChatDirty();
  setTimeout(notifyHostChatDirty, 500);
  setTimeout(notifyHostChatDirty, 1500);
}

/**
 * DOM 触发发送：**整次用户语义仅消费一次**。
 * ~~曾用 ~50ms 后比对 composer 未空则二次 fireWaDomDispatchOnce~~：与 React 清空竞态易导致碎片乱码，已移除；仅单次派发。
 */
function performWaDomSend(boxFallback: HTMLElement | null): void {
  if (window.__fastgcWaDomSendConsumed === '1') {
    fgSendDbg('performWaDomSend-skipped-already-consumed');
    return;
  }
  window.__fastgcWaDomSendConsumed = '1';

  const bx = currentComposeBox(boxFallback) || findComposeBox();
  if (!bx) {
    fgSendDbg('performWaDomSend-no-compose-box');
    return;
  }

  const preSnap = normalizeComposeValue(readComposeText(bx));
  fgSendDbg('performWaDomSend-start', { preCompose: preSnap });

  const r1 = fireWaDomDispatchOnce(bx);
  fgSendDbg('performWaDomSend-first-fire', { via: r1 });

  finalizeDomSendNotifyHostOnce();
}

/**
 * 统一发送入口：`translate → write → 延迟校验 → （回落原文）→ performWaDomSend`。
 * **不抛出**：任何异常仍会尝试恢复原文并触发发送。
 */
export async function sendPipeline(originalCaptured: string, boxAnchorParam: HTMLElement | null): Promise<void> {
  const bx0 = boxAnchorParam || findComposeBox();
  if (!bx0) return;
  let boxWorking = bx0;

  const emitPreparedSend = async (dbgMeta?: {
    /** 路径标签，便于开关日志时对齐 */
    path?: string;
    /** 期望落座译文或「无」 */
    translated?: string;
  }) => {
    try {
      window.__fastgcWaDomSendConsumed = '0';
    } catch {
      /* empty */
    }
    await wait(42);
    const bx = currentComposeBox(boxWorking) || findComposeBox() || boxWorking;
    let finalComposer = normalizeComposeValue(readComposeText(bx));
    const wantSend = normalizeComposeValue(dbgMeta?.translated ?? '');
    /** 译文目标为拉丁字母而框内仍混有 CJK：多半是清空不全/IME 残留，再清一次只写目标，避免下一轮把「你好+Hello」整块再翻译叠加 */
    if (
      wantSend &&
      wantSend !== finalComposer &&
      !/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(wantSend) &&
      /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(finalComposer)
    ) {
      fgSendDbg('emitPreparedSend-strip-cjk-remix', { wantSend, finalComposer });
      await clearWhatsAppComposer(bx);
      await wait(46);
      await writeTextToWhatsAppInput(bx, wantSend);
      await wait(40);
      finalComposer = normalizeComposeValue(readComposeText(bx));
    }
    fgSendDbg('emitPreparedSend', {
      path: dbgMeta?.path ?? 'default',
      original: originalNorm,
      translated: dbgMeta?.translated ?? '(n/a)',
      finalComposer,
    });
    performWaDomSend(bx);
  };

  const cfg = getConfig();
  const slNorm = normalizeFastgcTranslateLang(cfg.sourceLang, 'auto');
  const tlNorm = normalizeFastgcTranslateLang(cfg.targetLang || 'en', 'en');

  const originalNorm = normalizeComposeValue(originalCaptured);
  if (!originalNorm) return;
  fgSendDbg('sendPipeline-start', { original: originalNorm, sl: slNorm, tl: tlNorm });

  try {
    const sameLang = slNorm !== 'auto' && slNorm.toLowerCase() === tlNorm.toLowerCase();
    if (sameLang) {
      await emitPreparedSend({ path: 'same-lang', translated: originalNorm });
      return;
    }

    /** 与注入层一致：桥超时后仍可能走 gtx + 一次短重试，外层超时须覆盖整段，避免误报 TRANSLATE_TIMEOUT */
    const translateOuterBudgetMs = Math.min(
      125000,
      Math.max(9000, FASTGC_BRIDGE_MS + FASTGC_FALLBACK_FETCH_MS + 2200),
    );
    const tm = await translateMessage(originalNorm, slNorm, tlNorm, translateOuterBudgetMs);

    if (!tm.ok) {
      notifyNonBlocking('translate-failed-soft', tm.error ?? '');
      await restoreOriginalToComposer(boxWorking, originalNorm);
      await emitPreparedSend({ path: 'translate-failed', translated: originalNorm });
      return;
    }

    const translated = tm.translated;

    if (!translated || translated === originalNorm) {
      /** 译文与原文相同（如英→英）：仍走发送，不因「已像目标语」而拦截 */
      await emitPreparedSend({
        path: 'translate-empty-or-same',
        translated: translated || originalNorm,
      });
      return;
    }

    const wrote = await writeTextToWhatsAppInput(boxWorking, translated);
    const active = wrote.activeBox || boxWorking;
    await waitComposeStablePoll(active, translated, 750);
    boxWorking = active;

    let sendDbgPath: string = 'translated-ok';
    let sendDbgTranslated = normalizeComposeValue(translated);

    if (!(await verifyInputStableAfterDeferredMs(active, translated))) {
      sendDbgPath = 'compose-mismatch-fallback-original';
      sendDbgTranslated = originalNorm;
      notifyNonBlocking('compose-translated-mismatch-soft');
      /** 不再走 writeTextToWhatsAppInput（全选+paste 叠层），直接 DOM 字面替换，避免「原文+译文」再被 paste 拼一轮 */
      const rb = currentComposeBox(boxWorking) || findComposeBox() || boxWorking;
      applyInsertedTextViaTextContent(rb, originalNorm);
      await waitComposeStablePoll(rb, originalNorm, 620);
      if (!(await verifyInputStableAfterDeferredMs(rb, originalNorm))) {
        applyInsertedTextViaTextContent(rb, originalNorm);
        await waitComposeStablePoll(rb, originalNorm, 620);
      }
    }

    await emitPreparedSend({ path: sendDbgPath, translated: sendDbgTranslated });
  } catch {
    notifyNonBlocking('translate-exception-soft');
    try {
      await restoreOriginalToComposer(boxWorking, originalNorm);
    } catch {
      /* empty */
    }
    await emitPreparedSend({ path: 'exception', translated: originalNorm });
  }
}

/** 挂载事件与 processSend — 单次页面注入调用一次即可 */
export function installFastgcWaSendPipeline(): void {
  if (window.__fastgcSendPipelineInstalled && window.__fastgcSendPipelineVersion === SEND_TRANSLATE_PIPELINE_VERSION) {
    return;
  }
  window.__fastgcSendPipelineInstalled = true;
  window.__fastgcSendPipelineVersion = SEND_TRANSLATE_PIPELINE_VERSION;
  /** 与外置版本检查字段对齐（历史字段名） */
  window.__fastgcSendAutoTranslateInstalled = true;
  window.__fastgcSendAutoTranslateVersion = SEND_TRANSLATE_PIPELINE_VERSION;

  /** 极短时间内同一段输入重复触发 beforeinput+Enter 时只跑一条管线 */
  let lastAfterProcessAtMs = 0;
  let lastAfterProcessFp = '';
  /** 仅合并首包内重复（beforeinput+Enter 典型 <50ms）；420ms 会误拦「相同内容连点发送」 */
  const AFTER_PROCESS_FP_DEDUP_MS = 100;

  /** 同一用户手势内 beforeinput 与 keydown 先后触发，中间隔 await routeComposerSendIntent → 仅靠 fp 会去重失效；先入队一次 microtask 合并触发 */
  let afterProcessKickCoalesceArmed = false;
  let afterProcessKickCoalesceBox: HTMLElement | null | undefined;

  /** 供宿主手动按钮调用：只翻译并替换 composer，不触发 WhatsApp 发送。 */
  const translateComposerOnly = async () => {
    try {
      let boxWorking = findComposeBox();
      if (!boxWorking) return { ok: false, handled: false, reason: 'manual-translate-no-compose' };
      const originalNorm = normalizeComposeValue(readComposeText(boxWorking));
      if (!originalNorm) return { ok: false, handled: false, reason: 'manual-translate-empty' };

      const conversation = captureActiveConversation();
      if (!conversation) return { ok: false, handled: false, reason: 'manual-translate-chat-not-ready' };
      const cfg = getConfig();
      const slNorm = normalizeFastgcTranslateLang(cfg.sourceLang, 'auto');
      const tlNorm = normalizeFastgcTranslateLang(cfg.targetLang || 'en', 'en');
      if (slNorm !== 'auto' && slNorm.toLowerCase() === tlNorm.toLowerCase()) {
        return { ok: true, handled: true, unchanged: true, reason: 'manual-translate-same-lang' };
      }

      const tm = await translateMessage(originalNorm, slNorm, tlNorm, 125000);
      requireActiveConversation(conversation);
      if (!tm.ok) {
        notifyNonBlocking('manual-translate-failed', tm.error ?? '');
        return { ok: false, handled: false, reason: `manual-translate-failed:${tm.error ?? ''}` };
      }

      const translated = normalizeComposeValue(tm.translated);
      if (!translated) return { ok: false, handled: false, reason: 'manual-translate-empty-result' };
      if (translated === originalNorm) {
        return { ok: true, handled: true, unchanged: true, reason: 'manual-translate-same-text' };
      }

      boxWorking.dataset.fastgcTranslating = '1';
      try {
        const wrote = await writeTextToWhatsAppInput(boxWorking, translated, conversation);
        const active = wrote.activeBox || currentComposeBox(boxWorking) || boxWorking;
        if (
          wrote.ok &&
          (await waitComposeStablePoll(active, translated, 900)) &&
          (await verifyInputStableAfterDeferredMs(active, translated))
        ) {
          /* ok */
        } else {
          requireActiveConversation(conversation);
          applyInsertedTextViaTextContent(active, translated);
          await waitComposeStablePoll(active, translated, 900);
          if (!(await verifyInputStableAfterDeferredMs(active, translated))) {
            const retryBox = currentComposeBox(active) || active;
            requireActiveConversation(conversation);
            applyInsertedTextViaTextContent(retryBox, translated);
            await waitComposeStablePoll(retryBox, translated, 900);
            if (!(await verifyInputStableAfterDeferredMs(retryBox, translated))) {
              return { ok: false, handled: false, reason: 'manual-translate-compose-not-applied' };
            }
          }
        }
      } finally {
        const finalEl = currentComposeBox(boxWorking);
        try {
          if (finalEl?.dataset) finalEl.dataset.fastgcTranslating = '0';
        } catch {
          /* empty */
        }
      }

      return { ok: true, handled: true, translated };
    } catch (error) {
      const reason = error instanceof Error && error.message === 'manual-translate-chat-changed' ? error.message : 'manual-translate-error';
      notifyNonBlocking(reason);
      return { ok: false, handled: false, reason };
    }
  };
  window.__fastgcManualTranslateComposer = translateComposerOnly;

  /**
   * Enter / 点发送：先译后发。
   * - 翻译失败：不发送（防误发）。
   * - 翻译成功：不因表情/符号/混排拦截；写入 composer 与「仅翻译」按钮共用同一套 textContent 回退重试后再发。
   */
  const translateComposerAndSend = async () => {
    let boxWorking: HTMLElement | null = null;
    let gateTaken = false;
    try {
      boxWorking = findComposeBox();
      if (!boxWorking) return { ok: false, handled: false, reason: 'manual-translate-no-compose' };
      const originalNorm = normalizeComposeValue(readComposeText(boxWorking));
      if (!originalNorm) return { ok: false, handled: false, reason: 'manual-translate-empty' };

      const conversation = captureActiveConversation();
      if (!conversation) return { ok: false, handled: false, reason: 'manual-translate-chat-not-ready' };
      const cfg = getConfig();
      const slNorm = normalizeFastgcTranslateLang(cfg.sourceLang, 'auto');
      const tlNorm = normalizeFastgcTranslateLang(cfg.targetLang || 'en', 'en');
      if (slNorm !== 'auto' && slNorm.toLowerCase() === tlNorm.toLowerCase()) {
        return { ok: true, handled: true, unchanged: true, reason: 'manual-translate-same-lang' };
      }

      const tm = await translateMessage(originalNorm, slNorm, tlNorm, 125000);
      requireActiveConversation(conversation);
      if (!tm.ok) {
        notifyNonBlocking('manual-translate-failed', tm.error ?? '');
        return { ok: false, handled: false, reason: `manual-translate-failed:${tm.error ?? ''}` };
      }

      const translated = normalizeComposeValue(tm.translated);
      if (!translated) return { ok: false, handled: false, reason: 'manual-translate-empty-result' };
      if (translated === originalNorm) {
        if (!tryTakeWaSendExclusiveGate()) {
          return { ok: false, handled: false, reason: 'manual-translate-busy' };
        }
        gateTaken = true;
        try {
          window.__fastgcWaDomSendConsumed = '0';
        } catch {
          /* empty */
        }
        const bSend = currentComposeBox(boxWorking) || findComposeBox() || boxWorking;
        await wait(30);
        requireActiveConversation(conversation);
        performWaDomSend(bSend);
        return {
          ok: true,
          handled: true,
          sent: true,
          unchanged: true,
          translated,
          reason: 'manual-translate-same-text-sent',
        };
      }

      if (!tryTakeWaSendExclusiveGate()) {
        return { ok: false, handled: false, reason: 'manual-translate-busy' };
      }
      gateTaken = true;
      try {
        window.__fastgcWaDomSendConsumed = '0';
      } catch {
        /* empty */
      }

      boxWorking.dataset.fastgcTranslating = '1';
      const wrote = await writeTextToWhatsAppInput(boxWorking, translated, conversation);
      let active = wrote.activeBox || currentComposeBox(boxWorking) || boxWorking;
      let applied =
        wrote.ok &&
        (await waitComposeStablePoll(active, translated, 900)) &&
        (await verifyInputStableAfterDeferredMs(active, translated));
      if (!applied) {
        requireActiveConversation(conversation);
          applyInsertedTextViaTextContent(active, translated);
        await waitComposeStablePoll(active, translated, 900);
        applied = await verifyInputStableAfterDeferredMs(active, translated);
        if (!applied) {
          const retryBox = currentComposeBox(active) || active;
          requireActiveConversation(conversation);
            applyInsertedTextViaTextContent(retryBox, translated);
          await waitComposeStablePoll(retryBox, translated, 900);
          applied = await verifyInputStableAfterDeferredMs(retryBox, translated);
          if (!applied) {
            return { ok: false, handled: false, reason: 'manual-translate-compose-not-applied' };
          }
          active = currentComposeBox(retryBox) || retryBox;
        }
      }

      await wait(45);
      requireActiveConversation(conversation);
      performWaDomSend(active);
      return { ok: true, handled: true, translated, sent: true, unchanged: false, reason: 'manual-translate-sent' };
    } catch (error) {
      const reason = error instanceof Error && error.message === 'manual-translate-chat-changed' ? error.message : 'manual-translate-error';
      notifyNonBlocking(reason);
      return { ok: false, handled: false, reason };
    } finally {
      const finalEl = currentComposeBox(boxWorking);
      try {
        if (finalEl?.dataset) finalEl.dataset.fastgcTranslating = '0';
      } catch {
        /* empty */
      }
      if (gateTaken) scheduleReleaseWaSendExclusive(200);
    }
  };
  window.__fastgcManualTranslateAndSend = translateComposerAndSend;

  /**
   * Enter / 发送键 / insertParagraph：开启发送翻译时拦截。
   * - 源/目标语种相同 → 直接发送。
   * - 否则走 `translateComposerAndSend`：**译败不发**，**译成则发**（内容不限）。
   */
  const routeComposerSendIntent = async (mergedBox: HTMLElement | null | undefined): Promise<void> => {
    const b0 = mergedBox ?? findComposeBox();
    if (!b0) return;

    const cfg = getConfig();
    if (!cfg.enabled) {
      performWaDomSend(b0);
      return;
    }

    const originalNorm = normalizeComposeValue(readComposeText(b0));
    if (!originalNorm) return;

    try {
      window.__fastgcWaDomSendConsumed = '0';
    } catch {
      /* empty */
    }

    const slNorm = normalizeFastgcTranslateLang(cfg.sourceLang, 'auto');
    const tlNorm = normalizeFastgcTranslateLang(cfg.targetLang || 'en', 'en');

    if (slNorm !== 'auto' && slNorm.toLowerCase() === tlNorm.toLowerCase()) {
      performWaDomSend(b0);
      return;
    }

    const r = await translateComposerAndSend();
    if (r?.unchanged && !r?.sent) {
      const b1 = currentComposeBox(b0) || findComposeBox() || b0;
      performWaDomSend(b1);
    }
  };

  const isInsideCompose = (target: EventTarget | null, event: Event | null): boolean => {
    const box = findComposeBox();
    if (!box || !target) return false;
    const t = target as Node | null;
    if (box === t || (t && typeof box.contains === 'function' && box.contains(t))) return true;
    try {
      const ae = document.activeElement;
      if (ae && (ae === box || box.contains(ae))) return true;
    } catch {
      /* empty */
    }
    try {
      const path =
        typeof (event as Event & { composedPath?: () => EventTarget[] })?.composedPath === 'function'
          ? (event as Event & { composedPath: () => EventTarget[] }).composedPath()
          : [];
      if (Array.isArray(path) && path.indexOf(box) !== -1) return true;
    } catch {
      /* empty */
    }
    return false;
  };

  /**
   * 仅拦截会话输入框（footer composer）对应的发送按钮。
   * 媒体/文件预览层里的发送按钮不走文本翻译管线，必须放行，否则会出现“无法发送文件”。
   */
  const isComposeSendButton = (btn: Element | null): boolean => {
    if (!btn) return false;
    const box = findComposeBox();
    if (!box) return false;
    const btnFooter = typeof (btn as Element).closest === 'function' ? (btn as Element).closest('footer') : null;
    const boxFooter = typeof box.closest === 'function' ? box.closest('footer') : null;
    if (btnFooter && boxFooter) return btnFooter === boxFooter;
    return Boolean(btnFooter && !boxFooter);
  };

  document.addEventListener(
    'input',
    (e) => {
      if (isInsideCompose(e.target, e)) markComposeActivity();
    },
    true,
  );

  const swallowEvent = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    if (typeof (e as Event & { stopImmediatePropagation?: () => void }).stopImmediatePropagation === 'function')
      (e as Event & { stopImmediatePropagation: () => void }).stopImmediatePropagation();
  };

  /** 未开启发送翻译时不拦截，由 WhatsApp 处理 Enter / 发送。 */
  const shouldBypassTranslateInterception = (): boolean => {
    return !getConfig().enabled;
  };

  const flushAfterProcessAttempt = (): void => {
    const mergedBox = afterProcessKickCoalesceBox;
    afterProcessKickCoalesceBox = undefined;

    const b0 = mergedBox ?? findComposeBox();
    const fp = b0 ? `${normalizeComposeValue(readComposeText(b0))}|${String(readComposeText(b0).length)}` : '';
    const now = Date.now();
    if (fp && now - lastAfterProcessAtMs < AFTER_PROCESS_FP_DEDUP_MS && fp === lastAfterProcessFp) {
      fgSendDbg('afterProcessAttempt-deduped', { fp });
      return;
    }
    lastAfterProcessAtMs = now;
    lastAfterProcessFp = fp;

    void routeComposerSendIntent(mergedBox).catch(() => {
      notifyNonBlocking('send-translate-process-soft-error');
      const b = mergedBox ?? findComposeBox();
      const orig = b ? readComposeText(b) : '';
      void restoreOriginalToComposer(b, orig).finally(() => {
        scheduleReleaseWaSendExclusive(200);
        if (b) performWaDomSend(b);
      });
    });
  };

  const afterProcessAttempt = (box: HTMLElement | null): void => {
    afterProcessKickCoalesceBox = (box ?? afterProcessKickCoalesceBox) ?? undefined;
    if (afterProcessKickCoalesceArmed) {
      fgSendDbg('afterProcessAttempt-coalesce-merged');
      return;
    }
    afterProcessKickCoalesceArmed = true;
    queueMicrotask(() => {
      afterProcessKickCoalesceArmed = false;
      flushAfterProcessAttempt();
    });
  };

  const onSendKeydown = (e: KeyboardEvent) => {
    if (e.isTrusted === false) return;
    if (window.__fastgcInternalSend === '1') return;
    if (shouldBypassTranslateInterception()) return;
    const target = e.target as Node | null;
    const boxLocal = findComposeBox();
    if (!boxLocal || !isInsideCompose(target, e)) return;
    markComposeActivity();

    const kcLegacy =
      typeof (e as unknown as { keyCode?: number }).keyCode === 'number'
        ? (e as unknown as { keyCode?: number }).keyCode
        : 0;

    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.isComposing || kcLegacy === 229)
      return;

    if (window.__fastgcWriteComposerLock === '1') {
      swallowEvent(e);
      return;
    }

    if (window.__fastgcWaSendExclusiveGate === '1') {
      swallowEvent(e);
      return;
    }

    if ((boxLocal.dataset.fastgcTranslating ?? '') === '1') {
      swallowEvent(e);
      return;
    }

    e.preventDefault();
    swallowEvent(e);
    afterProcessAttempt(boxLocal);
  };

  document.addEventListener('keydown', onSendKeydown as EventListener, true);

  const handleSendButtonEvent = (e: Event) => {
    if ((e as Event & { isTrusted?: boolean }).isTrusted === false) return;
    if (window.__fastgcInternalSend === '1') return;
    if (shouldBypassTranslateInterception()) return;

    const btn =
      e.target && (e.target as Element).closest instanceof Function
        ? (e.target as Element).closest('button,[role="button"]')
        : null;
    if (!btn) return;

    const isSendByTestId = btn.getAttribute('data-testid') === 'send';
    const hasSendIcon = !!btn.querySelector('span[data-icon="send"]');
    const label = String(btn.getAttribute('aria-label') || '').toLowerCase();
    const isSendByLabel = label === 'send' || label.includes('发送');
    if (!isSendByTestId && !hasSendIcon && !isSendByLabel) return;
    if (!isComposeSendButton(btn)) return;

    const boxHit = findComposeBox();
    const pipelineBusy =
      window.__fastgcWriteComposerLock === '1' ||
      window.__fastgcWaSendExclusiveGate === '1' ||
      window.__fastgcSendButtonGestureBusy === '1' ||
      window.__fastgcSendPipelineBusy === '1' ||
      window.__fastgcSendInFlight === '1' ||
      (boxHit?.dataset.fastgcTranslating ?? '') === '1';

    if (pipelineBusy) {
      swallowEvent(e);
      return;
    }

    swallowEvent(e);
    window.__fastgcSendButtonGestureBusy = '1';
    afterProcessAttempt(boxHit);
  };

  document.addEventListener('click', handleSendButtonEvent, true);

  const onBeforeInput = (e: Event) => {
    if ((e as Event & { isTrusted?: boolean }).isTrusted === false) return;
    if (window.__fastgcInternalSend === '1') return;
    if (shouldBypassTranslateInterception()) return;

    const inputType = String((e as InputEvent).inputType || '');
    const boxPeek = findComposeBox();
    if (
      window.__fastgcWriteComposerLock === '1' &&
      inputType === 'insertParagraph' &&
      boxPeek &&
      isInsideCompose((e as InputEvent).target, e)
    ) {
      swallowEvent(e);
      return;
    }

    if (window.__fastgcWaSendExclusiveGate === '1') {
      swallowEvent(e);
      return;
    }

    if (inputType !== 'insertParagraph') return;

    const boxBf = findComposeBox();
    if (!boxBf || !isInsideCompose((e as InputEvent).target, e)) return;
    if ((boxBf.dataset.fastgcTranslating ?? '') === '1') {
      swallowEvent(e);
      return;
    }

    swallowEvent(e);
    afterProcessAttempt(boxBf);
  };

  document.addEventListener('beforeinput', onBeforeInput, true);
}
