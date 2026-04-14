# Auth Service Task Chain

## Phase 1: 基礎結構
- [x] **T1**: 驗證 JWT 簽發邏輯完整（secret、expiresIn）✅ 2026-04-09
- [x] **T2**: 驗證 Redis Pub/Sub 事件發送邏輯 ✅ 2026-04-09
- [x] **T3**: 驗證 `/api/auth/verify` 端點邏輯 ✅ 2026-04-09
- [x] **T4**: ✅ 實現 Refresh Token 機制（2026-04-09 實現）

## Phase 2: 安全強化
- [x] **T5**: 實現 Rate Limiting
- [x] **T6**: 實現 Token Blacklist（logout 後撤銷）
- [x] **T7**: 實現 Refresh Token Rotation

## Phase 3: 整合
- [ ] **T8**: 與 server.js 的 auth middleware 整合測試

---

## T4: 實現 Refresh Token 機制

**時間**: 2026-04-09T15:50:00Z
**結果**: ✅ 完成

### 實現內容

#### 1. 新增 Helper Functions（index.js）

```js
// 統一簽發 Access + Refresh Token
function issueTokens(payload) {
  const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
  const refreshToken = crypto.randomBytes(32).toString('hex');
  return { accessToken, refreshToken, expiresIn: '24h' };
}

// Refresh Token 存儲至 Redis（TTL: 7 days）
async function storeRefreshToken(token, payload) {
  await redisClient.setex(`refresh_token:${token}`, 604800, JSON.stringify(payload));
}

// 驗證 Refresh Token
async function getRefreshTokenPayload(token) {
  const data = await redisClient.get(`refresh_token:${token}`);
  return data ? JSON.parse(data) : null;
}
```

#### 2. 新增端點

| 端點 | 方法 | 功能 |
|------|------|------|
| `/api/auth/refresh` | POST | 用 refresh_token 換取新 access_token |
| `/api/auth/logout` | POST | 撤銷 refresh_token |

#### 3. 修改現有端點

- `POST /api/auth/login`：登入時同時回傳 `token` + `refresh_token`
- `POST /api/auth/user-login`：同上

#### 4. Redis Client 擴展

新增 `redisClient`（ioredis 實例）用於 Refresh Token 的 SET/GET/DEL 操作，
區分於 Pub/Sub 的 `redisPublisher`。

#### 5. Token 生命週期

| Token 類型 | 有效期 | 存儲位置 |
|-----------|--------|---------|
| Access Token | 24h | Client 內存 |
| Refresh Token | 7 days | Redis（`refresh_token:<token>` key） |

### 驗證方式

```bash
# 1. 登入取得 tokens
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'

# 回應包含：
# { "success": true, "token": "<access_token>", "refresh_token": "<refresh_token>", "expires_in": "24h" }

# 2. 用 refresh_token 換新 access_token
curl -X POST http://localhost:3001/api/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refresh_token":"<refresh_token>"}'

# 回應：
# { "success": true, "token": "<new_access_token>", "expires_in": "24h" }

# 3. Logout（撤銷 refresh_token）
curl -X POST http://localhost:3001/api/auth/logout \
  -H "Content-Type: application/json" \
  -d '{"refresh_token":"<refresh_token>"}'
```

### 對 Phase 2 的支援

- **T5 (Rate Limiting)**: Refresh Token 存於 Redis，可作為 identify user 的 key
- **T6 (Token Blacklist)**: Logout 時 `redisClient.del()` 撤銷，配合 access token blacklist set
- **T7 (Refresh Token Rotation)**: Rotation 時需更新 Redis 中的 refresh token payload，基礎架構已就緒

### 結論

✅ T4 完成。基礎 Refresh Token 機制已實現：
1. ✅ 頒發（login 回應包含 `refresh_token`）
2. ✅ 存儲（Redis，TTL 7 days）
3. ✅ 兌換（`POST /api/auth/refresh` 頒發新 access_token）
4. ✅ 撤銷（`POST /api/auth/logout` 刪除 Redis key）

Phase 2（Rate Limiting、Token Blacklist、Refresh Token Rotation）準備就緒。
