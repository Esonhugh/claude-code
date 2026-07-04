---
name: claude-debug
description: Use when the user asks to debug Claude Code CLI or runtime behavior, compare official-claude vs built-claude, inspect API requests or traffic, troubleshoot proxy/OAuth/network behavior, run tmux or InteractiveTerminal repros, capture non-interactive --print output, use --debug/--debug-file logs, configure HTTP_PROXY/HTTPS_PROXY, build local traffic-capture proxies for HTTP, HTTP/2, SSE, WebSocket, CONNECT, or upstream proxy debugging, or use local MITM/CCH HTTPS request body inspection with temporary CA artifacts.
version: 0.1.0
---

# Claude Code 调试

使用本技能规划并执行可复现的 Claude Code 调试会话。优先采用真实 CLI 执行和本地产物作为证据，不要基于假设判断。除非用户明确授权披露，否则必须将密钥、OAuth token、cookie、请求体和提取出的二进制内容保留在本地。

## 选择正确工具：assistant-side 与 binary-side

<system-reminder>
**关键工具层规则 — 运行任何测试命令前必须阅读。**

运行任何内容前，先判定你实际在测试哪一层。混淆这两层是无效调试结果的首要原因；这里报告的多数“测试失败”其实是测试跑错了层。

<assistant-side-tools>
**由助手直接调用的工具。** 它们运行在本 agent 的宿主 shell 中，而不是任何 Claude 二进制内部。使用它们来：

- 检查、编辑、搜索项目（`Read`、`Edit`、`Write`、`Grep`、`Glob`）；
- 运行 shell / 构建命令（`Bash`，例如 `make build`）；
- 驱动真实 PTY / REPL / TUI 做本地行为检查（`InteractiveTerminal`）。

`InteractiveTerminal` 是本 agent 用来驱动 `built-claude` / `official-claude` 会话的*传输层*。当你测试 slash command 或 skill 时，它**不是**被测对象。
</assistant-side-tools>

<binary-side-surfaces>
**只存在于正在运行的 Claude 二进制内部的功能。** 不能通过 assistant-side 工具直接调用；必须启动二进制，并把输入提交到它的 stdin。示例：

- slash commands（`/goal`、`/compact`、`/workflows`、`/clear`、`/skills`、`/claude-analysis` 等）；
- 二进制加载的 bundled skills 和 workflows；
- statusline、permission-mode UI、dialog / preview 渲染；
- StopHook、SessionStart-hook、PostToolUse-hook 行为；
- 子二进制*自己的*工具列表（它的 `Bash` / `Read` / `Edit` 与本 agent 的工具属于不同进程表面）。

测试 binary-side 表面时：
1. 启动二进制（通常是用 `InteractiveTerminal` 运行 `./built-claude --dangerously-skip-permissions`；需要 parity 时使用 tmux）。
2. 将 slash command 或 prompt **输入到该二进制的 stdin**。
3. 通过该二进制的 stdout / pane / log file 观察结果。
</binary-side-surfaces>

<invalid-testing-anti-patterns>
- ❌ 通过助手的 `Bash` 工具运行 slash command（例如 `bash -c '/goal foo'`）。`/goal` 由 Claude REPL 解析，不由宿主 shell 解析；`/compact`、`/workflows`、`/skills` 同理。
- ❌ 通过 `Read` 读取 bundled skill 源文件就断言它“可用”。源码存在并不能证明二进制已注册、列出或注入它。应通过运行中二进制的 `/skills` UI 或 debug log 确认。
- ❌ 读取项目文件来“验证” `/goal` 在 compact 后仍保留。必须在二进制会话中实际设置 goal，触发 `/compact`，并检查 compact 后的 transcript。
- ❌ 混淆两层中同名的工具：助手的 `Read` / `Bash` / `Edit` 与子二进制的 `Read` / `Bash` / `Edit` 是不同表面。
</invalid-testing-anti-patterns>

<report-rule>
每条命令和观察都要标注所属层：
- `assistant-side`（例如“`InteractiveTerminal write` into `built-claude` PTY”）；
- `binary-side`（例如“`built-claude` slash command `/goal clear`”）。

