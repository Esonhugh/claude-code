---
name: fork-binary-testing
description: 在 Esonhugh/claude-code fork 上用重建的 binary 做隔離實測、每週回歸、fake API 腳本化、官方 2.1.303 對照、Agent SDK 相容與 tmux 截圖時使用。
version: 0.1.0
---

# Fork binary 實測（隔離環境 + fake API + 官方對照）

所有修復都要用**本輪重建的 binary** 實測，報告寫明修復前/後行為。單元測試不能代替 binary 實測（帶 builtin Mods 的 binary 會把 settings hooks 走 Mods classic 路徑，單測可能漏掉）。

repo 內已有更嚴格的驗收 skill（`claude-code-feature-validation`、`claude-agent-workflow-validation`、`release-validation`）：做正式發布門禁或 Agent/Workflow 生命週期驗收時改用它們，本 skill 是日常實測的速查。

下文 `/mnt/project-files/` 是 Claude 專案的共享資料夾；不在該環境時，對應腳本需自行準備。

## 1. 建置

```bash
git worktree add --detach ../wt origin/dev   # 或在 agent worktree 內
cd ../wt && bun install --frozen-lockfile    # 必做：node_modules 可能落後 lockfile（sandbox-runtime 曾 0.0.44 vs 0.0.80）
env -u CLAUDE_CODE_VERSION make build        # 產出 ./built-claude（bytecode 編譯）
```

- 官方對照 binary：`make download-claude CLAUDE_VERSION=2.1.303` → `./official-claude`（gitignored）。
- `tsc --noEmit` 需 `NODE_OPTIONS=--max-old-space-size=12000`，否則靜默 OOM；不要和 `make build` 同時跑。
- 只用 `bun`，不用 `npm`。

## 2. 隔離環境（每次都要）

容器會經 `/home/claude/.claude/remote/.oauth_token` 和大量 `CLAUDE_CODE_*` 環境變數洩漏憑證，必須同時：

```bash
unshare -m bash -c 'mount -t tmpfs none /home/claude/.claude/remote && \
  env -i PATH=$PATH HOME=$TMPHOME \
    ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT ANTHROPIC_API_KEY=sk-ant-fake \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    $BIN -p hi --debug-file $OUT/x.debug' </dev/null
```

- 使用者已同意這種隔離（auto classifier 沒批准時會擋；直接在 tmux 外跑 binary 也被擋過）。
- root 下 `--dangerously-skip-permissions` 需 `IS_SANDBOX=1`。bypass 對話框要 Down+Enter。
- 互動模式要預先寫 `$HOME/.claude.json`：`hasCompletedOnboarding`、`customApiKeyResponses.approved` 含假 key、`projects[<cwd>].hasTrustDialogAccepted`，否則卡在 onboarding。範本：`/mnt/project-files/research/probe/pm/claude.json.tpl`。
- 一律 `</dev/null`，開著的 stdin pipe 會讓兩邊 binary 都多等數秒。
- 本地 fake base URL 要算 first-party 時加 `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`。
- 碰 auth 的單元測試也要在 `env -i PATH=... HOME=<tmp>` 下跑；需要 analytics 時設 `NODE_ENV=production`。

## 3. Fake Messages API（不需真模型）

| 檔案（`/mnt/project-files/`） | 用途 |
|---|---|
| `research/probe/pm/fake2.ts`、`agent-sdk/fake3.ts` | 通用。prompt 寫 `DO<<Tool\|{json}>>`，第 k 個 DO 在 k-1 個 tool_result 後送出；auto-mode classifier 回 allow（含 `BLOCKME` 則 block）。env：`FAKE_PORT` `FAKE_LOG` `FAKE_DUMP`（存 req-N.json）`FAKE_CLS=down` |
| `regression/fake-team-api.ts` | Team 生命週期：prompt `LEADER_GO`，teammateMode in-process，`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` |
| `research/probe/sandbox/fake-api.ts` | 首條訊息 `STEPS:[{name,input}]` 腳本化工具呼叫，port 18766 |
| `research/probe/longrun-haiku/` | gen.ts + drive.sh 長跑壓測（RSS 取樣、每 10 輪 /compact） |

殺 fake 時用 `pkill -f "^bun fake3"`；`pkill -f "bun fake3.ts"` 或 `pgrep -f <binary路徑>` 會殺掉自己的 shell（改比對 `/proc/<pid>/exe`）。

## 4. 每週回歸三項

1. **外部 SIGINT → SessionEnd hook 要執行**：設 SessionEnd hook 寫檔，tmux 啟動後從外部 `kill -INT`，確認檔案產生。
2. **`CI=true claude -p` 無憑證要報錯退出不掛起**：`regression/ci-nocred.sh <name> [ENV=..]`（先改腳本內的路徑）分別測網關 token（拒絕的 port）、Bedrock、無憑證。網關約 180 s 重試，官方相同，屬 parity 非掛起。
3. **team shutdown 後成員從 config.json 移除**：用 fake-team-api.ts，debug log 看 `team_mutation_commit mutation="removeTeammate"`，再查 config.json members。

## 5. 官方 2.1.303 對照

- 同一 HOME 範本、同一 fake API、同一 prompt，只換 binary（`./official-claude` vs `./built-claude`）。
- 驗收檔寫到 `/mnt/project-files/research/acceptance/accept-<topic>.md`，證據放 `research/probe/<topic>/`。
- 先查既有研究別重做：`research/feat-mods-vs-official-2.1.303.md`、`research/official-diff/*.md`、`research/fix-checklist.md`。
- 官方 chunk 抽取：`strings -n 6 official-claude` + python 在 marker 附近切片 + `js-beautify`。
- `-p` 下的 "ask" 會變成 permission denial；要分辨 sandbox 本身擋了什麼就用 bypass。

## 6. Agent SDK 相容

- Harness：`research/probe/agent-sdk/`（probe.ts / probe.py；`run.sh <bin> <tag>`、`runpy.sh` 已包 unshare+env -i；`tee-cli.sh` 擷取 SDK 送的 stdin）。
- TS SDK 用 `@anthropic-ai/claude-agent-sdk@0.3.303`（對應 CLI 2.1.303），**裝在 scratch 目錄**，repo node_modules 只有 0.2.92。
- SDK helper（listSessions 等）要在 process.env 設 `CLAUDE_CONFIG_DIR`，只設子行程 HOME 不夠。
- 結果和官方 summary 對比（`results/off.summary.txt`）。

## 7. 啟動耗時

`research/probe/startup-gap/prof.sh <label> <bin> <runs>`：`CLAUDE_CODE_PROFILE_STARTUP=1 --debug-file`，看 `Total startup time`。

## 8. tmux 互動與截圖

- 一律用腳本驅動：`tmux new -d -s S -x 110 -y 36`、`send-keys -l`（字面輸入）、`capture-pane -p -e`（含 ANSI）存檔；記錄 session/pane 與輸出檔絕對路徑。
- 全螢幕模式：`CLAUDE_CODE_NO_FLICKER=1`，160x42。滑鼠點擊用 SGR：`send-keys -l $'\e[<0;X;YM'` 再 `...m`；鍵盤焦點 ctrl+x Tab。
- PNG：ANSI → HTML（每字元 1ch 格）→ Playwright 截圖，放 `docs/features/images/`。
- 輸出看不見時：分割 pane 並排渲染，或用 python pty wrapper 回應 OSC 探測。

## 報告格式

每個項目寫：重現步驟、修復前行為、修復後行為（皆附 binary SHA/版本與證據檔路徑）、官方 2.1.303 行為、未驗證項。
