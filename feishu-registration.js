/**
 * feishu-registration.js — Feishu App Registration API wrapper.
 *
 * Replicates the flow from @larksuite/openclaw-lark-tools:
 *   1. init()  → check supported auth methods
 *   2. begin() → get verification_uri_complete + device_code
 *   3. poll()  → wait for user scan → receive client_id + client_secret
 */

const BASE_URL = 'https://accounts.feishu.cn';
const REGISTRATION_ENDPOINT = '/oauth/v1/app/registration';

/**
 * Step 1: Initialize registration — check capabilities.
 */
export async function initRegistration() {
  const res = await fetch(`${BASE_URL}${REGISTRATION_ENDPOINT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ action: 'init' }).toString(),
  });
  const data = await res.json();
  if (!data.supported_auth_methods?.includes('client_secret')) {
    throw new Error('Environment does not support client_secret auth');
  }
  return data;
}

/**
 * Step 2: Begin registration — get QR code URL and device code.
 * @returns {{ verification_uri_complete: string, device_code: string, interval: number, expire_in: number }}
 */
export async function beginRegistration() {
  const res = await fetch(`${BASE_URL}${REGISTRATION_ENDPOINT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      action: 'begin',
      archetype: 'PersonalAgent',
      auth_method: 'client_secret',
      request_user_info: 'open_id',
    }).toString(),
  });
  const data = await res.json();
  if (!data.verification_uri_complete || !data.device_code) {
    throw new Error(`Begin registration failed: ${JSON.stringify(data)}`);
  }
  return {
    verificationUrl: data.verification_uri_complete,
    deviceCode: data.device_code,
    interval: data.interval || 5,
    expireIn: data.expire_in || 600,
  };
}

/**
 * Step 3: Poll registration — check if user has scanned QR code.
 * @returns {{ status: 'pending'|'completed'|'denied'|'expired', appId?, appSecret?, openId?, domain? }}
 */
export async function pollRegistration(deviceCode) {
  let baseUrl = BASE_URL;

  const res = await fetch(`${baseUrl}${REGISTRATION_ENDPOINT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      action: 'poll',
      device_code: deviceCode,
    }).toString(),
  });
  const data = await res.json();

  // Success — bot created
  if (data.client_id && data.client_secret) {
    const isLark = data.user_info?.tenant_brand === 'lark';

    // If lark tenant, retry with lark domain
    if (isLark) {
      const larkRes = await fetch(`https://accounts.larksuite.com${REGISTRATION_ENDPOINT}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          action: 'poll',
          device_code: deviceCode,
        }).toString(),
      });
      const larkData = await larkRes.json();
      if (larkData.client_id && larkData.client_secret) {
        return {
          status: 'completed',
          appId: larkData.client_id,
          appSecret: larkData.client_secret,
          openId: larkData.user_info?.open_id,
          domain: 'lark',
        };
      }
    }

    return {
      status: 'completed',
      appId: data.client_id,
      appSecret: data.client_secret,
      openId: data.user_info?.open_id,
      domain: isLark ? 'lark' : 'feishu',
    };
  }

  // Error states
  if (data.error === 'authorization_pending') {
    return { status: 'pending' };
  }
  if (data.error === 'slow_down') {
    return { status: 'pending', slowDown: true };
  }
  if (data.error === 'access_denied') {
    return { status: 'denied' };
  }
  if (data.error === 'expired_token') {
    return { status: 'expired' };
  }

  return { status: 'pending' };
}
