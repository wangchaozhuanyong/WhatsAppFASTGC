import {
  isWaGroupChatKey,
  normalizePhone,
  normalizeWaChatKey,
  phoneFromWaChatKey,
} from './phoneNormalize';

export const WA_CHAT_BINDING_DB_NAME = 'fastgc-wa-chat-bindings';
export const WA_CHAT_BINDING_DB_VERSION = 1;
export const WA_CHAT_BINDING_STORE = 'chatBindings';

export type WaAccountType = 'personal' | 'business' | 'group';

export interface WaChatBindingPayload {
  chatId?: string;
  chatKey?: string;
  phone?: string;
  displayName?: string;
  accountType?: string;
  source?: string;
  pending?: boolean;
  lastUpdatedAt?: number;
}

export interface WaChatBinding {
  chatId: string;
  phone: string;
  displayName: string;
  accountType: WaAccountType;
  source: string;
  pending: boolean;
  lastUpdatedAt: number;
}

export function makeWaChatBinding(payload: WaChatBindingPayload = {}): WaChatBinding {
  const chatId = normalizeWaChatKey(payload.chatId || payload.chatKey || '');
  const phone = normalizePhone(payload.phone || phoneFromWaChatKey(chatId) || '');
  const isGroup = isWaGroupChatKey(chatId) || payload.accountType === 'group';
  return {
    chatId,
    phone: isGroup ? '' : phone,
    displayName: String(payload.displayName || '').trim(),
    accountType: isGroup ? 'group' : payload.accountType === 'business' ? 'business' : 'personal',
    source: String(payload.source || '').trim() || 'internal-state',
    pending: Boolean(payload.pending),
    lastUpdatedAt: Number(payload.lastUpdatedAt || Date.now()) || Date.now(),
  };
}

export function openWaChatBindingDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) {
      reject(new Error('INDEXEDDB_UNAVAILABLE'));
      return;
    }
    const req = indexedDB.open(WA_CHAT_BINDING_DB_NAME, WA_CHAT_BINDING_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(WA_CHAT_BINDING_STORE)) {
        const store = db.createObjectStore(WA_CHAT_BINDING_STORE, { keyPath: 'chatId' });
        try {
          store.createIndex('phone', 'phone', { unique: false });
        } catch {
          /* ignore */
        }
        try {
          store.createIndex('lastUpdatedAt', 'lastUpdatedAt', { unique: false });
        } catch {
          /* ignore */
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('INDEXEDDB_OPEN_FAILED'));
  });
}

export async function loadWaChatBindingsFromDb(): Promise<WaChatBinding[]> {
  try {
    const db = await openWaChatBindingDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(WA_CHAT_BINDING_STORE, 'readonly');
      const req = tx.objectStore(WA_CHAT_BINDING_STORE).getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

export async function persistWaChatBindingToDb(binding: WaChatBindingPayload): Promise<boolean> {
  const b = makeWaChatBinding(binding);
  if (!b.chatId) return false;
  try {
    const db = await openWaChatBindingDb();
    await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(WA_CHAT_BINDING_STORE, 'readwrite');
      tx.objectStore(WA_CHAT_BINDING_STORE).put(b);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('INDEXEDDB_WRITE_FAILED'));
    });
    return true;
  } catch {
    try {
      const raw = JSON.parse(
        globalThis.localStorage?.getItem('fastgc_wa_chat_bindings_fallback_v1') || '{}',
      );
      raw[b.chatId] = b;
      globalThis.localStorage?.setItem(
        'fastgc_wa_chat_bindings_fallback_v1',
        JSON.stringify(raw),
      );
    } catch {
      /* ignore */
    }
    return false;
  }
}
