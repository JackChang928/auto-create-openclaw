/**
 * channels/index.js — 頻道適配器出口
 *
 * 統一從這裡匯出所有頻道適配器，方便未來擴展。
 */
export { validateBotToken, sendTestMessage, buildOpenClawChannelConfig } from './telegram-adapter.js';
export {
  validateBotToken as validateDiscordBotToken,
  sendTestDM,
  buildOpenClawChannelConfig as buildDiscordChannelConfig,
  buildOAuthInviteUrl,
} from './discord-adapter.js';
