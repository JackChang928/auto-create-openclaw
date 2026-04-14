#!/usr/bin/env bash
set -e

WORKSPACE_DIR="/home/node/.openclaw/workspace"
MEMORY_DIR="${WORKSPACE_DIR}/memory"
CONFIG_FILE="/home/node/.openclaw/openclaw.json"

USER_NICK="${USER_NICKNAME:-Human}"
BOT_NICK="${BOT_NICKNAME:-OpenClaw Agent}"

echo ">> Ensuring workspace directories exist..."
mkdir -p "$MEMORY_DIR"

if [ ! -f "$WORKSPACE_DIR/BOOTSTRAP.md" ]; then
    echo ">> Seeding Markdown files..."

    cat <<EOF > "$WORKSPACE_DIR/BOOTSTRAP.md"
# BOOTSTRAP.md

This workspace is automatically seeded for the standalone Dockerized OpenClaw deployment.

## Important
- Keep the OpenClaw-generated scaffold files unless explicitly asked to replace them.
- HEARTBEAT is disabled by config in this product. Background maintenance should use cron jobs instead.
- MEMORY.md + memory/YYYY-MM-DD.md are the canonical markdown memory layer.
- Do not store API keys, bot secrets, or credentials in workspace memory files.

## Product Execution Rules
- For document generation, spreadsheets, exports, parsing, and data cleaning: **default to Python-first execution**.
- For Python package workflows: prefer **uv** over ad-hoc pip usage when possible.
- If the user intent is ambiguous, **clarify the target format / destination / fields before executing**.

After first-run orientation, this file may be deleted.
EOF

    cat <<EOF > "$WORKSPACE_DIR/MEMORY.md"
# MEMORY.md

> Canonical long-term memory for this deployed agent.

