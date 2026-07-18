---
name: claude-code-feature-validation
description: Use this skill automatically whenever validating a Claude Code repository change: a new feature, modified feature, bug fix, refactor, CLI command, tool, Agent/Workflow behavior, task lifecycle, React Ink/TUI interaction, packaging, or official/local compatibility. It selects the smallest sufficient validation ladder from diff inspection, focused tests, type/lint checks, build, direct runtime checks, scripted tmux, and official parity, then reports evidence-backed passed/failed/not-covered results. Also trigger for Chinese requests mentioning feature 验收、改动验证、回归、CLI/TUI 验收、构建验证或官方对照. Delegate strict binary-side Agent/Workflow/slash-command/task/TUI evidence to claude-agent-workflow-validation; parent-assistant tools never count as binary evidence.
version: 0.1.0
---

# Claude Code Feature Validation

为 Claude Code 新增或修改 feature 后，根据真实改动和风险选择最小但充分的验证路径，并输出可审计结论。不要把“命令退出 0”“测试通过”或“runtime done”单独等同于 feature 已通过验收。

## 核心原则

1. **先理解改动，再选择验证。** 阅读相关 diff、实现、调用链、测试和项目脚本，不对未读代码设计具体断言。
2. **从用户可见契约反推 assertions。** 验证改动声称提供或修复的行为，而不只是实现细节。
3. **验证层级与风险匹配。** 默认从最小范围开始；只有当前层不能证明行为时才升级。
4. **测试和运行时证据互补。** 自动化测试证明可重复逻辑；真实 CLI/TUI 验收证明进程内集成和用户可见行为。
5. **结论必须绑定证据。** 缺少必要证据时标记 `not covered`，仍运行标记 `running`，不得用推测补齐。
6. **不制造额外副作用。** 不 commit、push、创建 PR、发布、修改共享配置或删除用户状态，除非用户明确授权。
7. **尊重当前工作区。** 不覆盖或清理既有未提交改动。验证前后检查 Git 可见状态，将构建产物与被测运行副作用分开。

## 第一步：建立变更契约

开始验证前，写出精简 validation scope：

- changed behavior：新增、修改或修复了什么；
- affected surfaces：纯函数、状态、组件、命令、tool schema、CLI 入口、TUI、Agent/Workflow、构建或发布产物；
- user-visible contract：用户输入、状态迁移、输出、错误行为和副作用；
- regressions at risk：最可能被破坏的相邻行为；
- exclusions：本轮明确不验证的内容及原因。

从 `git diff`、相关文件和测试中确认这些事实，不仅依赖用户描述或 commit message。

## 第二步：声明 assertions

每条 assertion 至少记录：

- `assertion_id`
- `subject`
- `predicate`
- `required_evidence`
- `observed_evidence_paths`
- `runtime_state`（不适用时写 `n/a`）
- `validation_verdict`
- `reason_if_not_passed`

Verdict 仅使用：

- `passed`：必要证据完整且与 assertion 关联；
- `failed`：观察结果明确违反 assertion；
- `running`：验证仍运行，尚无终态；
- `stopped`：验证被明确停止；
- `not covered`：未执行、无法安全触发或证据不足。

Binary runtime state 使用 `running | done | failed | stopped`。`done` 不自动等于 validation `passed`。

## 第三步：选择验证阶梯

按改动 surface 选择必要层级，不机械执行全部层级。详细路由见 [`references/validation-routing.md`](references/validation-routing.md)。

### L0 — 静态审查

始终执行：

- 查看相关 diff 和调用链；
- 检查引用、schema、注册入口、导入导出和删除残留；
- 检查调试日志、无关改动、敏感信息和明显安全问题；
- 从 `package.json`、`Makefile` 或现有测试模式确认验证命令，不猜测脚本。

L0 只能证明静态事实，不能证明运行时行为。

### L1 — 聚焦自动化测试

实现逻辑、状态、组件或 bug fix 变化时执行：

