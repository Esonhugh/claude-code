# Project Instructions

## Response Language and Style

- 默认使用中文输出结果。
- 回复应简洁直接，优先给结论，再给必要说明。
- 代码、命令、文件名、错误信息、日志和 API 名称保持原文。
- 解释代码或行为时，尽量引用具体文件和行号，格式为 `path/to/file:line`。
- 不使用 emoji，除非用户明确要求。

## Core Working Principles

- 修改代码前必须先阅读相关文件，理解现有实现和调用链。
- 不要对未阅读、未理解的代码提出具体修改方案。
- 优先做最小、明确、可验证的改动。
- 不做超出用户请求范围的重构、优化、功能扩展或风格调整。
- 保持现有项目代码风格、命名习惯、目录结构、组件模式和测试模式。
- 优先复用现有模块、组件、工具函数和脚本。
- 不要为了单次使用创建新的 helper、utility、抽象层或兼容层。
- 不要设计假想未来需求；只实现当前任务实际需要的复杂度。
- 如果需求不清楚，先提出具体问题，不要自行假设关键行为。
- 遇到失败时先阅读错误并定位根因，不要盲目重复同一操作。

## Package Management and Commands

- 不允许使用 `npm`；所有包管理和脚本命令使用 `bun`。
- 不要混用包管理器，不要生成或修改非项目所需的 lockfile。
- 不要随意新增、升级、降级依赖；依赖变更前必须说明原因并获得用户确认。
- 优先使用项目已有脚本和既有验证方式。
- 运行命令前确认其影响范围，避免执行会修改全局环境、删除文件、影响外部服务或修改共享状态的命令。

## Code Changes

- 新功能应尽量沿用现有架构和数据流，不引入不必要的新模式。
- 修 bug 必须先定位根因，再写最小失败测试，最后实现修复。
- 修复应针对根因，不要通过跳过逻辑、放宽断言、吞掉异常或隐藏错误来“通过测试”。
- 删除代码时确认引用关系，避免留下无效注释、废弃导出、空包装或兼容占位。
- 不要添加无意义注释、重复注释或解释显而易见的代码。
- 只在逻辑复杂、非显然或容易误解时添加简短注释。
- 不要引入安全风险，包括但不限于命令注入、XSS、SQL 注入、路径穿越、敏感信息泄露。
- 对用户输入、外部 API、文件路径、shell 参数、网络响应等系统边界进行必要校验。

## Testing Requirements

- 修改 bug 必须优先添加或更新能够复现问题的最小失败测试。
- 修改代码后必须运行相关测试。
- 如果存在更小范围的测试，优先运行相关测试；必要时再运行更大范围或全量测试。
- 测试失败时必须阅读失败信息并定位原因，不要盲目重试。
- 不允许删除、跳过、弱化测试来掩盖问题，除非用户明确要求并理解风险。
- 如果无法运行测试，必须说明原因、已完成的验证以及建议用户执行的命令。

## Build and Local Verification

- 涉及构建、打包、类型定义、CLI 入口、运行时行为或发布产物的改动，必须运行对应构建或检查命令。
- 构建命令优先参考 `Makefile`；当前默认入口为 `make build`，其内部通过 `CLAUDE_CODE_VERSION=$(VERSION) bun package:binary` 构建并产出 `./built-claude`。
- 本地交互式验证优先参考 `Makefile`；当前默认入口为 `make test`，其内部运行 `./built-claude --dangerously-skip-permissions`。
- 需要手动执行构建或验证时，应先检查 `Makefile` 中的 `VERSION`、产物路径和目标命令是否仍然符合当前任务。
- 本地交互式验证必须放在 tmux session 中驱动。
- 调试交互行为时，必须使用脚本操作 tmux（例如 `tmux send-keys`、`tmux capture-pane`）模拟真实终端交互，记录复现步骤和关键 pane 输出。
- 验证完成前检查 diff，删除调试日志、临时代码、重复代码、无效代码和无关改动。

## UI and Terminal Interaction Rules

- UI 代码保持 React Ink 风格，优先使用现有 `Box` / `Text` / design-system 组件。
- 不要手写固定宽度 ANSI 字符串布局。
- 不允许自己拼接或解析 ANSI 显示样式；需要颜色或样式时使用 Ink 组件属性，例如 `<Text color="green">...</Text>`。
- Preview 如需纯文本展示，应显式 strip/normalize，并用测试覆盖。
- InteractiveTerminal 的验收应以本地行为正确性为准：PTY session 能打开、写入、读取、发送按键、resize、signal、close；Dialog preview 能稳定展示最近终端输出，不能因为 ANSI、CRLF、控制字符或 stale AppState 破坏格式。

## Workflow and Compatibility Notes

- `CLAUDE-workflow.md` 保留给 deep research / workflows 官方兼容性工作使用。
- InteractiveTerminal 独立功能开发不要套用 `CLAUDE-workflow.md` 中的官方 UI parity 要求。
- 涉及官方 Claude CLI 行为、workflow parity、deep research parity、任务列表行为或 tmux 交互一致性验证时，应按对应兼容性流程处理。

## Git Workflow

- 不要在用户明确批准前创建 git commit。
- 不要在用户明确批准前 push、force-push、创建 PR、打 tag 或发布 release。
- 不要执行破坏性 git 操作，除非用户明确要求；包括但不限于 `git reset --hard`、`git clean -fd`、`git checkout -- .`、删除分支、强推。
- 提交前必须检查 `git status` 和 `git diff`，确认只包含预期改动。
- 提交信息应简洁说明变更目的，不要夸大变更范围。
- 不要使用 `--no-verify` 跳过 hooks，除非用户明确要求。

## Release and Publishing

- 发布前必须确认版本号、变更范围、测试结果、构建结果和发布产物。
- 不要自动发布、上传制品、修改远程状态或操作共享环境，除非用户明确授权。
- 涉及 CI/CD、权限、线上环境、共享配置、外部服务的操作必须先说明影响并获得确认。
- 发布失败时先分析日志和失败阶段，不要重复执行同一失败命令。
- 发布前确认没有调试日志、临时代码、无关文件、密钥、token、私有配置进入版本控制或产物。

## Security and Secrets

- 不要读取、打印、提交 `.env`、密钥、token、证书、cookie、私有凭证等敏感内容，除非任务明确需要且用户授权。
- 如果发现敏感信息出现在 diff、日志或输出中，立即提醒用户并停止扩散。
- 不要把私有代码、日志、配置或数据上传到第三方服务。
- 处理 shell 参数、文件路径、URL、SQL、HTML、Markdown、JSON 等外部输入时，避免注入和转义问题。

## Communication and Handoff

- 任务开始时只说明必要行动，不重复用户需求。
- 遇到阻塞时说明当前状态、阻塞原因、已尝试内容和需要用户决定的问题。
- 完成后简要说明修改了什么、验证了什么、是否存在未验证项或风险。
- 不要在仍有进行中的任务时输出最终总结；先更新任务状态。
