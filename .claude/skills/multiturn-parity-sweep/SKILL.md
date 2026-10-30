---
name: multiturn-parity-sweep
description: 在 fork 上做一輪多輪對話 / 長對話 / 權限切換 / Mods / slash / resume-cache / 真模型 token 的 dev vs 官方對照掃描時使用：一輪找出盡可能多的 bug，再統一修復、統一驗證。含 tmux 驅動腳本、fake API、請求前綴比對與 token/cache 統計。
version: 0.1.0
---

# 多輪對話官方對照掃描（一輪找全 bug）

用於「多輪對話 / 長對話 / 交互式觸發 AI、Agent、Workflow、Mods / 比 UI、SDK、內部流程差異 / 統計命中率 / 出測試報告和發版建議」這類請求。

**使用者規則：一輪測試盡可能多地找 bug，然後統一修復。**不要改一點就重跑整輪，因為重跑很費 token。所有證據（請求 dump、hook log、pane、SDK probe、binary 解碼）都要先挖完，再開一個 issue 和一個 PR（commit 按領域拆分），最後只做一次重建驗證。

腳本在 `scripts/`。跑之前先複製到 scratchpad，因為驅動會把 `out/` 寫在腳本旁邊：

```bash
cp -r .claude/skills/multiturn-parity-sweep/scripts $SCRATCH/mt && cd $SCRATCH/mt
```

隔離環境、fake API 的通用規則和 SDK harness 見 `fork-binary-testing`。

## 1. 準備 binary

```bash
bun install --frozen-lockfile
CLAUDE_CODE_VERSION=$(sed -n 's/^VERSION := //p' Makefile) bun package:binary
cp dist/release/claude-code-v*-linux-x64 $SCRATCH/bin/fix   # 注意：built-claude 不會被這條命令更新
make download-claude CLAUDE_VERSION=<官方版本>               # ./official-claude → $SCRATCH/bin/off
```

- 每個併發驅動用**不同的 binary 拷貝**（`cp fix r4a; cp fix r4b ...`）。`ldrive.py` 的 `rss()` 會把同一路徑的所有行程加總，共用 binary 時 RSS 會虛高 2–3 倍。
- 每個併發驅動用不同的 `--port`。
- 驅動在 tmux 裡 `cd` 到工作目錄，所以 binary 路徑要用絕對路徑。

## 2. 腳本

| 腳本 | 內容 | 用法 |
|---|---|---|
| `ldrive.py` + `fake3.ts` | 55 步長對話：工具、子 agent、背景任務、team、workflow、skill、/model、/clear、/exit、--continue、--resume；附 RSS 取樣 | `ROUNDS=3 python3 ldrive.py <bin> <label> --port N`；`lreps.sh <bin> <tag> <n> <port>` 跑 n 次 |
| `drive.py` + `fake-mt.ts` | 37 步多輪 + Mods（`--mod` 載入 `hello-mod/`）；`DUMP=1` 存請求 | `python3 drive.py <bin> <label> --mod --port N` |
| `pdrive.py` + `pfake.ts` | 36 步權限模式切換（default/acceptEdits/plan/auto/bypass，shift+tab，規則） | `python3 pdrive.py <bin> <label> --port N`；`preps.sh` 重複跑 |
| `rdrive.py` | 真模型 13 步自然語言（命中率 hit = 選對工具，ok = 結果正確），含 /compact 與 --continue；使用容器自帶 OAuth，binary 自己找憑證，不要讀或印 token | `python3 rdrive.py <bin> <label> --model claude-sonnet-5-5`；`rreps.sh <bin> <tag> <from> <to>` |
| `sdrive.py` | slash 命令逐一打開、截 pane、Esc 退出 | `CMDS=/a,/b python3 sdrive.py <bin> <label> <port>` |
| `t4.py` / `ta.py` | 定點複查（未知命令、`!` 命令、typeahead 預選） | `T4CMDS=/x,/y python3 t4.py <bin> <label> <port>` |
| `cdrive.py` + `cmp.py` | resume 後 cache 前綴比對：兩輪 → /compact → 一輪 → /exit → --continue → 一輪；`NOCOMPACT=1` 跳過 compact；`PRE=EDIT_GO,SKILL_GO,FGQ,HELLO` 在 compact 前改檔案、用 skill 和 agent（覆蓋 git status 變動）；`TS=true` 開 tool search | `python3 cdrive.py <bin> <label> --port N && python3 -I cmp.py out/<label>` |
| `pcont.sh` | headless `-p` → `-p --continue` 的同樣比對 | `bash pcont.sh <bin> <label> <port> && python3 -I cmp.py out/<label>` |
| `usage.py` | 真模型 transcript 的 token/cache 統計（按 message id 去重，含子 agent） | `python3 -I usage.py rout/<label> ...` |