- 优先运行最小相关测试文件或 pattern；
- bug fix 优先添加或更新可复现问题的最小失败测试；
- 新 feature 覆盖主路径、关键状态转换和任务要求中的边界；
- 不删除、跳过、弱化断言或吞异常来使测试变绿。

报告精确命令、exit code、通过/失败数量和关键失败信息。测试通过只覆盖其断言范围。

普通测试文件按实际相关路径直接聚焦运行：

```bash
bun test path/to/foo.test.ts path/to/Foo.test.tsx
```

先从 diff、用户指定路径和相邻实现确定测试文件；不要仅按扩展名扩大到全量 suite。出现 `.test.tsx` 只说明它是测试文件，不代表需要交互式验收。只有 assertion 依赖真实 CLI stdin、TTY、按键、resize、terminal render 或进程内生命周期时才升级到 L5。

### L2 — 类型、lint 与仓库检查

涉及 TypeScript 类型、跨模块接口、schema、registry、公共入口或较大范围代码时，运行项目已有相关检查。优先小范围；需要仓库级保证时再运行 `make release-check` 或其现有组成命令。

本项目只使用 `bun`、`bunx` 和 `make`，不使用 `npm`。

### L3 — 构建与制品检查

涉及 CLI 入口、运行时行为、打包、类型定义、命令/tool 注册或发布制品时必须构建：

1. 读取根目录 `Makefile`，确认当前 `VERSION`、命令和产物路径；
2. 保存 build 前 `git status --short`；
3. 本轮运行 `make build`；
4. 保存 build 后状态，并记录 `built-claude` path、version、mtime、SHA-256；
5. 构建失败时停止依赖新制品的后续验收，不得回退旧 binary 并声称通过。

仅文档、纯测试或不进入 binary 的局部改动通常不需要 L3，除非用户要求。

### L4 — 非交互运行时验证

适用于 `--print`、stdout/stderr、exit code、debug flags、settings/env 或无需持续 TTY 的单进程行为。使用最小、确定、无副作用输入，保存命令、输出、exit code 和相关 debug log。

如果行为只存在于交互式 CLI 进程内，不要用 L4 替代 L5。快速单进程诊断使用 `claude-runtime-debug`；网络问题使用 `claude-network-debug`。

### L5 — Scripted tmux 真实交互验收

以下目标必须升级到 L5：

- slash command stdin dispatch；
- Agent、Workflow、WorkflowTool 或 nested Agent；
- `/deep-research`、`/code-review`；
- task lifecycle、foreground/background continuation、notification、scheduling；
- React Ink/TUI、按键、resize、signal、terminal preview；
- 必须在真实 CLI 中确认的交互状态。

此层必须通过 `Skill` 工具调用并遵循 `claude-agent-workflow-validation`，不能只在报告中提到它或自行用简化交互替代。它要求 tmux 中运行本轮新构建的 `built-claude`，通过脚本完成 readiness、literal stdin、分阶段 pane capture、debug marker 和终态检查。

调用专项 skill 前先完成 L0/L1，并在需要当前 binary 时完成 L3。调用后由专项 skill 驱动 tmux；不要在 parent-side 启动 `Agent` 来模拟被测 Agent。当前 assistant 会话的 `Agent`、`Workflow`、`Skill`、Task/Run 查询均不能作为 binary-side 证据；无法在 binary 中触发时必须报告 `not covered`。

### L6 — Official/local parity

仅当需求涉及官方兼容性、行为对照或回归基准时执行。遵循 `claude-agent-workflow-validation` 的 parity 规则，为 `official-claude` 与 `built-claude` 使用独立 session/evidence/config roots，并保持 prompt、terminal dimensions、settings、auth、model env 和 flags 等价。官方成功不能替代本地通过。

## 改动类型路由

