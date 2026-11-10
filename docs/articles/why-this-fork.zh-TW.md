# 一個 CLI，兩種帳號：Esonhugh/claude-code 介紹與上手

> English version: [why-this-fork.en.md](why-this-fork.en.md)

`@esonhugh/claude-code` 是一個非官方的 Claude Code 分支。它保留 Claude Code 原有的全部能力（工具、權限、Hooks、MCP、Skills、子代理、Workflow），再加上一批官方沒有的東西：用 ChatGPT 帳號跑 OpenAI 模型、瀏覽器介面 `claude web`、可以改造 Claude 本身的 Mods、真正組隊的 Agent Teams，以及更短的系統提示。

> 本專案不是 Anthropic 官方產品，也未獲 Anthropic 背書。公開套件只分發 launcher 與各平台二進位檔，不含原始碼。

## 為什麼值得試

**一套工具，兩邊帳號。** 同一個 `claude`，可以用 Claude 帳號，也可以用 ChatGPT 帳號（OAuth、device code 或 API key）跑 GPT / Codex 模型。工具、介面、斜線命令照常使用；在 OpenAI 路徑上還多了 Codex 式的 `apply_patch`、ChatGPT 裡連好的 Codex Apps，以及 `/daybreak` 網路安全檔位。

**用得更省，快取不掉。** 在同一批真實任務上（辦公、研究、編碼、維運、Lean 證明，共 654 次 run），Claude 帳號的快取命中率 87.1%，官方 87.3%，基本持平；每個任務的總 token 72.7k，官方 81.0k，少 10%。TUI 多輪互動 6 輪下來官方用了 640k token，本分支 235k。主請求的提示內容 37.6k 字元，官方 46.6k。

**瀏覽器裡的 Claude Code。** `claude web` 在本機起一個網頁介面，背後跑的還是本機的 claude：公式、Mermaid、程式碼和 diff 以網頁呈現；可以上傳並預覽 PDF / Office 文件，直接在圖片、程式碼、PDF 上留評論；回合中途插話或立刻打斷；回退到任一則訊息之前（可連檔案一起還原）；右側面板看狀態、agent、終端、workflow 看板和 Mods。

**可以改造 Claude 本身。** Mods 讓你用一個 JS/TS 檔加命令、攔截或改寫工具呼叫、在介面上加狀態條和側邊面板，終端和網頁都會顯示。

**能長時間自己做事。** Agent Teams、Dynamic Workflow、`/goal`、Monitor、定時任務、互動式 Terminal 工具、背景會話，讓 Claude 能分工、並行、持續做到目標達成。

**預設尊重隱私。** 預設不向 Anthropic 傳送遙測資料，`/feedback` 也隨之隱藏；專案設定無法替你打開遙測。

## 安裝

```bash
bun add --global @esonhugh/claude-code
claude --version
```

提供 Linux x64、Linux arm64、macOS arm64、Windows x64 的二進位檔。也可以從原始碼建置：

```bash
git clone https://github.com/Esonhugh/claude-code
cd claude-code
bun install
make build
./built-claude --version
```

## 登入：Claude 或 ChatGPT

Claude 帳號照舊：

```bash
claude        # 第一次啟動後輸入 /login
```

ChatGPT 帳號（或 OpenAI API key）：

```bash
CLAUDE_CODE_USE_OPENAI=1 claude
# 輸入 /login，選 Sign in with OAuth（有瀏覽器）或 Sign in with device code（SSH、無介面機器）
```

```bash
# 不登入，直接用 API key 或相容網關
CLAUDE_CODE_USE_OPENAI=1 OPENAI_API_KEY=<your-api-key> claude
CLAUDE_CODE_USE_OPENAI=1 OPENAI_BASE_URL=https://gateway.example/api OPENAI_API_KEY=<key> claude
```

用 ChatGPT 帳號時，預設模型和上下文窗口跟著帳號的模型目錄走；`/model` 列出帳號可用的模型。Provider 在啟動時決定；在 `claude web` 裡則可以從左下角帳號選單的「認證」切換 Anthropic OAuth、OpenAI OAuth 與兩種 API key。

## 瀏覽器介面：`claude web`

```bash
claude web                 # 只監聽本機，自動開瀏覽器
claude web --no-open       # SSH 裡只印出網址
```

網址裡的一次性 token 換成 cookie 後就從網址列移除；預設只監聽本機，要給區網用必須明確加 `--dangerously-allow-local-network`。

**專案模式**：左側欄「專案」旁點 `+`，填名稱、工作目錄和專案說明。之後在專案裡說要做什麼，協調者會把工作拆成任務，派給多個 worker 並行；右側看每個任務的過程、批准命令、發訊息、停止或審閱。專案與任務存在本機 SQLite，重啟後能接著聊。

## Agent Teams：真正的隊友

```bash
claude --agent-teams
# 或 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude
```

開啟後，請 Claude「組一個三人團隊，一人寫實作、一人寫測試、一人寫文件，並幫隊友取名字」。每個隊友都是完整的 Claude 會話，持續在線、互相 `SendMessage`、共用一份任務清單；你可以切過去看任何一個隊友在做什麼。在 `-p` 模式下隊友在同一個行程裡跑，負責人送出關閉請求後，隊友 15 秒沒有動靜會被強制停止，程式正常退出。

## Mods：五分鐘寫一個

```text
hello-mod/
├── .claude-plugin/plugin.json   { "name": "hello-mod", "version": "0.1.0" }
└── hooks/
    ├── hooks.json               { "modules": ["./register.ts"] }
    └── register.ts              註冊 /hello 命令與工具攔截
```

