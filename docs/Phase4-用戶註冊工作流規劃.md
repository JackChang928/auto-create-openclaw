# Phase 4: 用戶註冊工作流引擎

> 規劃時間：2026-04-15 | 規劃者：Arrodes

---

## 背景問題

目前用戶註冊流程（`/api/register`）是**同步單點**，存在以下問題：

1. **流程中斷風險**：用戶點擊「創建实例」→ 飛書授權 → 容器創建 → 通知，任何一步失敗會導致狀態不一致
2. **無重試機制**：網路超時、容器啟動慢等情況只能重試
3. **無法追蹤進度**：客戶只能等待，沒有狀態反饋
4. **長任務阻塞**：容器創建可能需要 5-10 分鐘，HTTP 請求會超時

---

## Temporal 工作流引擎方案

### 為什麼選 Temporal？

根據 [開源工具研究報告](./開源工具研究報告.md)：
- 開源（MIT）+ 基於 PostgreSQL / Redis
- 工作流狀態自動持久化
- 自動重試 + 抄送（exponential backoff）
- 客戶端 SDK 支持 Node.js
- **與現有架構契合**：我們已有 Redis + PostgreSQL

### 整合方案

#### 架構設計

```
用戶點擊「創建實例」
       ↓
  Temporal Workflow 啟動（長期運行，狀態持久化）
       ↓
   Step 1: 等待飛書 OAuth（最多 10 分鐘）
       ↓ (完成)
   Step 2: 創建 OpenClaw 容器（可重試 3 次）
       ↓ (完成)
   Step 3: 配置頻道（Telegram/Discord）
       ↓ (完成)
   Step 4: 發送通知（飛書/Email）
       ↓ (完成)
   Workflow 結束
```

#### 技術棧

| 組件 | 方案 |
|------|------|
| Temporal Server | Docker: `temporalio/auto-setup:1.25.0` |
| Database | 獨立 PostgreSQL schema（`temporal`） |
| Client SDK | `@temporalio/client`（Node.js） |
| Worker | 與 API Server 同進程，或獨立 container |

#### 工作量估算

| 任務 | 時間 | 風險 |
|------|------|------|
| T1: Temporal Server 部署（docker-compose） | 1h | 低 |
| T2: 建立 PostgreSQL schema for Temporal | 30min | 低 |
| T3: 實現 Workflow Definition（Node.js） | 3h | 中 |
| T4: 實現 Activity Functions（容器創建等） | 2h | 中 |
| T5: 改造 `/api/register` 為 Workflow 觸發 | 1h | 中 |
| T6: 前端進度查詢 API（`/api/register/poll/:id`）增強 | 1h | 低 |
| T7: 測試 + 文檔 | 2h | 低 |
| **總計** | **~10.5h** | 中 |

---

## Phase 4 具體任務

### T1: Temporal Server 部署
- 新增 `docker-compose.temporal.yml`（或整合進現有 docker-compose）
- 配置 `TEMPORAL_POSTGRES` + `TEMPORAL_REDIS`
- 驗證：`http://localhost:7233` Health API

### T2: Workflow Definition
```typescript
// src/workflows/user-registration.ts
export async function userRegistrationWorkflow(
  userId: string,
  agentId: string,
  channelConfig: ChannelConfig
): Promise<RegistrationResult> {
  // Step 1: 等待飛書授權（已有 /api/register polling）
  yield await ctx.waitUntil(Date.now() + 10 * 60 * 1000); // 10min timeout
  
  // Step 2: 創建容器（可重試）
  const container = yield await retry(userCreateActivity, {
    retries: 3,
    backoff: { initial: 5000, multiplier: 2 }
  }, agentId, userId);
  
  // Step 3: 配置頻道
  yield await configureChannelActivity(container.id, channelConfig);
  
  // Step 4: 通知
  yield await notifyUserActivity(userId, container);
  
  return { success: true, containerId: container.id };
}
```

### T3: 前端進度追蹤增強
- 現有 `/api/register/poll/:id` 改為查詢 Temporal Workflow 狀態
- 返回：`pending` | `running` | `completed` | `failed` + 當前 Step

---

## 數據隱私考量

- Temporal Server 部署在**本地**，無外部數據上報
- Workflow 狀態包含：用戶ID、agentId、容器配置（不包含敏感訊息）
- 建議：Workflow 歷史記錄保留 30 天後自動清理

---

## 非功能性提升

1. **可靠性**：中途斷網、服務重啟，Workflow 自動恢復
2. **可觀測性**：Langfuse 追蹤 Workflow 級別的長任務
3. **客戶價值**：「5 分鐘創建完成，中間斷網了？回來還在繼續」

---

## 下一步行動

- [ ] Owner 確認 Temporal 方案可行後，開始 T1（部署 Temporal Server）
- [ ] 考慮是否需要单独的 PostgreSQL 實例，或與 LiteLLM 的 PostgreSQL 共享

---

*本規劃由 Arrodes 於 2026-04-15 生成。*
