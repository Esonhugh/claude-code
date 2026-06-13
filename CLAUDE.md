# Project Instructions

## InteractiveTerminal tool development

本仓库当前任务重点是新增并修复独立的 `InteractiveTerminal` tool。该功能是本项目新增能力，不是官方 Claude Code 2.1.165 的可见入口，因此不要把它当作官方 parity 功能逐项对比。

- 使用中文输出结果。
- 不允许使用 npm；所有包管理和脚本命令使用 pnpm。
- 构建方式为：`CLAUDE_CODE_VERSION=2.1.165-dev pnpm build`。
- 本地交互式验证运行方式为：`pnpm start --dangerously-skip-permissions`，并放在 tmux session 中驱动。
- `CLAUDE-workflow.md` 保留给 deep research / workflows 官方兼容性工作使用；InteractiveTerminal 独立功能开发不要套用其中的官方 UI parity 要求。
- InteractiveTerminal 的验收应以本地行为正确性为准：PTY session 能打开、写入、读取、发送按键、resize、signal、close；Dialog preview 能稳定展示最近终端输出，不能因为 ANSI、CRLF、控制字符或 stale AppState 破坏格式。
- 调试交互行为时，必须使用脚本操作 tmux（例如 `tmux send-keys`、`tmux capture-pane`）模拟真实终端交互，记录复现步骤和关键 pane 输出。
- UI 代码保持 React Ink 风格，优先使用现有 `Box` / `Text` / design-system 组件，不要手写固定宽度 ANSI 字符串布局。
- 不允许自己拼接或解析 ANSI 显示样式；需要颜色/样式时使用 Ink 组件属性，例如 `<Text color="green">...</Text>`。Preview 如需纯文本展示，应显式 strip/normalize，并用测试覆盖。
- 修改 bug 必须先定位根因，再写最小失败测试；修复后运行相关测试和构建。
- 保持现有项目代码风格。定期检查 diff，删除无效、重复或失效代码片段。
- 不要在用户明确批准前创建 git commit。
