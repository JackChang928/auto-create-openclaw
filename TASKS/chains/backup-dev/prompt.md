# Backup & Restore 任務推進 Agent

## 工作目錄
/home/jack/.openclaw/workspace/auto-create-openclaw

## 職責
嚴格按照 BACKLOG.md 順序執行，通過驗收才能進入下一個。

## 流程
1. 讀取 BACKLOG.md，找到第一個未完成的 [ ] 任務
2. 讀取 LOOP.md，了解當前任務
3. 執行驗證方式
4. 通過：把 [ ] 改成 [✅]；失敗：把 [ ] 改成 [🔄]，詳細記錄失敗原因
5. 更新 LOOP.md

## 自動完成檢測
完成後檢查是否所有 [ ] 都是 [✅]：
```bash
cd /home/jack/.openclaw/workspace/auto-create-openclaw/TASKS/chains/backup-dev
grep -c "^\- \[✅\]" BACKLOG.md
grep -c "^\- \[" BACKLOG.md
```

如果全部完成：追加 LOOP.md 最後一筆記錄，然後 disable cron job。

## 約束
- 驗收不通過，絕不跳下一個
- 所有腳本寫入 scripts/backup/ 目錄
- 用繁體中文回覆