这样可以避免审阅者重新运行错误实验。
</report-rule>
</system-reminder>

## 核心流程

1. 定义目标：
   - `official-claude` 用于上游行为。
   - `built-claude` 用于当前项目行为。
   - `bun src/...` 或聚焦单元脚本用于隔离实现检查。
2. 选择调试模式：
   - 交互式终端调试：用于 TUI、prompts、slash commands、workflows 和 streaming UI。
   - 非交互式调试：用于 request/response 行为、print mode、JSON output 或确定性复现。
   - 流量调试：用于 HTTP headers、request body shape、streaming behavior 和 proxy compatibility。
3. 比较二进制时保持配置等价：
   - 使用相同的 `HOME`、`CLAUDE_CONFIG_DIR`、settings、auth state、model env 和 prompt。
   - 只改变二进制路径，或只改变一个明确的 debug variable。
4. 将产物捕获到 `/tmp` 或命名清晰的本地 debug 目录。
5. 报告前脱敏：
   - Authorization headers、cookies、API keys、OAuth tokens、account IDs、organization IDs、完整 private prompts 和完整 request bodies。

## 运行命令前

除非参考文档明确要求，否则从项目根目录运行调试命令。比较结果前，记录 binary paths、working directory、prompt、相关非敏感环境变量和输出产物路径。保持 official/local 配置一致：相同的 `HOME` 或 `CLAUDE_CONFIG_DIR`、相同 auth state、相同 settings、相同 prompt、相同 proxy chain。

对于请求或代理工作，捕获用于比较行为的最小证据：
- 每个二进制的 command line；
- proxy/debug log path；
- request target host 与 status 或 CONNECT outcome；
- 已脱敏 header 是否存在、byte counts 和 exit code；
- 相关时记录 checksum/computed/match facts，但不要打印 secrets 或完整 private bodies。

## 交互式调试

当 terminal 行为重要时使用交互式调试：prompt rendering、tool permission UI、task list display、workflow/deep-research parity、slash commands 或 streaming updates。

优先遵循现有项目指导：
- 如果项目说明要求 parity runs 使用 tmux，则使用 tmux，并记录 session/window/pane names。
- 如果项目记忆或任务上下文偏好 `InteractiveTerminal`，则用 `InteractiveTerminal` 做本地行为检查，除非 parity 要求 tmux。

阅读 `references/interactive-debugging.md` 获取 tmux 和 InteractiveTerminal 配方。

最小交互式证据：
- 启动每个二进制所用命令；
- 影响行为的环境变量，并对 secrets 脱敏；
- 精确 prompt 或 input sequence；
- pane capture path 或 InteractiveTerminal transcript；
- 观察到的差异和 timestamp。

## 非交互式调试

当问题涉及 API request construction、output mode、JSON events、exit codes 或确定性失败时，使用非交互式调试。

常用命令形态：

```sh
./built-claude --print "hello" --dangerously-skip-permissions
./official-claude --print "hello" --dangerously-skip-permissions
```

对于 SDK/JSON 风格检查，优先使用当前二进制支持的显式 output flags，并分别捕获 stdout/stderr。调试时避免改变 auth state。

最小非交互式证据：
- 精确命令和 exit code；
- stdout/stderr byte counts 或脱敏摘录；
- output format flag，以及适用时 JSON-line validation result；
- debug file path 和相关脱敏 log lines。

阅读 `references/non-interactive-debugging.md` 获取可重复命令模板。

## Claude Code debug options

添加自定义 instrumentation 之前，先使用内置 debug flags：

```sh
./built-claude --debug --debug-file /tmp/claude-debug-built.log --print "hello"
./official-claude --debug --debug-file /tmp/claude-debug-official.log --print "hello"
```

如果不确定某个 flag，检查当前二进制 help：

```sh
./built-claude --help
./official-claude --help
```

阅读 `references/debug-options.md` 获取实用 flag 用法、artifact naming 和 redaction checks。

## HTTP 代理流量调试

当验证 request routing、header shape、request body serialization、streaming transport、SSE、WebSocket，或验证是否遵循 `HTTP_PROXY` / `HTTPS_PROXY` 时，使用 proxy-based traffic debugging。