每個驅動最後一行會印 `pass X/Y` 和 hook 計數，詳細結果在 `out/<label>/result.json`。

## 3. 一輪的步驟

1. **fake 套件，dev 與官方各跑 ×3–5**：`ldrive`、`drive --mod`、`pdrive`。比較 pass 數、hook 計數（Stop/UPS/SubagentStop 等）、RSS 和 pane 錯誤。
2. **真模型，各 ×2–3**：`rdrive`。統計 hit/ok 命中率，再用 `usage.py` 算 token 和 cache。
3. **slash 掃描**：`sdrive`，dev 與官方的 pane 逐個 diff（措辭、未知命令、對話框）。
4. **請求 dump 比對**：在 `FAKE_DUMP` 的 `req-N.json` 上比較 `max_tokens`、`thinking`、`output_config`、`context_management`、system 區塊、工具集合、hook 輸入欄位（hooks.log）。
5. **resume/cache**：`cdrive`（有 compact 和 `NOCOMPACT=1` 兩種）加 `pcont`。`cmp.py` 必須顯示 `system same: True`，且 messages 前綴是 SAME。只有尾部 string/text-block 的形態差異和官方一致，可以接受。
6. **SDK probe**：用 `fork-binary-testing` §6 的 harness，對比 init 欄位和訊息類型。
7. **官方行為解碼**：`grep -a -o '.\{400\}<marker>.\{400\}' official-claude`，找函式後對照 dev 原始碼。
8. **彙總**：所有差異寫進一個 issue（分節、附官方解碼證據），再判斷哪些是 bug，哪些是使用者決定過的刻意差異（見專案記憶）。
9. **統一修復**：每個 bug 先寫最小失敗測試。一個 PR 指向 dev，commit 按領域拆分。
10. **一次驗證**：重建 → 定點複查（t4/cdrive/pcont）→ fake 三件套回歸 → 視需要再跑一次真模型 → 相關 `bun test`、`tsc`。

## 4. token / cache 判讀

- 加權成本 = input + cache 寫入 ×2（1h TTL）+ cache 讀取 ×0.1 + 輸出 ×5。
- 命中率 = cache 讀取 /（input + 寫入 + 讀取）。dev 和官方應該都在 88–92%。
- 主 session 裡某個請求的 cache 讀取比前一請求的前綴少一半以上，就算一次 break。/compact 本身會造成一次，屬正常。resume 之後不應再有 break。
- resume 後如果只有 `tools` 長度的 cache 讀取（約 10k），通常是 system 區塊 0 的 billing header 指紋變了。指紋取自第一條 user 文字，所以 messages[0] 必須和恢復前一致。

## 5. 報告

- 用 Claude Doc 寫報告，證據打成 tgz 放共享目錄（共享目錄有 5 萬檔上限）。打包前排除 home/work 目錄，並確認裡面沒有 token。
- 報告包含：
  - 命中率表：fake 各套件 pass 數、真模型 hit/ok。
  - hook 計數對照。
  - token/cache 表。
  - bug 列表（重現、根因、官方行為、修復 PR）。
  - 刻意差異。
  - 發版建議：CHANGELOG、`make release-check`、release PR、tag 由使用者推。

## 常見坑

- slash 掃描裡如果 `/vim` 這類切換模式的命令還存在，會污染後面所有步驟。把它放到最後，或從 `CMDS` 排除。
- `pkill -f "bun fake3.ts"` 會連自己的 shell 一起殺掉。腳本已用 `setsid` / `killpg` 處理。
- `make build` / `bun package:binary` 的產物在 `dist/release/`。拿舊的 `built-claude` 測試會讓修復看起來沒生效。
- `tsc` 需要 `NODE_OPTIONS=--max-old-space-size=8192`，否則 OOM。
- `git push -f` 會被 auto 模式擋。分支在上一個 PR 合併後已是 dev 的祖先，用普通 push 即可。
