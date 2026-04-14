/**
 * app.js — OpenClaw Shared Frontend Utilities
 * 所有頁面共享的工具函數（Toast、DOM helpers、通用邏輯）
 */

// ─── DOM Helpers ───────────────────────────────────────────────
const $ = (s, ctx = document) => ctx.querySelector(s);
const $$ = (s, ctx = document) => [...ctx.querySelectorAll(s)];

/**
 * Show a toast notification at the bottom of the screen
 * @param {string} msg - Message to display
 * @param {number} duration - Duration in ms (default 3000)
 */
function showToast(msg, duration = 3000) {
  const existing = document.querySelector('.toast-message');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast-message';
  toast.textContent = msg;
  document.body.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 400);
  }, duration);
}

/**
 * Escape HTML to prevent XSS
 * @param {string} s
 * @returns {string}
 */
function escHtml(s) {
  if (s == null) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

/**
 * Sleep for N milliseconds (Promise-based)
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Build a URL-encoded form body
 * @param {Object} data
 * @returns {string}
 */
function urlEncode(data) {
  return Object.entries(data)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

// ─── Loading State Helpers ──────────────────────────────────────
/**
 * Set button to loading state (disables and shows spinner)
 * @param {HTMLButtonElement} btn
 * @param {string} originalText
 */
function setButtonLoading(btn, originalText = null) {
  btn.disabled = true;
  if (originalText !== null) btn.dataset.originalText = originalText;
  btn.dataset.loading = 'true';
}

/**
 * Restore button from loading state
 * @param {HTMLButtonElement} btn
 */
function clearButtonLoading(btn) {
  btn.disabled = false;
  delete btn.dataset.loading;
}

// ─── Copy to clipboard ──────────────────────────────────────────
/**
 * Copy text to clipboard (with fallback for older browsers)
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

// ─── Auth helpers ───────────────────────────────────────────────
/**
 * Get current user token (checks both user and admin token keys)
 */
function getCurrentToken() {
  return localStorage.getItem('user_token') || localStorage.getItem('admin_token');
}

/**
 * Check if user is logged in
 */
function isLoggedIn() {
  return !!getCurrentToken();
}

/**
 * Clear all auth data and reload
 */
function logout(reason = '已登出') {
  localStorage.removeItem('user_token');
  localStorage.removeItem('admin_token');
  showToast(reason);
}

// ─── Registration Poll Manager ─────────────────────────────────
/**
 * Manages the registration polling lifecycle
 * Returns a controller object with .stop() method
 */
class RegistrationPoll {
  constructor(userId, { onCompleted, onExpired, onDenied, intervalMs = 3000 } = {}) {
    this.userId = userId;
    this.onCompleted = onCompleted || (() => {});
    this.onExpired = onExpired || (() => {});
    this.onDenied = onDenied || (() => {});
    this.intervalMs = intervalMs;
    this._timer = null;
    this._stopped = false;
  }

  start() {
    this._poll();
  }

  _poll() {
    if (this._stopped) return;
    this._timer = setTimeout(async () => {
      try {
        const api = new OpenClawAPI();
        const data = await api.pollRegistration(this.userId);

        if (data.status === 'completed') {
          this._stop();
          this.onCompleted(data);
        } else if (data.status === 'expired' || data.status === 'denied') {
          this._stop();
          this.onDenied(data);
        } else {
          // Still pending, keep polling
          this._poll();
        }
      } catch (err) {
        console.error('Poll error:', err);
        this._poll(); // Keep polling even on error
      }
    }, this.intervalMs);
  }

  stop() {
    this._stop();
  }

  _stop() {
    this._stopped = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}

// ─── Status Badge Map ───────────────────────────────────────────
const STATUS_LABELS = {
  pending_scan: '等待掃碼',
  pending_activation: '等待激活',
  provisioned: '已部署 (未啟動)',
  running: '運行中',
  stopped: '已停止',
  error: '錯誤',
};

function getStatusDotClass(status) {
  const map = {
    pending_scan: 'bg-muted',
    pending_activation: 'bg-warning',
    provisioned: 'bg-blue',
    running: 'bg-success',
    stopped: 'bg-muted',
    error: 'bg-error',
  };
  return map[status] || 'bg-muted';
}

// ─── Register app.js ───────────────────────────────────────────
window.OpenClawApp = {
  $,
  $$,
  showToast,
  escHtml,
  sleep,
  urlEncode,
  copyToClipboard,
  getCurrentToken,
  isLoggedIn,
  logout,
  setButtonLoading,
  clearButtonLoading,
  RegistrationPoll,
  STATUS_LABELS,
  getStatusDotClass,
};