先使用 bundled transparent proxy script：

```sh
node .claude/skills/claude-debug/scripts/http-proxy-debug.mjs --port 8899 --log /tmp/claude-proxy.jsonl
HTTPS_PROXY=http://127.0.0.1:8899 HTTP_PROXY=http://127.0.0.1:8899 ./built-claude --print "hello" --dangerously-skip-permissions
```

代理链示例：

```sh
node .claude/skills/claude-debug/scripts/http-proxy-debug.mjs \
  --port 8899 \
  --upstream http://127.0.0.1:7890 \
  --log /tmp/claude-proxy.jsonl
```

重要限制：标准 `HTTPS_PROXY` 使用 `CONNECT`，因此除非安装受信任的 MITM certificate，否则 HTTPS payloads、HTTP/2 frames、SSE event payloads 和 WebSocket frames 都是加密且不可见的。bundled transparent proxy 支持 HTTPS、HTTP/2、SSE 和 WebSocket 的 tunnel 与 metadata/byte-count observation。

对于经授权的本地 CCH/body inspection，使用 bundled MITM runner。它会创建临时 local CA，让两个二进制都通过 `HTTPS_PROXY` 运行，为子进程清除 `NO_PROXY`，通过 process-local CA environment variables 注入信任，并写入部分脱敏的本地 request summaries。将 output file 和 runner stdout 视为敏感 metadata，不要当作可直接分享的输出：

```sh
node .claude/skills/claude-debug/scripts/run-claude-mitm-cch.mjs \
  --repo . \
  --only both \
  --prompt "hello" \
  --output /tmp/claude-mitm-cch-summary.json
```

将 `--dump-dir`、MITM logs、生成的 CA/leaf private keys、stdout/stderr captures、runner stdout、output summaries 和可选 body artifacts 都视为仅限本地的敏感 captures。Plain HTTP/ws transcripts 和 MITM summaries 可能包含 private request metadata；可选 MITM body files 包含完整 plaintext request bodies。来自 transparent proxy 的 HTTPS/wss CONNECT transcripts 只包含加密 TLS bytes。MITM proxies 必须绑定到 loopback；不要使用 `--host 0.0.0.0`，也不要暴露到不可信接口。不要将生成的 CA 安装到全局。审阅后删除 artifact root 和显式 summary output。除非明确授权且已脱敏，否则不要提交、上传或粘贴这些产物。

最小代理证据：
- proxy command、port、upstream proxy 和 log path；
- 传给目标进程的 proxy env；
- CONNECT targets 或 absolute-form HTTP targets；
- plain HTTP 的 response statuses，以及 tunnels 的 byte counts；
- 已脱敏 header names/value presence，绝不包含 raw credentials；
- 明确需要 packet-like exchange inspection 时，使用 `--dump-dir <dir>` 并报告本地 transcript path，而不是粘贴敏感内容。

阅读 `references/proxy-debugging.md` 获取 transport details、upstream proxy behavior、script limits 和安全报告格式。

## 报告格式

使用以下紧凑格式报告发现：

```markdown
## 范围
- Target:
- Mode: interactive | non-interactive | proxy
- Binaries/config compared:

## 证据
- Commands:
- Artifacts:
- Redactions:

## 发现
1. ...

## 限制
- ...
```

## 其他资源

- `references/interactive-debugging.md` — tmux 与 InteractiveTerminal 工作流。
- `references/non-interactive-debugging.md` — print-mode、JSON、exit-code 和可复现 CLI 检查。
- `references/debug-options.md` — Claude Code debug flags 与 debug-file 处理。
- `references/proxy-debugging.md` — HTTP_PROXY/HTTPS_PROXY、CONNECT、HTTP/2、SSE、WebSocket、upstream proxy chains。
- `scripts/http-proxy-debug.mjs` — 支持 metadata logging 和 upstream proxy 的本地 transparent proxy。
- `scripts/run-claude-mitm-cch.mjs` — 从 `built-claude` 和 `official-claude` 生成脱敏 request/body/CCH summaries 的本地 MITM runner。
- `scripts/mitm-cch-debug.mjs` — runner 使用的低层 MITM proxy。
