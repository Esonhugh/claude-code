# Code Mode（实验性）

<!-- lang: zh-Hans -->

> 英文名：`code-mode` · 领域：工具 · [返回功能索引](README.md)

## 这是什么

平时 Claude 每做一步都要发一次工具调用：读一个文件、搜一次、跑一条命令，各算一轮。步骤一多，来回的轮数和 token 都会涨。

打开 Code Mode 后，Claude 手里只有一个 `REPL` 工具。它在 `REPL` 里写一小段 JavaScript，用 `await Read(...)`、`await Grep(...)`、`await Bash(...)` 一次做完几步，再把整理好的结果带回对话。**脚本里的每次工具调用仍然和平时一样做校验、跑 hook、按权限规则确认**，Code Mode 只改变调用方式，不放宽权限。

行为和文案对照官方 2.1.325 的 Code Mode 实现，不同之处见文末[与官方的差异](#与官方的差异)。

<details lang="en"><summary>English</summary>

> Name: `code-mode` · Area: Tools · [Back to index](README.md)

## What it is

Normally Claude makes one tool call per step: read a file, run a search, run a command, one round each. Many steps mean many round trips and more tokens.

With Code Mode on, Claude has a single `REPL` tool. It writes a short JavaScript script inside `REPL` that calls `await Read(...)`, `await Grep(...)`, `await Bash(...)` and so on, does several steps at once, and brings a tidy result back to the conversation. **Every tool call inside the script is still validated, still runs your hooks and still goes through your permission rules**; Code Mode changes how tools are called, not what is allowed.

Behaviour and wording follow the official 2.1.325 Code Mode; the differences are listed under "与官方的差异" at the end.

</details>
<details lang="zh-Hant"><summary>繁體中文</summary>

> 英文名：`code-mode` · 領域：工具 · [返回功能索引](README.md)

## 這是什麼

平時 Claude 每做一步都要發一次工具呼叫：讀一個檔案、搜一次、跑一條命令，各算一輪。步驟一多，來回的輪數和 token 都會漲。

打開 Code Mode 後，Claude 手裡只有一個 `REPL` 工具。它在 `REPL` 裡寫一小段 JavaScript，用 `await Read(...)`、`await Grep(...)`、`await Bash(...)` 一次做完幾步，再把整理好的結果帶回對話。**腳本裡的每次工具呼叫仍然和平時一樣做校驗、跑 hook、按權限規則確認**，Code Mode 只改變呼叫方式，不放寬權限。

行為和文案對照官方 2.1.325 的 Code Mode 實作，不同之處見文末「与官方的差异」。

</details>

## 打开和关闭

Code Mode 只有一个开关：启动 `claude` 时设环境变量 `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1`。

```bash
CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 claude
```

开关在启动时决定一次，整个进程不变；要关掉就不设这个变量重新启动。没有 settings 项，也没有 `/config` 开关。用 API key、自定义 `ANTHROPIC_BASE_URL` 时同样可以打开。

启动时输入框上方会出现一行提示：

| 情况 | 提示 | 结果 |
| --- | --- | --- |
| `=1`，可以开启 | `⚠ Code Mode (experimental) is on · this session can be resumed only with Code Mode on` | Code Mode 开启 |
| 设成 `1` 以外的值（如 `=2`） | `⚠ Code Mode (experimental) isn't available: CLAUDE_CODE_EXPERIMENTAL_CODE_MODE must be 1 to turn it on. Starting with the ordinary tools.` | 普通工具 |
| 后台会话、teammate 窗格、Remote Control | `⚠ Code Mode (experimental) isn't available: for now it doesn't work in background jobs, in teammates' panes or with Remote Control. Starting with the ordinary tools.` | 普通工具 |
| `-p`、SDK、IDE 插件等非交互入口 | 不显示提示，只写 debug 日志 | 普通工具 |

## 快速上手

下面的画面来自 `./built-claude` 在 110×36 的 tmux pane 中的实际运行（节选，省略了启动横幅），模型回复由测试用假 API 按脚本生成。

**1. 一段脚本做完几步。** 问「统计一下 src 里有多少 TODO」，Claude 写的脚本先 `Grep` 再 `Glob`，两次调用合在一个 `REPL` 里完成。界面上不显示 `REPL` 本身，只显示脚本里的调用：

```text
 ⚠ Code Mode (experimental) is on · this session can be resumed only with Code Mode on

❯ 统计一下 src 里有多少 TODO

  Searched for 2 patterns (ctrl+o to expand)

⏺ src 下共有 3 处 TODO：app.ts 2 处，util.ts 1 处（扫描了 3 个文件）。
```

这一轮模型实际发出的脚本：

```js
const hits = await Grep({pattern: 'TODO', path: 'src', output_mode: 'count'})
const files = await Glob({pattern: 'src/**/*.ts'})
hits.content + `\n(${files.numFiles} files scanned)`
```

**2. 变量在调用之间保留。** 脚本里用 `var` 或 `globalThis` 存下的值，下一次 `REPL` 还在，Claude 不用重新读一遍：

```text
❯ 计数一下项目里的 ts 文件，记下来

  Searched for 1 pattern (ctrl+o to expand)

⏺ 记下了 3 个 .ts 文件，存在变量 seen 里。

❯ 接着用刚才记下的列表

⏺ 上一步记下的文件是 app.ts、log.ts、util.ts。
```

第二轮的脚本只有一行 `seen.map(f => f.split('/').pop()).join(', ')`，没有再调用工具。

**3. 权限确认照常弹出。** 在 default 模式下，脚本里的 `Bash` 和直接调用时一样要你批准，确认框显示的是脚本里那条命令：

```text
❯ 跑一下测试

──────────────────────────────────────────────────────────────────────
 Tool use

   Bash(npm test --silent)
   Run the test suite

 This command requires approval

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for Bash commands in /private/tmp/cmx/docdemo/run/doc/h/sc
   3. No
```

选 `Yes` 后脚本继续执行；选 `No` 时脚本停下，Claude 收到一份说明哪次调用被拒绝的报告，不会在你不知情时继续往下跑。

```text
⏺ Bash(npm test --silent)
  ⎿  3 passed

⏺ 测试通过：3 passed。
```

**4. 慢任务转到后台。** 会话以 `auto` 或 `bypassPermissions` 模式启动时，脚本跑满 30 秒还没结束就转到后台（官方是每个脚本都立即转后台，见[与官方的差异](#与官方的差异)），Claude 收到回执 `(dispatched #1)`，这一轮先结束，你可以继续说话。脚本结束后结果作为事件送回，Claude 自动开始下一轮：

```text
❯ 跑一下慢的构建

⏺ 构建超过 30 秒，已转到后台（#1）。完成后我会收到通知，你可以先做别的。

✻ Cogitated for 30s · done 1:22 PM

❯ <event kind="repl-eval" at="2026-11-16T05:22:30.090Z" eval="1" ms="35045" status="settled">
<result>build ok</result>
</event>

⏺ 后台构建完成：build ok。
```

## 脚本里能用什么

| 名字 | 作用 |
| --- | --- |
| `Read`、`Glob`、`Grep`、`Bash`、`Write`、`Edit`、`NotebookEdit`（Windows 上还有 `PowerShell`） | 和同名工具相同的输入和结果，用 `await` 调用 |
| 会话里的其他工具（`Agent`、`WebFetch`、MCP 工具等） | 同样用 `await 工具名({...})` 调用；它们只是不再直接发给模型 |
| `` $`命令` `` | 跑一条 shell 命令，返回退出码和输出，是 `Bash` 的简写 |
| `file(path)`、`write(path, content)`、`edit(path, old, new)` | 读、写、改文件的便捷写法，底层仍是 `Read`、`Write`、`Edit` |
| `sleep(ms)` | 在脚本里等待 |
| `describeTool(name)`、`searchTools(query)` | 查看工具的输入说明；按关键词找 MCP 工具和其他不在列表里的工具 |

MCP 工具不在 Claude 的工具列表里：系统提示列出已连接的 MCP 服务器（最多 40 个），Claude 用 `searchTools` 找到工具后在脚本里调用。

## 时间限制、Esc 和后台执行

- **脚本时间**：一次 `REPL` 默认最多跑 30 秒脚本自身的时间，Claude 可以用 `timeout` 放宽到 600 秒。等待工具调用（例如一条慢命令、一个权限确认框）的时间不算在内。超时后脚本停下，Claude 收到超时说明。
- **Esc**：回合中按 `Esc` 会停掉正在跑的脚本，Claude 收到一份「用户中断」的报告，里面写明停下时还在跑哪些调用。
- **后台执行**只在会话以 `auto` 或 `bypassPermissions` 模式**启动**时提供。这时 Claude 多一个 `Poll` 工具，系统提示开头写成 `Your two tools are REPL and Poll`：
  - 脚本跑满 30 秒还没结束，就转到后台，返回 `(dispatched #N)`；
  - 结果以 `<event kind="repl-eval">` 事件送回：Claude 空闲时自动开始新一轮，回合中调用 `Poll` 时作为 `Poll` 的结果返回；
  - 回合之间按 `Esc` 也会停掉已转到后台的脚本，Claude 同样收到「用户中断」报告；
  - 同时最多挂 8 个未结束的后台脚本，每个最长 2 小时；
  - 会话中途切换权限模式只影响之后的新脚本是否转后台。以其他模式启动的会话没有 `Poll`，之后切到 `auto` 也不会出现。

## 权限与 hook

- 脚本里的每次调用都按调用的那个工具判定权限：`Bash(npm test:*)` 这样的 allow / ask / deny 规则照常生效；整个工具被 deny 时，脚本里也调不到它。
- PreToolUse / PostToolUse hook 看到的 `tool_name`、`tool_input` 是脚本里调用的工具（如 `Bash`），已有的 matcher 不用改；hook 修改输入、拦截调用、改写输出都对脚本生效。
- [自动模式](auto-mode.md)下，分类器在调用 `REPL` 时审一次整段脚本，脚本里的每次调用仍然逐次走权限判定。
- [Mods](mods.md) 的 `tool.call` hook 对脚本里的调用照常触发。

## 子代理、压缩和恢复会话

- **子代理**：定义里写了 `Read`、`Bash` 等工具的子代理同样拿到 `REPL`，脚本里只能调用定义允许的那些工具。子代理没有 `Poll`，调用时会被告知用现有工具完成任务后把结果交回。
- **Agent Teams 的 teammate** 使用普通工具，不进入 Code Mode。
- **`/compact`**：压缩后脚本里的变量还在，摘要会告诉 Claude 哪些变量仍可直接使用。
- **恢复会话**：Code Mode 会话要在打开开关时 `--resume` 才继续用 Code Mode。新进程里上一次的脚本变量已经不在，Claude 会收到提示。上一个进程退出时还在后台跑的脚本，会以 `<event kind="repl-eval" … status="lost">eval #N never settled: …</event>` 事件告诉 Claude 结果已丢失（不设开关恢复时，同样的文字放在提醒里）。
- 不设开关恢复 Code Mode 会话时，会话改用普通工具继续，界面显示 `This session was started in Code Mode (experimental), which isn't available where it runs now. It continues with the ordinary tools and stays out of Code Mode from now on.`

## 与官方的差异

| 方面 | 官方 2.1.325 | 本 fork |
| --- | --- | --- |
| 怎么打开 | 远程 feature gate、确认对话框，同意后重启；只支持 Anthropic 官方 API 和 Opus / Sonnet 5.5 及以上 | 只看环境变量；API key、自定义 `ANTHROPIC_BASE_URL` 都能开；不限模型 |
| 有 `Poll` 时脚本怎么跑 | 每个脚本立即返回 `(dispatched #N)`，结果由 harness 附在一个 `Poll` 结果里送回；脚本里有 `running()` 可查看和停掉未结束的脚本 | 30 秒内结束的脚本直接作为 `REPL` 的结果返回，超过 30 秒才转后台；没有 `running()`。正在按官方方式移植 |
| 恢复时上次没结束的后台脚本 | `status="lost"` 事件不会唤醒 Claude，界面显示一行 `Lost: Claude Code exited before this finished` | 事件会唤醒 Claude 开始一轮；界面没有这一行 |
| 超时或 `Esc` 之后 | 脚本里的变量保留 | 脚本运行环境重建，之前的变量丢失，Claude 下一次调用时会收到「新环境」的提示 |
| 不设开关恢复 Code Mode 会话 | 交互界面拒绝恢复 | 改用普通工具继续，并提示 Claude 和你 |
| 开关打开时恢复普通会话 | 这个会话继续用普通工具 | 整个进程都是 Code Mode，恢复的会话也用 `REPL` |
| 装了带 `tool.call` hook 的 mod | 拒绝开启 Code Mode | 照常开启，hook 照常触发 |
| `REPL` 系统提示里的 skill 列表 | 有 | 没有 |

还没做的部分（计划中的 Phase 5）：

- `auto` 模式下开启前的确认对话框，说明分类器只审一次整段脚本；
- 界面上把 `REPL` 工具显示为 `Code`；
- 后台脚本的进度视图和任务栏条目，目前只能等结果事件；
- 使用非 Anthropic provider 时的启动提示。

## 说明

- 画面来自实际运行（110×36），模型回复由测试用假 API 按脚本生成，不代表真实模型的输出。
- 实施计划和设计决策见 [`docs/plan/code-mode.md`](../plan/code-mode.md)；和官方逐项对照的结果见 [`docs/research/code-mode-conformance-20261116.md`](../research/code-mode-conformance-20261116.md)。
- 这是实验性功能，行为跟随官方版本调整。
