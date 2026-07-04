# 已实现功能的测试与验收

当需要验证已经写好的 Claude Code 功能是否正常时，不要只跑一个 happy path。测试应覆盖功能入口、子功能、参数组合、正确路径、失败路径、真实交互行为，以及从触发到功能完成的端到端全流程，并用可复现证据支持结论。

核心要求：

- 正反对照：既验证“应该发生的行为确实发生”，也验证“不应该发生的行为不会发生”。
- 成功/失败双路径：每个关键入口、子功能和参数组合都尽量同时覆盖正确路径与失败路径。
- 全流程优先：只测单点不足以证明功能可用；优先跑到功能自然完成状态，并检查最终输出、状态和副作用。

## 测试范围拆解

先把功能拆成可验证单元：

- 主入口：CLI flag、slash command、skill、workflow、hook、tool、UI action 或 API path。
- 子功能：每个可独立开关、分支、模式、输出格式、状态更新和副作用。
- 输入参数：必填、可选、默认值、边界值、非法值、组合值。
- 环境条件：settings、env、cwd、权限模式、HOME/CLAUDE_CONFIG_DIR、网络/proxy、是否有 auth。
- 输出与副作用：stdout/stderr、exit code、JSON events、日志、文件变更、UI 状态、hook 执行、网络请求。
- 完成判据：功能何时算完成，例如命令退出、UI 返回可输入状态、任务状态变为 completed、文件写入完成、网络请求结束、最终报告生成。

测试报告必须说明哪些范围已覆盖，哪些未覆盖，不要把局部通过说成整体通过。

## 正反对照与全流程验收

每个功能至少设计一组正向用例和一组反向用例：

| 对照类型 | 要验证什么 | 示例 |
| --- | --- | --- |
| 正向正确路径 | 合法输入能完成全流程 | 输入有效参数后，命令 exit=0，输出包含预期字段，副作用完成 |
| 反向失败路径 | 非法输入不会被误当成功 | 输入坏 JSON 后，exit!=0，stderr 有明确错误，不写入成功产物 |
| 正向状态变化 | 应该改变的状态确实改变 | UI 选择确认后列表刷新、任务进入 completed |
| 反向状态保持 | 不应该改变的状态保持不变 | Esc 取消后不提交、不写文件、不触发网络请求 |
| 正向副作用 | 应产生的文件、日志、请求存在 | 生成目标报告，debug log 出现目标事件 |
| 反向副作用 | 失败时不产生错误副作用 | 参数错误时不创建半成品、不污染配置、不残留后台任务 |

全流程验收要从用户真实入口开始，持续执行到功能自然完成：

1. 以真实入口触发功能：CLI command、slash command、UI action、hook lifecycle 或 API path。
2. 按真实用户顺序提供输入、参数、按键或环境。
3. 观察中间状态：loading、streaming、permission dialog、task state、日志事件。
4. 等到明确完成信号：exit code、prompt 返回、状态完成、文件落盘、最终 UI/报告出现。
5. 检查最终输出与副作用，并确认失败路径不会留下成功痕迹。

如果只能测子流程，必须说明缺失的上游/下游步骤，以及为什么不能证明完整功能已通过。

## 参数测试矩阵

对每个参数至少覆盖：

| 类型 | 示例 | 目的 |
| --- | --- | --- |
| 默认值 | 不传 flag / 不填字段 | 验证默认行为 |
| 显式正常值 | `--output-format stream-json` | 验证目标路径 |
| 边界值 | 空字符串、0、1、最大限制、长输入 | 发现边界处理问题 |
| 非法值 | 未知枚举、错误路径、坏 JSON | 验证错误信息和 exit code |
| 组合值 | 多个 flags/env/settings 同时存在 | 验证优先级和冲突处理 |
| 重复值 | 重复 flag、重复字段 | 验证覆盖、合并或报错规则 |

如果参数很多，优先选择：

1. 每个参数至少一个独立测试；
2. 关键参数之间的组合测试；
3. 已知高风险组合，例如 env 与 settings 同时设置、print mode 与 interactive mode 混用、proxy 与 base-url 同时设置。

## 子功能测试要求

每个子功能都要有独立证据：

- 正常路径：输入有效时产生预期输出或状态，并能继续推进到功能完成。
- 错误路径：输入无效时给出明确错误，不吞错、不误报成功。
- 正反对照：同一行为最好有一个“应该成功”的样例和一个“应该失败/不应发生”的样例。
- 回归路径：曾经失败的场景必须有最小复现测试。
- 隔离性：该子功能不应破坏其他已知路径。
- 幂等性：重复执行不应产生意外重复副作用，除非设计如此。
- 终态检查：子功能完成后检查最终输出、状态、副作用和可继续操作性。

示例报告方式：

```markdown
## 子功能覆盖
- 参数解析：已测 `--foo` 默认值、合法值、非法值；非法值 exit=1 且 stderr 包含错误说明。
- 输出格式：已测 text/json/stream-json；JSONL 逐行 parse 通过。
- 文件副作用：已测目标文件创建与覆盖提示；未测权限不足路径。
```

## 非交互式功能验证

适合验证 print mode、API request shape、JSON output、exit code、文件副作用等确定性行为。

基本证据：

- 精确 command；
- cwd 和影响行为的非敏感 env；
- stdout/stderr 分离捕获；
- exit code；
- 产物路径和校验方式；
- 必要时的 debug log path。

