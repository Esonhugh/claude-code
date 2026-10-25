---
name: fork-release-wiki
description: 在 Esonhugh/claude-code fork 做發布前檢查（release-check、bytecode build、lint）或新增/更新 docs/features 功能文件並同步 GitHub Wiki 時使用。
version: 0.1.0
---

# 發布檢查與 Wiki 文件

正式發布門禁（四路並行驗收）用 `release-validation` skill。本 skill 是日常合併前檢查與文件流程。未經使用者明確授權，不打 tag、不發 release、不推 master。

## 合併前檢查（每個 fix PR）

```bash
bun install --frozen-lockfile
bun run lint                          # 必跑：曾因兩個空 catch 打壞 release-check（#95 → #96）
NODE_OPTIONS=--max-old-space-size=12000 bunx tsc --noEmit
bun test <相關測試>
env -u CLAUDE_CODE_VERSION make build  # 產出 ./built-claude，接著用 fork-binary-testing 實測
```

## make release-check 內容

依序：package.json version 必須是 `0.0.0-dev` → `check:changelog $(VERSION)` → `test:changelog` → `check-readme-test-paths` → `tsc --noEmit` → `check-mods-control-types` → `lint` → `audit:missing` → 臨時目錄 build 並驗 `--version` 含 `$(VERSION) (Claude Code)` 與 `--help` → `git diff --check`。

- 版本來源是 Makefile 的 `VERSION`；改版本要同步 CHANGELOG（check:changelog 會驗）。
- CHANGELOG 衝突：兩邊都保留，新的在上。

## Bytecode binary

- `bun package:binary` 用 `bun build --compile --bytecode --format=esm`（`scripts/package-binary.mjs`）；`--version` 約 66 ms、`-p` 約 0.75 s。
- `release.yml` 對產物跑 `--version`、`--help`、`node ./scripts/verify-bundled-image-runtime.mjs <artifact>`；本地發布前照跑一遍。
- x64 / x64-baseline（`make linux-baseline`）可本地驗；musl 只能在 Alpine 執行（本地無 docker）。
- 本地跨架構 `package:binary` 失敗多半是其他平台的 optional ripgrep 依賴沒裝，CI 各 runner 原生建置，不算 bug。

## 功能文件（docs/features）

- README 只保留總覽 + 功能表；每個功能一份 `docs/features/<english-kebab-name>.md`，新功能要加檔並在 README 表格加一列。
- 寫法：白話，章節固定為「這是什麼 / 什麼時候用 / 快速上手（分步）/ 操作表或命令速查 / 實際輸出」，複雜功能要多張分步截圖。範本：`docs/features/background-sessions.md`。
- 截圖：用重建 binary 在 tmux 對 fake API 跑（隔離方法見 fork-binary-testing），ANSI → HTML → Playwright 轉 PNG，放 `docs/features/images/`。
- 文件中寫的行為要以實測為準；實測和舊 README 不符時記為問題（先開 issue），不要照抄。

## Wiki 同步

- **只改 `docs/features`，永遠不直接改 Wiki**。
- `.github/workflows/wiki-sync.yml` 在 push 到 dev/master 且動到 `docs/features/**`、`scripts/build-wiki.mjs` 或 workflow 本身時觸發：`bun scripts/build-wiki.mjs <out> <blob-base>` 產生頁面（README→Home、kebab→Title-Case、_Sidebar），以 GITHUB_TOKEN 推到 `.wiki.git`；Wiki 上不在 docs/features 的頁面會被刪。
- repo 預設分支是 master，所以 `workflow_dispatch` 要等檔案進 master 才看得到；平常靠 dev push 觸發。
- 合併後確認 Actions 的 wiki-sync run 成功，再到 Wiki 抽查頁數與 _Sidebar。
