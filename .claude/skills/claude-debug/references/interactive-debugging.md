# 交互式 Claude Code 调试

当调试 UI、prompt handling、slash commands、permissions、workflows、task lists 和 stream rendering 时，使用交互式调试。

## 选择 tmux 还是 InteractiveTerminal

以下情况使用 tmux：

- 比较 `official-claude` 与 `built-claude` 的 terminal UI parity。
- 复现 workflow/deep-research/task-list 行为，且项目说明要求使用 tmux。
- 需要用相同 dimensions 从两个二进制获取持久 pane captures。

以下情况使用 `InteractiveTerminal`：

- 在当前 harness 中快速检查本地 terminal behavior。
- 只驱动一个进程，不需要完整 parity matrix。
- 通过 tool snapshots 捕获可见 terminal state。

## tmux 配方

创建两个 geometry 一致的 sessions：

```sh
tmux new-session -d -s cc-official -x 120 -y 40 './official-claude --dangerously-skip-permissions'
tmux new-session -d -s cc-built -x 120 -y 40 './built-claude --dangerously-skip-permissions'
```

发送相同输入：

```sh
tmux send-keys -t cc-official 'hello' Enter
tmux send-keys -t cc-built 'hello' Enter
```

捕获 panes：

```sh
tmux capture-pane -p -e -t cc-official > /tmp/cc-official-pane.txt
tmux capture-pane -p -e -t cc-built > /tmp/cc-built-pane.txt
```

记录：

- session names；
- 精确 command lines；
- terminal size；
- input sequence；
- capture paths；
- 观察到的差异。

只有在捕获证据后才清理：

```sh
tmux kill-session -t cc-official
tmux kill-session -t cc-built
```

## InteractiveTerminal 配方

打开目标二进制 session，然后写入输入并读取 snapshots：

```text
InteractiveTerminal.open command='./built-claude --dangerously-skip-permissions'
InteractiveTerminal.write text='hello' enter=true
InteractiveTerminal.read
```

该模式适合快速检查，以及项目记忆偏好 InteractiveTerminal 而非 tmux 的任务。如果嵌套 Claude 卡住，捕获卡住状态，并切换到非交互式或基于 tmux 的验证。

## 证据卫生

如果完整 terminal captures 包含 secrets 或 private prompts，不要粘贴。只摘要并引用相关 lines。将完整 captures 保存在 `/tmp` 或命名清晰的本地 debug 目录下。
