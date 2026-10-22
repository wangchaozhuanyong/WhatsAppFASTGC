/**
 * 由 index.html 中 WA_INJECT_TRANSLATE_CORE 注入到 WhatsApp WebView 外层 IIFE 的词法常量。
 * WebView 管线 bundle 作为内层 IIFE 与 core 同属该外层闭包。
 */
declare function translateTextFastgcDetailed(
  text: string,
  sourceLang: string,
  targetLang: string,
): Promise<{ ok?: boolean; text?: string; error?: string; bridgeError?: string }>;

declare const FASTGC_BRIDGE_MS: number;
/** 与 index.html WA_INJECT_TRANSLATE_CORE 中 gtx fetch 超时一致（桥失败后再走兜底） */
declare const FASTGC_FALLBACK_FETCH_MS: number;

declare function normalizeFastgcTranslateLang(lang: unknown, fallback: string): string;
