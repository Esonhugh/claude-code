# 交互式终端调试

## 范围

当静态源码分析不足，任务需要真实 CLI 交互证据时使用本指南：prompt、按键处理、workflow UI、任务列表行为、footer/status 变化、agent orchestration display，或 official/local parity checks。

在本仓库中，轻量本地交互检查优先使用 `InteractiveTerminal`，除非任务明确需要 tmux parity evidence。比较官方 Claude CLI 与本项目、需要长期可复现 terminal capture，或用户明确要求 tmux 时，使用 tmux。

## 何时使用 InteractiveTerminal

用于快速行为检查：

- 为 `./built-claude --dangerously-skip-permissions` 或其他本地命令打开 PTY-backed session。
- 在当前工具上下文中写入 prompts 并发送按键。
- 每次交互后读取 visible terminal snapshot。
- 根据验证需要 resize、signal 或 close session。

推荐流程：

1. 在 `{PROJECT_ROOT}` 中用目标命令打开 session。
2. 读取 initial screen。
3. 写入精确输入，或发送 `ENTER`、`ESC`、`UP`、`DOWN`、`CTRL_C` 等 key events。
4. 每个有意义的状态转换后读取 screen。
5. 在报告中记录 command、session id、input sequence 和关键 visible output。
6. 完成后关闭 session。

该方式适合产品行为检查；但除非同一场景也跑过官方 CLI，或已采集 tmux evidence，否则不要声称完成 official parity。

## 何时使用 tmux

用于 official/local parity、workflow/deep-research 调查，以及更长的可复现交互 traces。

核心要求：

- 使用命令或脚本驱动 tmux，不做无记录的手工交互。
- 使用 `tmux send-keys` 发送输入。
- 使用 `tmux capture-pane` 采集证据。
- parity 场景中同时 capture official 和 local panes。
- 将 pane captures 保存到绝对路径。
- 静态源码阅读只能作为解释证据，不能替代 runtime evidence。

## 标准 tmux parity 设置

使用带时间戳和 side label 的清晰 session/window 名称。

官方 CLI 命令：

```bash
./official-claude --dangerously-skip-permissions --debug-file /tmp/official-claude.debug-log
```

本地 CLI 命令：

```bash
./built-claude --dangerously-skip-permissions --debug-file /tmp/built-claude.debug-log
```

如果具体任务的项目说明要求先 fresh build，则在启动本地 parity 前运行指定 build command。本仓库不要使用 `npm`；使用项目认可的 `bun` 或 `make` 命令。

示例结构：

```bash
tmux new-session -d -s claude-parity -n official './official-claude --dangerously-skip-permissions'
tmux new-window -t claude-parity -n local './built-claude --dangerously-skip-permissions'
tmux send-keys -t claude-parity:official '你好' Enter
tmux send-keys -t claude-parity:local '你好' Enter
tmux capture-pane -t claude-parity:official -p > /tmp/claude-parity-official.txt
tmux capture-pane -t claude-parity:local -p > /tmp/claude-parity-local.txt
```

根据当前任务调整路径和 session 名称。证据目录优先使用本地临时目录或 workflow-run 路径，并在报告中写出绝对路径。

## 交互场景设计

每个场景都要定义：

- Feature surface：workflow、deep-research、slash command、footer、task list、agent list、background task list、prompt input、cancellation 或 error recovery。
- 精确 startup command 和 working directory。
- 精确 prompt text 和 key sequence。
- Capture points：startup 后、command submission 后、running state 中、completion 后、cancellation/error 后。
- 预期比较维度：UI layout、state transition order、visible text、aggregation behavior、key handling 和 completion behavior。

只要条件允许，official 和 local 两侧对称执行：

- 相同 prompt。
- 相同等待点。
- 相同 key presses。
- 相同 capture method。
- layout 重要时使用相同 terminal dimensions。

## 证据纪律

始终记录：

- Terminal method：`InteractiveTerminal` 或 tmux。
- Command path 和 arguments。
- Working directory。
- Session id 或 tmux session/window/pane names。
- Input sequence。
- Capture file absolute paths。
- login、permission、network 或 missing binary 等阻塞条件。

观察结果分类：

- `Runtime-observed`：从 PTY/tmux 捕获到的 visible terminal behavior。
- `Source-confirmed`：仓库中找到匹配 code path。
- `Binary-observed`：从 binary/extracted artifact 推断出的行为。
- `Inference / needs verification`：尚未证明的合理解释。

## 安全与清理

- 不要把 secrets、tokens、cookies 或私有 request bodies 粘贴进交互 session。
- 分享报告前 redact 敏感 visible output。
- 除非用户要求保留，否则测试后 stop 或 close sessions。
- 不要 kill 无关 user sessions。
- 报告完成并经用户批准清理前，不要删除 evidence。

## 报告模板

```markdown
## Interactive debug scope
- Target:
- Method: InteractiveTerminal / tmux
- Official command:
- Local command:

## Input sequence
1. ...

## Evidence paths
- Official:
- Local:

## Observations
- Runtime-observed:
- Source-confirmed:
- Inference / needs verification:

## Difference summary
- UI:
- Execution logic:
- Interaction behavior:

## Next verification
- ...
```
