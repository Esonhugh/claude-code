---
name: fork-pr-flow
description: 在 Esonhugh/claude-code fork 發現問題、提交修復、開 PR 與合併時使用：先開 issue、依領域拆 commit、PR 開到 dev 並自行驗證後合併。
version: 0.1.0
---

# Fork 的 issue → PR → 合併流程

## 規則（使用者訂的）

- **目標分支是 `dev`**（2026-10-21 起取代 feat/mods）。只有 Direct Connect 這類大功能才另開長期分支。永不推 master、不發 release。
- **修復直接合進 dev，不等使用者 review**（2026-10-23）：驗證過（重建 binary 實測、相關測試綠、tsc/lint 乾淨）就自己合併，再回報。
- **先開 issue 再開 PR**，PR 內文連結 issue（例如 #4 → #5）。
- **commit 依領域拆分**：啟動/退出、Agent、設定/權限、任務框架/Teams、Mods。一個 commit 不跨領域。

## 步驟

1. **重現並記錄**：用 fork-binary-testing 在隔離環境重現，和官方 2.1.303 對照。先搜既有 issue 避免重複，再開 issue：現象、重現步驟、官方行為、證據路徑。
2. **最小失敗測試**：先寫能重現的最小測試，再修根因；不跳過、不放寬斷言、不吞例外。
3. **分支與 commit**：從最新 `origin/dev` 開分支；按領域拆 commit，訊息說清目的，不誇大範圍。提交前看 `git status`、`git diff`，清掉除錯碼。若改到 CHANGELOG，衝突時兩邊保留、新的在上。
4. **驗證**：`bun run lint`、`tsc --noEmit`（`NODE_OPTIONS=--max-old-space-size=12000`）、相關 `bun test`、`make build` 後用新 binary 實測（流程見 fork-release-wiki 的合併前檢查）。
5. **開 PR 到 dev**：內文含 `Fixes #NN`、修復前/後行為、驗證命令與結果、證據檔路徑（`/mnt/project-files/research/acceptance/accept-<topic>.md`、`research/probe/<topic>/`）。
6. **合併**：CI 綠後用 merge commit 合進 dev，標題沿用 `Merge PR #NN: <title>`。
7. **手動關 issue**：dev 不是預設分支，`Fixes #NN` 不會自動關；合併後手動關閉並註明 PR。
8. **回報**：修了什麼、修復前/後行為、驗證了什麼、未驗證項與風險。

## 常見注意

- 多個 PR 改同一檔（如 permissions.ts）時，以「對官方 binary 實測的行為」決定保留哪邊，並在 PR 寫明取捨。
- 有疑問的使用者決策（行為要不要對齊官方）先問；已定的決策記在 team memory，別重問。
- 不 `--no-verify`、不 force-push 別人的分支、不刪測試換綠燈。
