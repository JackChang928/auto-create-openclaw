#!/usr/bin/env node
/**
 * OpenAI Codex OAuth — tunnel callback mode for remote auth.
 *
 * Flow:
 * 1) Start cloudflared tunnel to localhost:1455.
 * 2) Print auth URL using the public callback URL.
 * 3) User signs in on any device.
 * 4) Callback returns through the tunnel, script exchanges token and saves it.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const AUTH_URL_BASE = 'https://auth.openai.com/oauth/authorize';
const SCOPE = 'openid profile email offline_access';
const LOCAL_PORT = 1455;
const DEFAULT_CLOUDFLARED = '/home/user/.local/bin/cloudflared';

function usage() {
  console.log(`Usage: node codex-tunnel-auth.js [--agent <agentId>] [--profile-id <id>] [--cloudflared <path>]

Remote/headless OpenAI Codex OAuth using a public Cloudflare tunnel callback.

Options:
  --agent <agentId>         Target agent id (default: main)
  --profile-id <id>         Auth profile id (default: openai-codex:default)
  --cloudflared <path>      cloudflared binary path (default: ${DEFAULT_CLOUDFLARED})
  -h, --help                Show this help
`);
}

function parseArgs(argv) {
  const args = {
    agentId: 'main',
    profileId: 'openai-codex:default',
    cloudflared: DEFAULT_CLOUDFLARED,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--agent') args.agentId = argv[++i];
    else if (arg === '--profile-id') args.profileId = argv[++i];
    else if (arg === '--cloudflared') args.cloudflared = argv[++i];
    else if (arg === '-h' || arg === '--help') {
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

function cleanupLocalPort() {
  try {
    execSync(`fuser -k ${LOCAL_PORT}/tcp 2>/dev/null || true`, { stdio: 'ignore', shell: '/bin/bash' });
  } catch {}
}

function startCloudflared(binaryPath) {
  return new Promise((resolve, reject) => {
    const tunnel = spawn(binaryPath, [
      'tunnel',
      '--url', `http://localhost:${LOCAL_PORT}`,
      '--logfile', '/tmp/codex-cloudflared.log',
      '--metrics', 'localhost:0',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      tunnel.kill();
      reject(new Error('cloudflared 啟動超時'));
    }, 30000);

    const handleData = (buf) => {
      if (resolved) return;
      const line = String(buf);
      const match = line.match(/(https?:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com)/);
      if (!match) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ tunnel, url: match[1] });
    };

    tunnel.stdout.on('data', handleData);
    tunnel.stderr.on('data', handleData);
    tunnel.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

function startCallbackServer({ state, verifier, redirectUri }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/auth/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const returnedState = url.searchParams.get('state');
      const code = url.searchParams.get('code');

      if (returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('State mismatch');
        server.close();
        reject(new Error('State mismatch'));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Missing code');
        server.close();
        reject(new Error('Missing code'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body><h1>✅ Codex 授權成功</h1><p>可以關閉這個視窗。</p></body></html>');
      server.close();
      resolve({ code, verifier, redirectUri });
    });

    server.on('error', reject);
    server.listen(LOCAL_PORT, '127.0.0.1', () => {
      console.log(`[server] 監聽 127.0.0.1:${LOCAL_PORT}`);
    });
  });
}

async function main() {
  const args = parseArgs(process.argv);

  cleanupLocalPort();
  const { tunnel, url: publicBaseUrl } = await startCloudflared(args.cloudflared);
  const redirectUri = `${publicBaseUrl}/auth/callback`;

  try {
    console.log(`\n[cloudflared] Public callback: ${redirectUri}\n`);

    const { verifier, challenge } = generatePKCE();
    const state = createState();

    const authUrl = new URL(AUTH_URL_BASE);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', SCOPE);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('id_token_add_organizations', 'true');
    authUrl.searchParams.set('codex_cli_simplified_flow', 'true');
    authUrl.searchParams.set('originator', 'pi-remote');

    console.log('在任意裝置瀏覽器打開以下網址，授權完成後會自動回傳：\n');
    console.log(authUrl.toString());
    console.log('\n等待 callback...\n');

    const { code } = await startCallbackServer({ state, verifier, redirectUri });
    const tokens = await exchangeCode(code, verifier, redirectUri);
    const accountId = getAccountId(tokens.access);
    const profilesPath = saveProfile({ agentId: args.agentId, profileId: args.profileId, tokens });

    console.log('✅ Codex OAuth 已更新');
    console.log(`Agent: ${args.agentId}`);
    console.log(`Profile: ${args.profileId}`);
    console.log(`Account ID: ${accountId || '(unknown)'}`);
    console.log(`Expires: ${new Date(tokens.expires).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
    console.log(`Saved: ${profilesPath}`);
    console.log('\n接著執行：openclaw gateway restart');
  } finally {
    try { tunnel.kill(); } catch {}
  }
}

main().catch((error) => {
  console.error(`\n❌ ${error.message}`);
  process.exit(1);
});
