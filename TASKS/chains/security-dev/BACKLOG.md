# Security Dev Task Chain

## Phase 1: 基礎安全審計
- [✅] **T1**: 檢查 JWT secret 是否够強（推測攻擊防護）— 發現多個嚴重漏洞：使用預設 secret、HS256 無 algorithm 限制、secret entropy 不足（已修復）
- [✅] **T2**: 檢查所有 API 端點的輸入驗證（SQL Injection 防護）— auth-service 無 SQL，全部使用 Redis；server.js/billing-service 均使用參數化查詢（?/$1）
- [✅] **T3**: 檢查 API rate limiting 是否存在並生效 — auth-service 已實現 Redis ZSET sliding window（15min 窗口，5 次請求/IP），middleware 正確包裝 login/user-login
- [✅] **T4**: 檢查 error messages 是否洩露敏感資訊 — 發現並修復 2 處洩露：(1) auth-service user-login 洩露測試密碼 12345678 (2) server.js 9 處 err.message 洩露內部錯誤細節

## Phase 2: 認證與授權
- [✅] **T5**: 檢查 admin endpoints 是否有 `requireAdmin` middleware — server.js 所有管理端點（instances, set-budget, activate, start, stop, delete, health, spend）均已正確使用 requireAdmin middleware
- [✅] **T6**: 實現 CORS 嚴格策略（僅允許已知域名）— server.js 已有嚴格配置；auth-service 修復：`cors()` → `cors({ origin: [/^http:\/\/localhost(:\d+)?$/, 'https://claw.venturet.co'], ... })`
- [✅] **T7**: 實現 API Key 輪換机制 — 完成實現：
  1. `scripts/key-rotation.js` — 主輪換腳本，實現：
     - Redis 存儲：活躍 key + 版本歷史（sorted set）+ key info（hash, 前綴, 創建時間）
     - 寬限期机制：舊 key 進入 24 小時寬限期，期滿自動失效
     - Litellm 重啟：輪換後自動重啟 litellm-proxy 容器加載新 key
     - 版本清理：最多保留 5 個歷史版本
  2. `key-rotation-validate.js` — Key 驗證中間件（validateMasterKey + Express middleware）
  3. `scripts/key-rotation.timer` + `key-rotation.service` — Systemd 計時器，每 7 天自動輪換
  4. `.env` 更新：輪換時自動寫入新 LITELLM_MASTER_KEY
  注意：server.js 重啟後自動讀取新 key

## Phase 3: 容器安全
- [✅] **T8**: 檢查 Docker 容器是否以非 root 使用者運行 — auth-service/Dockerfile 和 billing-service/Dockerfile 修復：新增 appuser:appgroup，USER appuser；deploy/standalone/Dockerfile 已有 USER node
- [✅] **T9**: 實現容器資源限制（CPU、記憶體）— docker-compose.yml 新增 `deploy.resources.limits/reservations`：litellm(1CPU/1G), postgres(0.5/512M), redis(0.25/128M), fluent-bit(0.25/128M), billing(0.5/256M), auth(0.5/256M)
- [✅] **T10**: 實現網路隔離（容器間網路不通）— 重構 docker-compose.yml：三層網路 (1) `openclaw_net` 僅 litellm/auth-service (2) `db_net` 僅 litellm/postgres/billing (3) `redis_net` 所有服務。移除 postgres/redis 外部暴露端口。
