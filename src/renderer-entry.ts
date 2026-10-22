/**
 * Electron 宿主 index.html 以 IIFE 全局 `FastGcWaShared` 消费；按需逐步迁入更多纯逻辑模块。
 */

export type { WaChatBinding, WaChatBindingPayload } from './wa/chatBinding';

export {
  WA_CHAT_BINDING_DB_NAME,
  WA_CHAT_BINDING_DB_VERSION,
  WA_CHAT_BINDING_STORE,
  loadWaChatBindingsFromDb,
  makeWaChatBinding,
  openWaChatBindingDb,
  persistWaChatBindingToDb,
} from './wa/chatBinding';

export {
  isWaGlobalInboxStatusFeedRow,
  isWaGroupChatKey,
  isWaStatusFeedChatKey,
  normalizePhone,
  normalizeWaChatKey,
  phoneFromWaChatKey,
} from './wa/phoneNormalize';