示例模板：

```sh
set +e
./built-claude --print "测试输入" --dangerously-skip-permissions > /tmp/feature.out 2> /tmp/feature.err
code=$?
printf 'exit_code=%s\nstdout_bytes=%s\nstderr_bytes=%s\n' "$code" "$(wc -c < /tmp/feature.out)" "$(wc -c < /tmp/feature.err)"
set -e
```

判断标准应具体，例如：

- exit code 是否符合预期；
- stdout 是否可解析为目标格式；
- stderr 是否为空或包含预期错误；
- 输出 JSON 是否具备必需字段；
- 文件是否存在、内容是否符合预期、mtime 是否更新；
- debug log 是否出现目标事件且没有异常堆栈；
- 成功路径是否完整执行到结束；
- 失败路径是否在预期位置停止，并且没有留下成功路径才应出现的产物。

非交互式测试不要只验证“成功命令 exit=0”。至少再构造一个失败命令，例如缺少必填参数、传入非法枚举、指定不存在路径或提供坏 JSON，并确认它 exit!=0、错误信息明确、没有错误副作用。

## 交互式功能验证

交互式功能必须通过真实 PTY/TUI 行为判断，不能只读源码或调用宿主 shell 模拟。

适用场景：

- slash command；
- prompt rendering；
- permission dialog；
- task list / workflow UI；
- streaming output；
- keyboard shortcut；
- statusline；
- hook 在会话生命周期中的表现。

### tmux 验收

项目要求 parity、官方对照或稳定 pane capture 时使用 tmux：

```sh
tmux new-session -d -s cc-test -x 120 -y 40 './built-claude --dangerously-skip-permissions'
tmux send-keys -t cc-test '/skills' Enter
tmux capture-pane -p -e -t cc-test > /tmp/cc-test-pane.txt
```

交互式验收要记录：

- session/window/pane 标识；
- 启动命令和 terminal size；
- 完整 input sequence；
- capture path；
- 关键输出摘录；
- 判断依据。

### InteractiveTerminal 验收

快速本地验证可使用 `InteractiveTerminal`：

```text
InteractiveTerminal.open command='./built-claude --dangerously-skip-permissions'
InteractiveTerminal.write text='/skills' enter=true
InteractiveTerminal.read
```

如果需要比较 `official-claude` 与 `built-claude`，优先使用相同 terminal size 的 tmux 双 session，而不是只凭一次 InteractiveTerminal snapshot。

## 如何判断交互式功能正常

交互式测试通过必须同时满足：

- 输入被目标 binary-side 表面接收，而不是被 assistant-side shell 误执行。
- UI 出现预期状态、列表、提示、按钮、权限对话或 streaming 更新。
- 键盘操作后状态按预期变化，例如 Enter 确认、Esc 取消、方向键移动选择。
- 正向流程能一路执行到完成信号，例如 prompt 返回、任务 completed、最终消息出现或文件生成。
- 反向流程能验证失败/取消行为，例如 Esc 取消、不确认 permission、输入非法值、触发超时或拒绝权限。
- 异常路径可恢复，例如取消、错误输入、超时或权限拒绝后仍能继续会话。
- 输出没有明显布局破坏，例如 ANSI 泄漏、重复渲染、截断、错位、stale state。
- 需要持久化的状态在下一步或 compact/session 边界后仍能观察到。
- 失败路径不会误显示成功态，也不会残留成功路径才应产生的状态或产物。

不要使用以下判断：

- “源码里有这个分支，所以正常”。
- “命令没有立刻报错，所以正常”。
- “读到 skill 文件，所以 `/skills` 一定会列出”。
- “assistant-side Bash 能运行，所以 binary-side slash command 正常”。
- “截图看起来差不多”，但没有输入序列、pane capture 和明确预期。

## 回归测试流程

修复 bug 或验证曾经失败的功能时，必须验证原始症状：

1. 用最小步骤复现旧问题，记录失败证据。
2. 应用修复或切换到修复后版本。
3. 用同一输入重新运行。
4. 确认旧症状消失，并且相关子功能未回退。

如果已经无法在当前版本复现旧问题，报告中要说明原因，不要声称完成 red-green 验证。

## 最小报告格式

```markdown
## 范围
- 功能：
- 子功能：
- 参数/环境：
- 模式：non-interactive | interactive | proxy | mixed

## 执行证据
- Commands / input sequence:
- Artifacts:
- Exit code / UI state:
- Redactions:

## 正反对照
- 正向用例：
- 反向用例：
- 成功路径终态：
- 失败路径终态：

## 覆盖结果
- 已覆盖：
- 未覆盖：
- 失败或风险：

## 判断
- 结论：通过 | 部分通过 | 未通过
- 依据：
```

## 常见错误

- 只测 happy path，没有非法参数和组合参数。
- 只测正确路径，不测失败路径。
- 只测正向行为，不做反向对照，无法证明错误行为不会发生。
- 只测单个中间步骤，没有跑到功能完成终态。
- 只测主功能，没有逐项验证子功能。
- 把 assistant-side 命令结果当成 binary-side 功能结果。
- 没有捕获 stdout/stderr/exit code 或 pane output。
- 没有记录 env/settings，导致结果不可复现。
- 用“应该正常”替代新鲜验证证据。