## Memory Rules
- Use \`memory/YYYY-MM-DD.md\` for daily logs.
- Use this file only for durable rules, preferences, decisions, and reusable context.
- Prefer markdown files as the source of truth over transient recall.
- Never store secrets, tokens, raw API keys, or credentials here.
EOF

    cat <<EOF > "$WORKSPACE_DIR/HEARTBEAT.md"
# HEARTBEAT.md

# Heartbeat is intentionally disabled for this product by default.
# Use cron for daily memory maintenance and other exact scheduled tasks.
EOF

    cat <<EOF > "$WORKSPACE_DIR/TOOLS.md"
# TOOLS.md

## Product Notes
- For spreadsheets, exports, OCR post-processing, and structured data work, prefer **Python** tools over pure model-only generation.
- For Python package management and disposable package execution, prefer **uv** workflows.
EOF

    cat <<EOF > "$WORKSPACE_DIR/USER.md"
# USER.md - About Your Human

- **Name:** ${USER_NICK}
- **What to call them:** ${USER_NICK}
- **Timezone:** ${TZ:-Asia/Taipei}
- **Notes:**
  - This workspace was provisioned for ${BOT_NICK}.
  - Update this file over time as durable, user-approved preferences become clear.
EOF

    cat <<EOF > "$WORKSPACE_DIR/IDENTITY.md"
# ${BOT_NICK}

你是 **${BOT_NICK}**，一位智慧 AI 助手。

## 用戶資訊
- **用戶暱稱**: ${USER_NICK}
- 請稱呼用戶為「${USER_NICK}」

## 行為準則
- 友善、專業、有幫助
- 使用用戶偏好的語言回覆
- 需要幫忙處理資料、報表填寫等工作時，**優先用 Python 處理**，並使用 **uv** 工作流
- 承諾開始處理需求後，若遇到阻礙或需要更多資料，**要主動回報目前進度與卡點**
- 不要做沒有進度產出的空虛回覆
EOF

    cat <<EOF > "$MEMORY_DIR/README.md"
# memory/

Use this directory for daily memory logs and topic notes.

## Conventions
- Daily file: \`memory/YYYY-MM-DD.md\`
- Long-term curated memory: workspace root \`MEMORY.md\`
- Do not store secrets in these files.
EOF
fi

if [ ! -f "$CONFIG_FILE" ]; then
    echo ">> Running openclaw onboard to initialize config..."
    # Generate a random gateway token for local isolation if none provided
    if [ -z "$OPENCLAW_GATEWAY_TOKEN" ]; then
        export OPENCLAW_GATEWAY_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
    fi

    # Onboard the agent into local mode
    openclaw onboard --non-interactive --mode local --auth-choice openai-api-key --secret-input-mode ref --gateway-auth token --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN --accept-risk --skip-health
fi

echo ">> Patching openclaw.json defaults via Node.js..."
node -e "
const fs = require('fs');
const file = '$CONFIG_FILE';
if (fs.existsSync(file)) {
  const config = JSON.parse(fs.readFileSync(file, 'utf-8'));
  
  if (!config.gateway) config.gateway = {};
  config.gateway.mode = 'local';
  config.gateway.bind = 'lan';
  config.gateway.port = 18789;
  
  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};
  
  // Disable automatic heartbeat
  config.agents.defaults.heartbeat = {
    ...(config.agents.defaults.heartbeat || {}),
    every: '0m',
  };
  
  // Model setup
  config.agents.defaults.model = {
    ...(typeof config.agents.defaults.model === 'object' && config.agents.defaults.model ? config.agents.defaults.model : {}),
    primary: 'openai/gpt-5.4',
  };
  
  config.agents.defaults.models = {
    ...(config.agents.defaults.models || {}),
    'openai/gpt-4.1-mini': { alias: 'Mini' },
    'openai/gpt-5.4': { alias: 'GPT 5.4' },
    'minimax-cn/MiniMax-M2.7': { alias: 'MiniMax M2.7' },
  };
  
  // Tools profile
  if (!config.tools || typeof config.tools !== 'object') config.tools = {};
  config.tools.profile = 'full';
  
  // Plugin configurations
  if (process.env.FEISHU_DOMAIN) {
      if (!config.channels) config.channels = {};
      if (!config.channels.feishu) config.channels.feishu = {};
      config.channels.feishu.domain = process.env.FEISHU_DOMAIN;
  }
  
  if (process.env.FEISHU_OPEN_ID) {
      if (!config.channels) config.channels = {};
      if (!config.channels.feishu) config.channels.feishu = {};
      config.channels.feishu.dmPolicy = 'allowlist';
      config.channels.feishu.allowFrom = [...new Set([...(config.channels.feishu.allowFrom || []), process.env.FEISHU_OPEN_ID])];
      config.channels.feishu.groupPolicy = config.channels.feishu.groupPolicy || 'allowlist';
      config.channels.feishu.groupAllowFrom = [...new Set([...(config.channels.feishu.groupAllowFrom || []), process.env.FEISHU_OPEN_ID])];
      if (!config.channels.feishu.groups) {
          config.channels.feishu.groups = { '*': { enabled: true } };
      }
  }

  // Reset allow list for openclaw-lark to re-install properly if needed
  if (config.plugins && config.plugins.allow && Array.isArray(config.plugins.allow)) {
      config.plugins.allow = config.plugins.allow.filter(name => name !== 'openclaw-lark');
  }
  
  fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf-8');
}
"

if [ -n "$FEISHU_APP_ID" ] && [ -n "$FEISHU_APP_SECRET" ]; then
    echo ">> Installing/Updating Feishu Plugin (@larksuite/openclaw-lark)..."
    npx -y @larksuite/openclaw-lark install --app "${FEISHU_APP_ID}:${FEISHU_APP_SECRET}" --skip-version-check
fi

echo ">> Setup complete. Starting OpenClaw Gateway on port 18789..."
# Foreground execution to keep container alive and capture logs natively 
exec openclaw gateway run --allow-unconfigured --port 18789
