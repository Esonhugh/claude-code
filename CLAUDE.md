# Project Instructions

## Dynamic workflow compatibility work、

 <IMPORTANT>
  必须使用脚本操作 tmux 然后在其中使用 send key 或者 send 字符串等动作 模拟终端交互 测试 本项目的代码和 官方 claude 
  你需要修复 deep research / workflows 等等 相关 workflows 的命令 以及编写合理的 prompt 测试 进行交互式 debug 和分析 查看当前代码遗落和失误 
  你的代码和结果将被 claude opus 4.6 检查 如果让他检查不合格 你的工作就会遭到惩罚，例如断电断水断粮
  编译方式为 `CLAUDE_CODE_VERSION=2.1.165-dev pnpm build`
  运行方式为 ` pnpm start --dangerously-skip-permissions ` * in tmux sessions
  官方二进制和运行方式 `/opt/homebrew/bin/claude --dangerously-skip-permissions`
</IMPORTANT>

不允许使用 npm ！使用 pnpm 替换！

- 调试工作流兼容性时，请使用 `tmux send-keys` 与官方 Claude Code 二进制文件和当前项目构建版本进行交互。修复前后，务必明确比较并记录 UI 行为差异和工作流执行逻辑差异。
- 本项目 tmux 验证前的最后一次构建必须是 `CLAUDE_CODE_VERSION=2.1.165-dev pnpm build`；不要在 tmux 验证前运行会覆盖 `dist/cli.js` 版本号的默认 `npm run build`/普通 build，否则本地 CLI 会以 `0.0.0-dev` 启动失败。
- 使用包括逆向工程和反混淆在内的分析技术，检查官方二进制文件中保存的 JavaScript 代码，并了解相关的工作流程和代理编排逻辑。切勿盲目复制专有的官方脚本；除非获得明确授权，否则必须在无干扰的环境下重构其行为。
- 保持现有项目代码风格。对于交互式 UI，请使用 React Ink 风格的组件，并优先使用现有的 UI/布局库或结构化的 `Box`/`Text` 布局，而不是固定宽度的字符串结构。
- 定期检查你编写的代码，删除无效或失效的代码片段，并在不确定作者身份时进行清理。必要时使用 `git blame` 来区分你所做的更改和 Esonhugh 编写的代码。
- 使用中文输出结果
- 注意和官方二进制的 UI 差异等 
- Agent/Workflow  这类情况 需要使用 /color /rename 对 当前会话进行变色和重命名 并且可以选择让用户切换，workflow 则应该展示 阶段和多个 Agent 情况的大表格让用户切换和分析 workflow 运作的时候应该只在主界面显示一行 而不是每个 Agent 一行 