/**
 * telegram-adapter.js — Telegram Bot 頻道註冊適配器
 *
 * 功能：
 * 1. 驗證 Bot Token 有效性（via getMe）
 * 2. 發送測試訊息確認 Token 可用
 * 3. 產生 OpenClaw 設定結構
 *
 * 對比飛書：飛書是 OAuth device code flow（用戶掃描）
 *         Telegram 是「用戶自行輸入 Bot Token」
 */

const TELEGRAM_API = 'https://api.telegram.org';

/**
 * @param {string} botToken - BotFather token (格式: 123456:ABCdefGHI...)
 * @returns {{ ok: boolean, botUsername?: string, botName?: string, botId?: number }}
 */
export async function validateBotToken(botToken) {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/getMe`, {
    method: 'GET',
  });
  const data = await res.json();
  if (!data.ok) {
    return { ok: false, error: data.description || 'Invalid token' };
  }
  return {
    ok: true,
    botUsername: data.result.username,
    botName: data.result.first_name,
    botId: data.result.id,
  };
}

/**
 * 發送測試訊息給管理員，確認 Bot 可正常發訊
 * @param {string} botToken
 * @param {string|number} adminTelegramId - 管理員的 Telegram user ID
 * @param {string} [customMessage]
 * @returns {{ ok: boolean, messageId?: number|string }}
 */
export async function sendTestMessage(botToken, adminTelegramId, customMessage = '✅ 您的 OpenClaw Telegram Bot 已成功連接！') {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: adminTelegramId,
      text: customMessage,
    }),
  });
  const data = await res.json();
  if (!data.ok) {
    return { ok: false, error: data.description || 'Failed to send message' };
  }
  return { ok: true, messageId: data.result.message_id };
}

/**
 * 完整的 Telegram Bot 設定流程
 * @param {string} botToken
 * @param {string|number} adminTelegramId
 * @returns {{ success: boolean, credentials?: object, error?: string }}
 */
export async function setupTelegramBot(botToken, adminTelegramId) {
  // Step 1: 驗證 Token
  const validation = await validateBotToken(botToken);
  if (!validation.ok) {
    return { success: false, error: `Token 無效：${validation.error}` };
  }

  // Step 2: 發送測試訊息
  const testMsg = await sendTestMessage(botToken, adminTelegramId);
  if (!testMsg.ok) {
    return {
      success: false,
      error: `Token 有效但無法發訊：${testMsg.error}（請確認 Bot 已 start / 已與用戶建立 DM）`
    };
  }

  // Step 3: 產生設定結構（供 patchChannelPostInstall 使用）
  const credentials = {
    botToken,
    botUsername: validation.botUsername,
    botName: validation.botName,
    botId: validation.botId,
    // 預設設定
    enabled: true,
    dmPolicy: 'pairing', // 讓 OpenClaw 的 pairing 機制處理 DM 授權
    groups: { '*': { requireMention: true } },
  };

  return { success: true, credentials };
}

/**
 * 將 credentials 轉換為 OpenClaw channels.telegram 設定
 * @param {object} credentials - setupTelegramBot 回傳的 credentials
 * @param {string} adminTelegramId - 管理員的 Telegram ID (用於 allowlist)
 * @returns {object} - OpenClaw channels.telegram 設定物件
 */
export function buildOpenClawChannelConfig(credentials, adminTelegramId) {
  return {
    enabled: true,
    botToken: credentials.botToken,
    dmPolicy: 'allowlist',        // 我們自己控制 allowFrom，不用 pairing
    allowFrom: adminTelegramId ? [String(adminTelegramId)] : [],
    groups: credentials.groups || { '*': { requireMention: true } },
  };
}
