# 故障排除指南

> 針對 auto-create-openclaw 平台的常見問題診斷與解決方案。

---

## 目錄

1. [服務無法啟動](#1-服務無法啟動)
2. [認證相關問題](#2-認證相關問題)
3. [LiteLLM 相關問題](#3-litellm-相關問題)
4. [Langfuse 觀測性問題](#4-langfuse-觀測性問題)
5. [容器相關問題](#5-容器相關問題)
6. [網路與連線問題](#6-網路與連線問題)
7. [用戶實例問題](#7-用戶實例問題)

---

## 1. 服務無法啟動

### 徵兆：`start.sh` 執行失敗

**檢查順序：**

```bash
# 1. 確認 Docker 正在運行
docker ps

# 2. 確認 .env 檔案存在且有正確值
cat .env | grep -E "OPENAI_API_KEY|LITELLM_MASTER_KEY|JWT_SECRET"

# 3. 重新執行啟動腳本（加 debug 輸出）
bash -x start.sh 2>&1 | tee start-debug.log
```

### 徵兆：某個容器一直重啟

```bash
# 查看特定容器日誌
docker compose logs <service-name>

# 範例：查看 LiteLLM 容器
docker compose logs litellm --tail=100
```

### 徵兆：埠口被占用

```bash
# 查找占用埠口的程序
sudo lsof -i :3210  # API 伺服器
sudo lsof -i :4000  # LiteLLM Proxy
sudo lsof -i :3002  # Langfuse

# 更換埠口：編輯 docker-compose.yml 或 server.js
```

---

## 2. 認證相關問題

### 徵兆：API 返回 401 Unauthorized

**原因：** 未提供或提供了錯誤的 Bearer Token

**解決：**
```bash
# 確認使用正確的 LITELLM_MASTER_KEY
curl http://localhost:3210/api/health \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY"
```

### 徵兆：JWT Token 驗證失敗

**原因：** JWT_SECRET 與當初設定的不同

**解決：** 重新產生 JWT_SECRET
```bash
# 產生新密鑰
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# 將新密鑰更新到 .env 的 JWT_SECRET
# 然後重啟服務
docker compose restart
```

### 徵兆：Admin 登入失敗

```bash
# 檢查 ADMIN_USERNAME 和 ADMIN_PASSWORD 是否正確設定
grep ADMIN .env

# 確認 auth-service 容器運行正常
docker compose ps auth-service

# 查看 auth-service 日誌
docker compose logs auth-service --tail=50
```

---

## 3. LiteLLM 相關問題

### 徵兆：LiteLLM 返回 403 Forbidden

**原因：** `LITELLM_MASTER_KEY` 與 docker-compose.yml 中設定不一致

**解決：**
```bash
# 確認 docker-compose.yml 和 .env 中的 LITELLM_MASTER_KEY 一致
grep LITELLM_MASTER_KEY docker-compose.yml
grep LITELLM_MASTER_KEY .env

# 如果不同，更新 docker-compose.yml 或重啟讓它讀取正確值
docker compose up -d litellm
```

### 徵兆：模型調用返回 400/500 錯誤

```bash
# 1. 確認 API Key 正確設定
docker compose exec litellm env | grep API_KEY

# 2. 測試直接呼叫 LiteLLM
curl -X POST http://localhost:4000/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -d '{"model": "openai/gpt-4o-mini", "messages": [{"role": "user", "content": "test"}]}'

# 3. 查看 LiteLLM 日誌
docker compose logs litellm --tail=100
```

### 徵兆：LiteLLM 健康檢查失敗

```bash
# 手動觸發健康檢查
curl http://localhost:4000/health

# 查看 litellm 容器狀態
docker inspect auto-create-openclaw-litellm-1 | jq '.[0].State'
```

---

## 4. Langfuse 觀測性問題

### 徵兆：Langfuse 無法開啟

```bash
# 檢查 Langfuse 容器狀態
docker compose ps langfuse

# 健康檢查
curl http://localhost:3002/api/public/health

# 查看 Langfuse 日誌
docker compose logs langfuse --tail=100
```

### 徵兆：LiteLLM traces 未出現在 Langfuse

**原因 1：** Langfuse OTEL endpoint 或 auth 設定錯誤

```bash
# 確認 litellm 容器的 OTEL 環境變數
docker compose exec litellm env | grep OTEL

# 應該看到：
# OTEL_EXPORTER_OTLP_ENDPOINT=http://langfuse:3000/api/public/otel
# OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic ...
```

**原因 2：** 沒有實際的 LLM 調用（traces 需要實際 API 呼叫才會產生）

```bash
# 觸發一筆測試 LLM 呼叫
# （需要有效的 OPENAI_API_KEY）
curl -X POST http://localhost:4000/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -d '{"model": "openai/gpt-4o-mini", "messages": [{"role": "user", "content": "Hello"}]}'
```

**原因 3：** Langfuse 接收 traces 時的 auth 問題

```bash
# 檢查 Langfuse 是否收到資料（看日誌）
docker compose logs langfuse 2>&1 | grep -i "otel\|trace\|error" | tail -20

# 確認 Langfuse 的 auth key 設定正確
docker compose exec langfuse env | grep LANGFUSE
```

### 徵兆：Langfuse 頁面載入緩慢或空白

```bash
# 檢查 Langfuse 是否正常運行（記憶體不足可能導致）
docker stats auto-create-openclaw-langfuse-1 --no-stream

# 檢查 ClickHouse 或 PostgreSQL 是否正常
docker compose ps | grep -E "postgres|clickhouse"
```

---

## 5. 容器相關問題

### 徵兆：容器一直 restart

```bash
# 查看重啟原因
docker inspect auto-create-openclaw-<service>-1 | jq '.[0].State'

# 查看死亡原因
docker compose logs --tail=200 <service> 2>&1 | tail -50
```

### 徵兆：磁碟空間不足

```bash
# 查看 Docker 磁碟使用
docker system df

# 清理未使用的映像/容器/網路
docker system prune -af --volumes

# 清理特定映像
docker rmi $(docker images -f "dangling=true" -q)
```

### 徵兆：無法進入容器

```bash
# 確認容器正在運行
docker compose ps <service>

# 使用正確的容器名稱進入
docker exec -it auto-create-openclaw-server-1 bash
docker exec -it auto-create-openclaw-litellm-1 sh
```

---

## 6. 網路與連線問題

### 徵兆：服務之間無法互相溝通

```bash
# 確認容器在同一個網路
docker network inspect auto-create-openclaw_auto-create-network

# 測試 DNS 解析
docker compose exec litellm ping -c 1 langfuse
docker compose exec server ping -c 1 postgres
```

### 徵兆：外部無法訪問服務

```bash
# 確認埠口映射正確
docker compose ps

# 檢查防火牆設定
sudo ufw status  # Linux
# 或檢查雲端安全群組（AWS/GCP/Azure）
```

---

## 7. 用戶實例問題

### 徵兆：用戶實例無法啟動

```bash
# 使用 ops CLI 查看詳細狀態
node src/opstools.js list
node src/opstools.js status <instance_id>

# 查看實例容器日誌
node src/opstools.js logs <instance_id>

# 檢查容器資源限制
node src/opstools.js container-stats <instance_id>
```

### 徵兆：用戶實例無回應

```bash
# 重啟實例
node src/opstools.js restart <instance_id>

# 查看完整事件日誌
node src/opstools.js events <instance_id>
```

### 徵兆：預算查詢返回錯誤

```bash
# 直接測試 budget API
curl http://localhost:3210/api/admin/budget/jack \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY"

# 查看 billing-service 日誌
docker compose logs billing-service --tail=50
```

---

## 快速診斷腳本

複製以下腳本到伺服器上執行，可快速取得所有關鍵資訊：

```bash
#!/bin/bash
echo "=== Auto-Create-OpenClaw 診斷報告 ==="
echo ""

echo "【容器狀態】"
docker compose ps 2>/dev/null || docker ps --filter "name=auto-create"

echo ""
echo "【服務健康檢查】"
curl -s http://localhost:3210/api/health -H "Authorization: Bearer $LITELLM_MASTER_KEY" | head -c 200
echo ""

echo ""
echo "【LiteLLM 健康】"
curl -s http://localhost:4000/health | head -c 200
echo ""

echo ""
echo "【Langfuse 健康】"
curl -s http://localhost:3002/api/public/health | head -c 200
echo ""

echo ""
echo "【最近的錯誤日誌】"
docker compose logs --tail=50 2>/dev/null | grep -iE "error|exception|fail" | tail -20
```

---

## 獲取進一步幫助

1. **查看即時日誌：**
   ```bash
   docker compose logs -f [service-name]
   ```

2. **查看完整文檔：**
   - API 文件：http://localhost:3210/docs
   - 管理手冊：`docs/ADMIN_MANUAL.md`

3. **常見問題社群：**
   - GitHub Issues: https://github.com/JackChang928/auto-create-openclaw/issues

---

*本文件由 Auto-Create-Ops 系統自動維護的最後更新：2026-04-15*
