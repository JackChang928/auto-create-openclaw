# Codex 遠端 OAuth 故障排查

## 1. `refresh_token_reused`

症狀：
- `openclaw status --usage` 或 `openclaw models status` 出現 refresh token 失效
- 錯誤訊息類似：`Your refresh token has already been used to generate a new access token`

原因：
- OpenAI Codex OAuth refresh token 旋轉後，舊 token 失效
- 同一帳號在 OpenClaw、Codex CLI、其他機器重複登入時，舊 refresh token 常被淘汰

處理：
- 不要改用 API key，若使用者明確要求保留 Codex 訂閱路徑
- 重新走一次 OAuth 授權
- 優先用 `scripts/codex-paste-auth.js`

## 2. 為什麼純貼上模式能跨不同電腦？

因為它不依賴本機 callback 成功，只依賴：
1. 生成授權 URL
2. 使用者在任意瀏覽器登入
3. 使用者從瀏覽器地址欄複製完整 redirect URL
4. 腳本從 URL 取出 `code` 和 `state`
5. 本機用 PKCE 交換 token

這模式適合：
- Telegram / Feishu 遠端操控
- 使用者在別台筆電或手機登入
- 不想碰 tunnel、localhost、瀏覽器同機限制

## 3. 何時用 tunnel 模式？

用 `scripts/codex-tunnel-auth.js` 當：
- 使用者不想手動貼上 redirect URL
- 目標環境裝有 `cloudflared`
- 可以接受公開臨時 callback URL

注意：
- 若 port `1455` 被舊流程占用，先清掉
- tunnel URL 每次都會變
- callback 版本更方便，但比純貼上模式多一層外部依賴

## 4. `state mismatch`

原因：
- 貼了舊的 redirect URL
- 重新產生過新連結，但貼回的是上一輪結果

處理：
- 丟棄舊 URL
- 重新生成一次整套授權連結
- 確保貼回的 `state` 與當前流程一致

## 5. `code` 過期 / 交換失敗

原因：
- authorization code 已過期
- 連結放太久才登入
- code 已被用過一次

處理：
- 重新開一輪授權
- 用 tmux 保持流程活著
- 連結產生後儘快登入並貼回結果

## 6. `EADDRINUSE: 127.0.0.1:1455`

原因：
- 舊的 OAuth 測試流程沒關乾淨

處理：
```bash
fuser -k 1455/tcp 2>/dev/null || true
```

若仍有殘留，再檢查：
```bash
ss -tlnp | grep 1455
```

## 7. 用 tmux 保持流程不掉線

純貼上模式：
```bash
tmux new-session -d -s codex-auth "node scripts/codex-paste-auth.js"
tmux capture-pane -t codex-auth -p
```

把使用者貼回的 redirect URL 送進去：
```bash
tmux send-keys -t codex-auth 'http://localhost:1455/auth/callback?code=...&state=...' Enter
```

## 8. 寫入位置

預設寫入：
- `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

預設 profile：
- `openai-codex:default`

## 9. 完成後必要動作

授權成功後：
```bash
openclaw gateway restart
```

驗證可再查：
```bash
openclaw models status
openclaw status --usage
```
