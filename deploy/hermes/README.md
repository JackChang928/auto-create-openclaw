# Hermes Agent 部署指南

## 概述

本目錄提供在 auto-create-openclaw 平台上部署 **Hermes Agent** 的完整配置。

Hermes Agent 是 [NousResearch](https://github.com/nousresearch/hermes-agent) 開發的現代化 AI Agent，
支持多頻道（ Telegram / Discord / Email 等），可作為 OpenClaw 的替代或補充方案。

## 目錄結構

```
hermes/
├── docker-compose.hermes.yml   # Docker Compose 配置
├── Dockerfile                  # 自定義 Hermes 鏡像（可選）
├── entrypoint.sh               # 啟動腳本（SOUL.md / config.yaml 自動初始化）
├── deploy.sh                   # 部署腳本
├── .env.hermes.prod.example    # 生產環境變數範本
└── README.md                   # 本文件
```

## 快速部署

### 方式一：使用官方 Hermes Image

```bash
cd deploy/hermes
cp .env.hermes.prod.example .env.hermes.prod
# 編輯 .env.hermes.prod，填入 API Key
./deploy.sh deploy
```

### 方式二：使用自定義 Image（推薦）

```bash
cd deploy/hermes
# 構建自定義鏡像（包含中文 SOUL.md 和默認配置）
./deploy.sh build
./deploy.sh deploy
```

## Docker Compose 使用方式

### 獨立啟動
```bash
docker compose -f docker-compose.hermes.yml up -d
```

### 與現有 stack 合併
```bash
# 同時運行 OpenClaw 和 Hermes
docker compose -f ../standalone/docker-compose.yml -f docker-compose.hermes.yml up -d
```

### 環境變數覆蓋
```bash
HERMES_PORT=18800 docker compose -f docker-compose.hermes.yml up -d
```

## 與 OpenClaw 的差異

| 項目 | OpenClaw | Hermes Agent |
|------|----------|-------------|
| 預設端口 | 18789 | 18790 |
| 配置方式 | JSON config | YAML + .env |
| 多頻道 | 需插件 | 內建 |
| 記憶體需求 | 2GB | 4GB（含 browser tools）|
| 數據目錄 | `~/.openclaw` | `~/.hermes` |

## Kubernetes 部署

如需 Kubernetes，可使用以下資源：

```yaml
# hermes-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hermes-agent
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: hermes-agent
          image: ghcr.io/jackchang928/auto-create-openclaw-hermes:latest
          ports:
            - containerPort: 18790
          resources:
            limits:
              memory: "4Gi"
              cpu: "2"
          envFrom:
            - secretRef:
                name: hermes-secrets
```

## 故障排除

### Hermes 啟動失敗
```bash
# 查看日誌
docker compose -f docker-compose.hermes.yml logs -f

# 檢查數據目錄權限
ls -la /var/lib/docker/volumes/hermes_hermes_data/_data/
```

### API Key 未生效
確認 `.env` 文件中每行的 key=value 格式正確，**不能有引號包裹值**：
```bash
# ✅ 正確
OPENAI_API_KEY=sk-xxxx

# ❌ 錯誤
OPENAI_API_KEY="sk-xxxx"
```

### Telegram Bot 無法連接
檢查 `TELEGRAM_BOT_TOKEN` 是否正確設定，以及 Bot 是否有正確的 API 權限。

## 更新流程

```bash
# 1. 拉取新版本
./deploy.sh pull

# 2. 重啟服務
./deploy.sh restart

# 3. 驗證健康
./deploy.sh status
```
