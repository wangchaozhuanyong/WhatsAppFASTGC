/**
 * WhatsApp WebView 注入入口：先于本文件的 translate core 已在外层 IIFE 中注入，
 * 本 bundle 需作为「内层 IIFE」挂入同一外层，以保持闭包可见 translateTextFastgcDetailed / FASTGC_BRIDGE_MS 等。
 */

import { installFastgcWaSendPipeline } from './sendTranslatePipeline';

installFastgcWaSendPipeline();
