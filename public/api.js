/**
 * api.js — OpenClaw Unified API Layer
 * 所有前端頁面統一引用此檔案作為 API 溝通層
 * 
 * 使用方式:
 *   const api = new OpenClawAPI('/api');           // 一般頁面
 *   const api = new OpenClawAPI('/api', token);    // 已登入
 *   await api.register({ userNickname, botNickname });
 *   await api.pollRegistration(id);
 *   await api.getInstances();
 *   await api.instanceAction(id, 'start'|'stop'|'delete', { budget });
 */

class OpenClawAPI {
  constructor(baseUrl = '/api', token = null) {
    this.baseUrl = baseUrl;
    this._token = token || this._loadToken();
  }

  // ─── Token Management ───────────────────────────────────────
  _loadToken() {
    return localStorage.getItem('user_token') || localStorage.getItem('admin_token') || null;
  }

  setToken(token) {
    this._token = token;
  }

  clearToken() {
    this._token = null;
    localStorage.removeItem('user_token');
    localStorage.removeItem('admin_token');
  }

  // ─── Low-level fetch wrapper ──────────────────────────────────
  async _fetch(path, options = {}) {
    const url = this.baseUrl + path;
    const headers = {
      'Content-Type': 'application/json',
      ...(this._token && { 'Authorization': `Bearer ${this._token}` }),
      ...options.headers,
    };

    let res;
    try {
      res = await fetch(url, { ...options, headers });
    } catch (err) {
      throw new Error(`網路連線失敗: ${err.message}`);
    }

    // Handle auth errors
    if (res.status === 401 || res.status === 403) {
      this.clearToken();
      window.dispatchEvent(new CustomEvent('api:auth-error', { detail: { url, status: res.status } }));
      throw new Error('登入已過期，請重新整理頁面');
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `伺服器錯誤 (HTTP ${res.status})`);
      return data;
    }

    await res.text();
    throw new Error(`伺服器回傳非 JSON（HTTP ${res.status}）`);
  }

  // ─── User / Registration ──────────────────────────────────────
  /**
   * 提交註冊表單
   * @param {string} userNickname - 用戶暱稱
   * @param {string} botNickname  - Bot 暱稱
   * @returns {{ id, qrDataUrl, verificationUrl }}
   */
  async register({ userNickname, botNickname }) {
    return this._fetch('/register', {
      method: 'POST',
      body: JSON.stringify({ userNickname, botNickname }),
    });
  }

  /**
   * Register a new Hermes Agent instance
   * @param {{ userNickname, botNickname, openaiApiKey, channels, telegramBotToken, discordBotToken }} opts
   */
  async registerHermes({ userNickname, botNickname, openaiApiKey, channels, telegramBotToken, discordBotToken }) {
    return this._fetch('/register/hermes', {
      method: 'POST',
      body: JSON.stringify({ userNickname, botNickname, openaiApiKey, channels, telegramBotToken, discordBotToken }),
    });
  }

  /**
   * 輪詢註冊狀態
   * @param {string} id - 註冊流程 ID
   * @returns {{ status: 'pending'|'completed'|'expired'|'denied', ... }}
   */
  async pollRegistration(id) {
    return this._fetch(`/register/poll/${id}`);
  }

  /**
   * 取得目前登入用戶的實例資訊
   * @returns {{ agentId, userNickname, botNickname, isRunning, budget, ... }}
   */
  async getMe() {
    return this._fetch('/user/me');
  }

  // ─── Admin ───────────────────────────────────────────────────
  /**
   * 列出所有實例（需 Admin token）
   * @returns {Array} instances
   */
  async getInstances() {
    return this._fetch('/instances');
  }

  async getDashboardInstances(refresh = false) {
    return this._fetch(`/admin/dashboard/instances${refresh ? '?refresh=1' : ''}`);
  }

  async getDashboardInstance(id, refresh = false) {
    return this._fetch(`/admin/dashboard/instances/${id}${refresh ? '?refresh=1' : ''}`);
  }

  async getDashboardLogs(id, { source = 'docker', tail = 120 } = {}) {
    const q = new URLSearchParams({ source, tail: String(tail) });
    return this._fetch(`/admin/dashboard/instances/${id}/logs?${q.toString()}`);
  }

  async getDashboardEvents(id, { limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    return this._fetch(`/admin/dashboard/instances/${id}/events?${q.toString()}`);
  }

  async getAuthStatus(id) {
    return this._fetch(`/instance/${id}/auth/status`);
  }

  async resetCodexAuth(id) {
    return this._fetch(`/instance/${id}/auth/codex/reset`, { method: 'POST' });
  }

  /**
   * 設定實例 API 預算
   * @param {number} id     - 實例 ID
   * @param {number} budget - 預算上限 (USD)
   */
  async setBudget(id, budget) {
    return this._fetch(`/instance/${id}/set-budget`, {
      method: 'POST',
      body: JSON.stringify({ budget }),
    });
  }

  /**
   * 激活實例（provision + 綁定飛書）
   * @param {number} id - 實例 ID
   */
  async activate(id) {
    return this._fetch(`/instance/${id}/activate`, { method: 'POST' });
  }

  /**
   * 啟動實例 gateway
   * @param {number} id - 實例 ID
   */
  async start(id) {
    return this._fetch(`/instance/${id}/start`, { method: 'POST' });
  }

  /**
   * 停止實例 gateway
   * @param {number} id - 實例 ID
   */
  async stop(id) {
    return this._fetch(`/instance/${id}/stop`, { method: 'POST' });
  }

  /**
   * 刪除實例（容器 + 記錄）
   * @param {number} id - 實例 ID
   */
  async deleteInstance(id) {
    return this._fetch(`/instance/${id}/delete`, { method: 'POST' });
  }
}

// ─── Admin API Helper ──────────────────────────────────────────
class OpenClawAdminAPI extends OpenClawAPI {
  constructor() {
    super('/api', localStorage.getItem('admin_token'));
  }

  setTokenFromLogin(token) {
    localStorage.setItem('admin_token', token);
    this._token = token;
  }

  isLoggedIn() {
    return !!this._loadToken();
  }
}

// Export for use in browser
window.OpenClawAPI = OpenClawAPI;
window.OpenClawAdminAPI = OpenClawAdminAPI;
