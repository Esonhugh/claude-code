# 交互式 Claude Code 运行时诊断

本 reference 用于单进程、快速、聚焦的本地 PTY/TUI 调试，例如 prompt rendering、permission dialog、简单 slash command、streaming output、statusline 或取消后恢复。

如果任务要求严格验证 Agent、Workflow、`/deep-research`、`/code-review`、task lifecycle、notification、scheduling，或需要 official/local pane parity，请改用 `claude-agent-workflow-validation` skill。该 skill 负责最新 `built-claude`、scripted tmux、证据隔离和终态归档。

## 使用 InteractiveTerminal

只在用户拥有且信任的 workspace 中使用 `--dangerously-skip-permissions`；需要隔离副作用时使用临时 `CLAUDE_CONFIG_DIR`，不要在不可信仓库中关闭权限检查。

从项目根目录打开目标二进制：

```text
InteractiveTerminal.open command='./built-claude --dangerously-skip-permissions'
InteractiveTerminal.write text='hello' enter=true
InteractiveTerminal.read
```

按任务需要使用：

- `write`：输入文本；
- `send_key`：发送 Enter、Esc、方向键和 Ctrl-C；
- `resize`：检查 terminal geometry 变化；
- `read`：捕获 compact/full/save_file snapshot；
- `status`：检查 PTY 是否仍运行；
- `signal` / `close`：验证终止或完成清理。

## Binary-side 证据边界

`InteractiveTerminal` 是 assistant-side 传输工具，被测对象是其中运行的 Claude binary。

- Slash command 必须写入 binary stdin，不能作为 shell command 执行。
- 读取源码不能证明 binary 已注册 skill、command 或 workflow。
- Assistant-side `Agent`、`Workflow`、`Skill` 和 Task ID 不能证明 binary-side 同名能力正常。
- 报告中区分 `assistant-side action` 与 `binary-side observation`。

## 快速诊断流程

1. 记录 binary path、cwd、terminal size 和影响行为的非敏感 env。
2. 打开一个目标进程，等待 prompt ready。
3. 发送最小输入并读取 snapshot。
4. 需要时发送按键、resize 或 signal。
5. 等待明确完成信号：prompt 返回、dialog 关闭、stream 结束或进程退出。
6. 检查错误/取消后是否仍可继续交互。
7. 保存相关 snapshot；完整输出含敏感内容时使用 `save_file`，只报告脱敏摘录。

## 何时升级到 tmux 验收

遇到以下任一条件时停止把 quick check 当作正式验收，并调用 `claude-agent-workflow-validation`：

- 需要 Agent/Workflow fan-out、foreground/background continuation 或 completion notification；
- 需要 `/deep-research`、`/code-review`、task list 或 scheduler 的完整生命周期；
- 需要相同 dimensions 的 `official-claude` / `built-claude` pane 对照；
- 需要审计 session、Task ID、Run ID、debug log 和多阶段 pane；
- nested Claude 在 InteractiveTerminal 中卡住，且非交互式调试不足以定位。

## 证据卫生

记录 InteractiveTerminal session ID、输入序列、snapshot 或 save-file 路径及观察结果。不要粘贴包含 token、cookie、private prompt、完整 request body 或客户数据的 capture。
