#!/usr/bin/env node
/**
 * OpenAI Codex OAuth — pure paste mode for remote/headless auth.
 *
 * Flow:
 * 1) Print an auth URL.
 * 2) User opens it on any device and signs in.
 * 3) Browser attempts to redirect to localhost and fails (expected).
 * 4) User copies the full redirect URL from the address bar.
 * 5) Script extracts code/state, exchanges tokens, and writes auth-profiles.json.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const AUTH_URL_BASE = 'https://auth.openai.com/oauth/authorize';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const SCOPE = 'openid profile email offline_access';

function usage() {
  console.log(`Usage: node codex-paste-auth.js [--agent <agentId>] [--profile-id <id>]

Remote/headless OpenAI Codex OAuth using manual paste.

Options:
  --agent <agentId>       Target agent id (default: main)
  --profile-id <id>       Auth profile id (default: openai-codex:default)
  -h, --help              Show this help
`);
}

function parseArgs(argv) {
  const args = { agentId: 'main', profileId: 'openai-codex:default' };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--agent') {
      args.agentId = argv[++i];
    } else if (arg === '--profile-id') {
      args.profileId = argv[++i];
    } else if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function createState() {
  return crypto.randomBytes(16).toString('hex');
}

async function exchangeCode(code, verifier, redirectUri) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const json = await response.json();
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
    throw new Error(`Token exchange failed: ${JSON.stringify(json)}`);
  }

  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

function decodeJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64').toString());
  } catch {
    return null;
  }
}

function getAccountId(accessToken) {
  const payload = decodeJwt(accessToken);
  return payload?.['https://api.openai.com/auth']?.chatgpt_account_id || null;
}

function parseAuthInput(input) {
  const trimmed = input.trim();

  try {
    const url = new URL(trimmed);
    return {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    };
  } catch {}

  if (trimmed.includes('#')) {
    const [queryLike, state] = trimmed.split('#', 2);
    const params = new URLSearchParams(queryLike.replace(/.*\?/, ''));
    return { code: params.get('code') ?? undefined, state };
  }

  if (trimmed.includes('code=')) {
    const params = new URLSearchParams(trimmed.includes('?') ? trimmed.split('?')[1] : trimmed);
    return {
      code: params.get('code') ?? undefined,
      state: params.get('state') ?? undefined,
    };
  }

  return { code: trimmed || undefined, state: undefined };
}

async function waitForPaste(prompt) {
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt + ': ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function getProfilesPath(agentId) {
  const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME || '/home/user', '.openclaw');
  return path.join(stateDir, 'agents', agentId, 'agent', 'auth-profiles.json');
}

function saveProfile({ agentId, profileId, tokens }) {
  const profilesPath = getProfilesPath(agentId);
  let data = { version: 1, profiles: {} };

  try {
    data = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
  } catch {}

  data.profiles[profileId] = {
    type: 'oauth',
    provider: 'openai-codex',
    access: tokens.access,
    refresh: tokens.refresh,
    expires: tokens.expires,
  };

  data.lastGood = data.lastGood || {};
  data.lastGood['openai-codex'] = profileId;

  fs.writeFileSync(profilesPath, JSON.stringify(data, null, 2));
  return profilesPath;
}

async function main() {
  const args = parseArgs(process.argv);

  console.log('\n============================================');
  console.log('   OpenAI Codex OAuth — 純貼上遠端授權');
  console.log('============================================\n');

  const { verifier, challenge } = generatePKCE();
  const state = createState();

  const authUrl = new URL(AUTH_URL_BASE);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('id_token_add_organizations', 'true');
  authUrl.searchParams.set('codex_cli_simplified_flow', 'true');
  authUrl.searchParams.set('originator', 'pi-remote');

  console.log('1) 在任意裝置瀏覽器打開以下網址：\n');
  console.log(authUrl.toString());
  console.log('\n2) 完成登入後，頁面跳去 localhost 失敗屬正常。');
  console.log('3) 從瀏覽器地址欄複製完整網址，再貼回這個腳本。\n');

  let code = null;
  for (let attempt = 1; attempt <= 20 && !code; attempt++) {
    const input = await waitForPaste(`貼上完整 redirect URL（${attempt}/20）`);
    if (!input) {
      console.log('未收到內容，請重試。');
      continue;
    }

    const parsed = parseAuthInput(input);
    if (parsed.state && parsed.state !== state) {
      console.log('State 不匹配，請確認貼的是本次授權完成後的網址。\n');
      continue;
    }
    if (!parsed.code) {
      console.log('無法提取 code，請貼完整網址。\n');
      continue;
    }
    code = parsed.code;
  }

  if (!code) throw new Error('超過重試次數，未取得授權碼');

  console.log('\n正在交換 token...');
  const tokens = await exchangeCode(code, verifier, REDIRECT_URI);
  const accountId = getAccountId(tokens.access);
  const profilesPath = saveProfile({ agentId: args.agentId, profileId: args.profileId, tokens });

  console.log('✅ Codex OAuth 已更新');
  console.log(`Agent: ${args.agentId}`);
  console.log(`Profile: ${args.profileId}`);
  console.log(`Account ID: ${accountId || '(unknown)'}`);
  console.log(`Expires: ${new Date(tokens.expires).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
  console.log(`Saved: ${profilesPath}`);
  console.log('\n接著執行：openclaw gateway restart');
}

main().catch((error) => {
  console.error(`\n❌ ${error.message}`);
  process.exit(1);
});