| 改动类型 | 最低建议层级 | 必须关注 |
|---|---|---|
| 文档/说明 | L0 | 内容与实现一致、链接和命令准确 |
| 纯函数/内部逻辑 | L0 + L1 | 主路径、边界、回归测试 |
| bug fix | L0 + L1 | 最小失败测试复现根因 |
| React Ink 组件/状态 | L0 + L1 | render/state；真实交互则 L3 + L5 |
| command/tool/schema/注册 | L0 + L1 + L2 + L3 | 注册可达、schema、构建制品 |
| `--print`/非交互 CLI | L0 + L1 + L3 + L4 | stdout/stderr、exit code、debug |
| slash command/TUI | L0 + L1 + L3 + L5 | stdin、pane、prompt 恢复、终端状态 |
| Agent/Workflow/task 调度 | L0 + L1 + L3 + L5 | binary-side ID、进度、通知、debug marker |
| packaging/release path | L0 + L2 + L3 | 制品路径、版本、release checks |
| official parity | 对应层级 + L6 | 两侧环境等价、证据隔离 |

矩阵给出最低建议，不是上限。改动跨多个 surface 时取并集。

## 证据充分性

| Assertion | 必要证据 | 证据不足 |
|---|---|---|
| 源码路径已实现 | diff + 相关源码/注册引用 | `not covered` |
| 自动化行为正确 | exact test command + exit code + test result | `failed` / `not covered` |
| build 产物来自当前源码 | 本轮 build log + binary metadata + Git baselines | `not covered` |
| CLI 入口已接收 | exact input + submitted pane/output + 无解析错误 | `failed` / `not covered` |
| Agent/Workflow 已启动 | running pane + 稳定 binary-side ID | `not covered` |
| routing/handoff/ownership 正确 | 同次运行 debug marker + 关联 ID | `not covered` |
| 用户可见终态正常 | terminal pane/output + prompt/exit + process state | `running` / `failed` / `stopped` |
| 无非预期仓库副作用 | CLI 前后 Git 状态对照 | `not covered` |

普通运行无法稳定触发的故障路径，明确写为“自动化测试覆盖”“受控 fault injection”或 `not covered`，不能假称真实交互已覆盖。

## 失败处理

- 先读取失败输出并定位阶段：test、typecheck、build、readiness、dispatch、runtime 或 assertion evidence。
- 不盲目重复相同命令。
- 允许重试时记录原因；L5 必须使用新 session、evidence 和 config roots，保留旧证据。
- 测试失败不自动证明整个 feature 失败；只将对应 assertion 标为 `failed`，其余按证据判定。
- 环境阻塞时标记 `not covered`，说明阻塞和用户可执行的最小后续命令。

## Skill 边界

| Skill | 负责 |
|---|---|
| `claude-code-feature-validation` | 通用变更契约、验证路由、自动化检查、构建和最终证据汇总 |
| `claude-agent-workflow-validation` | 最新 binary、scripted tmux、slash command、Agent/Workflow、task/TUI lifecycle、official parity |
| `claude-runtime-debug` | `--print`、stdout/stderr/exit、debug flags/log、settings/env 的快速诊断 |
| `claude-network-debug` | proxy/OAuth/network、SSE/WebSocket、CONNECT、MITM/CCH wire summary |
| `claude-source-binary-analysis` | 静态源码/二进制分析、Bun section、反混淆、symbol/section、离线 checksum |

本 skill 负责选择和汇总路径；专项 skill 输出只能证明其实际覆盖的 assertion。

## 报告格式

```markdown
## 范围与变更契约
- Changed behavior:
- Affected surfaces:
- Validation ladder:
- Exclusions:

## Assertions
| ID | Subject / predicate | Required evidence | Observed evidence | Runtime | Verdict / reason |
|---|---|---|---|---|---|

## 执行结果
| Layer | Command / binary-side entry | Result | Evidence |
|---|---|---|---|

## 发现
1. ...

## 未覆盖与限制
- ...

## Git 状态对照
- validation/build 前：
- CLI 前（如适用）：
- validation 后：
```

只声称证据实际证明的内容。列出精确命令、关键 exit code、测试结果、binary metadata、tmux target 和绝对 evidence path；避免粘贴敏感配置或凭证。