```bash
claude plugin validate ./hello-mod   # 靜態掃描，不執行程式碼
claude --plugin-dir ./hello-mod      # 載入後輸入 /hello
claude plugin test ./hello-mod       # 跑 Mod 自己的測試
```

倉庫附的範例：Token Weather 在輸入框上方顯示上下文用量狀態條；Blast Radius 在 Claude 要跑危險命令前先讓你看後果。Mod 在本機以高權限執行，只載入你信任的外掛。

## 上下文窗口檔位與記憶

```text
/context                  看系統提示、工具、對話各佔多少
/context-window 200k      把這個模型的壓縮窗口設為 200k（別名 /autocompact）
/context-window auto      回到建議值
```

檔位有 `auto`、128k、200k、272k、500k、1M（小於模型上限的那些），每個模型各自保存；`claude web` 的模型選單也有「上下文窗口」一列。想保留最近一段原文、只壓縮更早的內容，可以在設定裡寫 `"compact": {"mode": "codex"}`。

記憶多了以後可以改成 SQLite FTS5 全文檢索，按需查詢而不是每次全部帶上：

```json
{ "memory": { "sqlite": { "enabled": true } } }
```

## 其他值得一提

- **Channels**：讓 Telegram、Discord 或自己寫的 MCP server 把訊息推進正在執行的會話，還能在手機上遠端批准工具呼叫。
- **`/goal all tests pass`**：每輪結束自動檢查條件，沒達成就繼續。
- **Terminal 工具**：給 Claude 一個能持續互動的終端，可以開 REPL、操作 TUI、按 Ctrl+C。
- **`claude ssh 主機`**：在遠端 Linux 上讀寫檔案、跑命令，介面與權限確認留在本機，API 憑證不離開本機。
- **官方 Agent SDK 和 VS Code 外掛**可以直接改用本分支執行。

完整功能清單見 [功能文件索引](../features/README.md)（也同步到 GitHub Wiki）。

## 基準數據

數據採集於 2026-11-07，654 次真實模型請求，每格至少 3 次；命中率 = 快取讀取 ÷ 全部輸入，按 token 加權。

| 指標 | 本分支 · Claude | 官方 Claude Code | 本分支 · ChatGPT | Codex CLI | opencode | pi |
| --- | --- | --- | --- | --- | --- | --- |
| 快取命中率 | 87.1% | 87.3% | 85.3% | 88.8% | 89.2% | 84.0% |
| 平均總 token / 任務 | 72.7k | 81.0k | 75.9k | 80.3k | 81.5k | 36.5k |
| API 等價花費 / 任務 | $0.078 | $0.088 | $0.050 | $0.047 | $0.059 | $0.041 |
| TUI 6 輪總 token | 235k | 640k | 310k | 267k | 170k | 80k |
| `-p` 啟動到首個請求 | 0.82s | 0.89s | 0.71s | 2.59s | 2.81s | 0.83s |
| 任務成功 | 33/33 | 33/33 | 33/33 | 33/33 | 33/33 | 33/33 |

- Claude 側與官方命中率持平，token 少 10%，花費少 11%。
- 3 個 subagent 時本分支是單代理的 2.8 倍，官方 3.7 倍。
- ssh 與 Kubernetes 真實環境排障：10 個 CLI × 4 題 × 3 次全數通過；Claude 側本分支 89.9%、官方 90.0%，token 少 4%；ChatGPT 側本分支 79.5%、Codex 90.0%，但 token 少 40%。
- pi 的提示只有 2.7k，token 最少，但沒有子代理等功能；pi 與 opencode 在 Claude 側只寫 5 分鐘快取，閒置 15 分鐘以上首個請求只剩 0–27%，本分支與官方寫 1 小時快取。

測試設計、圖表、多代理、長時間閒置、oh-my-pi 與 dsh 的完整數據見 [快取命中與使用者體驗基準](../features/cache-benchmark.md)（[Wiki](https://github.com/Esonhugh/claude-code/wiki/Cache-Benchmark)）。

## 誠實的限制

- **非官方。** 原始碼是從 Claude Code 分發產物恢復的，未經 Anthropic 背書；用於生產前請自行審查安全、更新與權限。
- **ChatGPT 側短任務不如 Codex。** 短任務命中率 82.9% 對 89.7%，長任務 86.5% 對 88.3%。原因是 Codex 的系統提示在伺服器端，新會話第一個請求未快取的部分更少，這在客戶端無法消除。
- **閒置後的新會話。** 官方的靜態前綴由全球使用者共享、一直是熱的，閒置後開新會話的首個請求官方 67% 命中，本分支 0%。
- **Teams 很耗 token。** 3 人團隊在 Claude 帳號是單代理的 6.0 倍、ChatGPT 帳號 8.5 倍，因為每個隊友都是帶完整系統提示的會話。功能預設關閉，適合真的需要長時間協作的任務。
- **ChatGPT 側偶有中途整段失效**：2.7% 的請求（Claude 側 0%）。
- **Mods 仍在對齊官方。** 部分 Worker 復原與瀏覽器 Client 生命週期項目尚未驗收完畢，詳見 [Mods 文件](../features/mods.md)。
- **平台。** macOS x64 沒有二進位檔。
- 基準題組對成功率沒有區分度（幾乎全部 100%），差別主要體現在 token、用時與穩定性。

## 連結

- 倉庫：https://github.com/Esonhugh/claude-code
- npm：`@esonhugh/claude-code`
- 變更紀錄：[CHANGELOG.md](../../CHANGELOG.md)
- 功能文件：[docs/features](../features/README.md)
