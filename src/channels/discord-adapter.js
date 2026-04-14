/**
 * discord-adapter.js — Discord Bot 頻道註冊適配器
 *
 * 功能：
 * 1. 驗證 Bot Token 有效性（via GET /users/@me）
 * 2. 發送測試訊息確認 Token 可用（DM 到指定用戶）
 * 3. 產生 OpenClaw 設定結構
 *
 * Discord 與 Telegram 的差異：
 * - Telegram：用戶自行輸入 Bot Token（直觀風陳）
 * - Discord：需要 OAuth2 流程或手動輸入 Bot Token
 *   → 我們支援「用戶輸入 Bot Token」方式（最簡單）
 */

const DISCORD_API = 'https://discord.com/api/v10';

/**
 * 驗證 Discord Bot Token
 * @param {string} botToken - Bot token (格式: xxxxxxxxx.xxxxxx.xxxxxxxxxxxxxxxx)
 * @returns {{ ok: boolean, botUsername?: string, botId?: string, error?: string }}
 */
export async function validateBotToken(botToken) {
  try {
    const res = await fetch(`${DISCORD_API}/users/@me`, {
      method: 'GET',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { ok: false, error: err.message || `HTTP ${res.status}` };
    }
    const data = await res.json();
    return {
      ok: true,
      botUsername: data.username,
      botId: data.id,
      // DiscordBot 帳號沒有 first_name，只有 username
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 發送測試 DM 給指定用戶，確認 Bot 有權限發訊
 * @param {string} botToken - Bot Token
 * @param {string} userId - 目標用戶的 Discord User ID
 * @param {string} [customMessage]
 * @returns {{ ok: boolean, messageId?: string, channelId?: string, error?: string }}
 */
export async function sendTestDM(botToken, userId, customMessage = '✅ 您的 OpenClaw Discord Bot 已成功連接！') {
  try {
    // Step 1: 創建/取得 DM channel
    const dmRes = await fetch(`${DISCORD_API}/users/@me/channels`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ recipient_id: userId }),
    });
    if (!dmRes.ok) {
      const err = await dmRes.json().catch(() => ({}));
      return { ok: false, error: `無法創建 DM：${err.message || `HTTP ${dmRes.status}`}` };
    }
    const dmChannel = await dmRes.json();

    // Step 2: 發送測試訊息
    const msgRes = await fetch(`${DISCORD_API}/channels/${dmChannel.id}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: customMessage }),
    });
    if (!msgRes.ok) {
      const err = await msgRes.json().catch(() => ({}));
      return { ok: false, error: `無法發送訊息：${err.message || `HTTP ${msgRes.status}`}` };
    }
    const msgData = await msgRes.json();
    return { ok: true, messageId: msgData.id, channelId: dmChannel.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 完整的 Discord Bot 設定流程
 * @param {string} botToken - Bot Token
 * @param {string} adminDiscordId - 管理員的 Discord User ID（用於 DM 認證）
 * @returns {{ success: boolean, credentials?: object, error?: string }}
 */
export async function setupDiscordBot(botToken, adminDiscordId) {
  // Step 1: 驗證 Token
  const validation = await validateBotToken(botToken);
  if (!validation.ok) {
    return { success: false, error: `Token 無效：${validation.error}` };
  }

  // Step 2: 發送測試 DM
  if (adminDiscordId) {
    const testDM = await sendTestDM(botToken, adminDiscordId);
    if (!testDM.ok) {
      return {
        success: false,
        error: `Token 有效但無法發 DM：${testDM.error}（請確認 Bot 已被添加至有該用戶的伺服器，且擁有發訊權限）`
      };
    }
  }

  // Step 3: 產生設定結構（供 patchChannelPostInstall 使用）
  const credentials = {
    botToken,
    botUsername: validation.botUsername,
    botId: validation.botId,
    enabled: true,
    dmPolicy: 'allowlist',
    allowFrom: adminDiscordId ? [String(adminDiscordId)] : [],
    groups: { '*': { requireMention: false } }, // Discord 群組不需要 mention
  };

  return { success: true, credentials };
}

/**
 * 將 credentials 轉換為 OpenClaw channels.discord 設定
 * @param {object} credentials - setupDiscordBot 回傳的 credentials
 * @param {string} adminDiscordId - 管理員的 Discord ID (用於 allowlist)
 * @returns {object} - OpenClaw channels.discord 設定物件
 */
export function buildOpenClawChannelConfig(credentials, adminDiscordId) {
  return {
    enabled: true,
    botToken: credentials.botToken,
    dmPolicy: 'allowlist',
    allowFrom: adminDiscordId ? [String(adminDiscordId)] : [],
    groups: credentials.groups || { '*': { requireMention: false } },
  };
}

/**
 * 生成 Discord OAuth2 邀請連結（可選的替代設定方式）
 * 讓用戶一鍵授權添加 Bot 到伺服器
 *
 * @param {string} clientId - Discord Application Client ID
 * @param {string[]} scopes - 所需的 OAuth scopes，預設 ['bot', 'applications.commands']
 * @param {number} permissions - Bot 權限整數，預設 6741868032 (Send Messages + Embed Links + etc.)
 * @returns {string} - OAuth2 邀請 URL
 */
export function buildOAuthInviteUrl(clientId, scopes = ['bot', 'applications.commands'], permissions = 6741868032n) {
  const scopeStr = scopes.join(' ');
  const permissionsStr = String(permissions);
  return `https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=${permissionsStr}&scope=${encodeURIComponent(scopeStr)}`;
}
