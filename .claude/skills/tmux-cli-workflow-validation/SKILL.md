---
name: tmux-cli-workflow-validation
description: Use automatically when validating Claude Code CLI-only behavior—including slash commands, Agent, Workflow, deep-research, code-review, task lifecycle, notifications, scheduling, and terminal UI—through the latest locally built built-claude driven by scripted tmux. Never use parent-assistant tools with the same names as binary-side validation evidence.
version: 0.2.0
---

# tmux CLI Agent/Workflow 验收

通过可审计脚本驱动 tmux 中的最新 `built-claude`，验收只存在于 Claude CLI 进程内的 slash command、Agent、Workflow、任务调度和 TUI 行为。涉及这些行为的实现、修复、回归或验收时自动使用，无须用户再次明确要求 tmux。

## 不可违反的证据边界

- 被测对象是 tmux 中运行的当前工作区 `built-claude`。
- assistant-side `Agent`、`Workflow`、`Skill`、Task/Run 查询或其他同名工具不能作为 binary-side 证据。
- parent-side Task ID、Run ID、Agent 数、token 和报告不得写入 binary-side 结果表。
- parent-side 成功不能作为 tmux 验收失败后的替代证据。
- assistant-side 工具只用于构建、驱动 tmux、捕获 pane、读取 debug log、检查文件和保存证据。
- slash command 必须输入 `built-claude` stdin，不能作为 shell 命令执行。
- 每份 pane、debug log、输入、Task ID 和 Run ID 必须来自同一次 tmux 运行，禁止拼接不同重试的成功片段。
- 如误启动 parent-side 同名工具，立即停止该调用，从正式结果中排除，并在限制中披露；不得中止仍有效的 binary-side session。

## 验收入口矩阵

| 目标 | 必须使用的 binary-side 入口 | 禁止替代 |
|---|---|---|
| slash command | tmux 向 CLI stdin 输入 `/...` | shell 执行、parent Skill |
| Agent | 让 tmux 中的 `built-claude` 实际调用 Agent tool | parent Agent tool |
| Workflow | 让 tmux 中的 `built-claude` 实际调用 Workflow/WorkflowTool | parent Workflow tool |
| deep-research | CLI stdin 输入 `/deep-research ...` | parent 同名 skill/tool |
| code-review | CLI stdin 输入 `/code-review ...` | parent 同名 skill/tool |

无法在 binary 中触发的入口必须报告 `not covered`，不能用 parent-side 工具补足。

## 强制准备流程

1. 从仓库根目录读取 `Makefile`，确认 `VERSION`、构建命令和产物路径。
2. 记录 build 前状态：

   ```bash
   git status --short
   ```

3. 涉及当前源码的 CLI、Agent、Workflow、slash command 或 TUI 验收时，本轮必须运行：

   ```bash
   make build
   ```

   “最新 `built-claude`”指本轮验收开始后由当前工作区源码成功构建的产物。构建失败时不得回退旧 binary 并声称通过。仅在用户明确指定验证既有制品时可不重建，报告必须注明。
4. 记录 build 后、CLI 运行前状态，以及：
   - 仓库根目录绝对路径；
   - `Makefile` 版本；
   - `built-claude` 绝对路径；
   - `stat` 时间和 SHA-256；
   - 非敏感环境变量、CLI flags、终端尺寸。
5. 为每次运行创建唯一 session 和证据目录，不删除或覆盖旧证据。建议：

   ```text
   /tmp/tmux-cli-validation/<timestamp>-<target>-<pid>/
   ```

6. 默认保留 tmux session、pane、驱动脚本、stdout/stderr 和 debug log。未经用户要求不删除。

## 必须脚本驱动

不得以人工 attach 后键入命令作为主要验收路径。必须由脚本执行：

1. 创建唯一证据目录；
2. 启动 tmux；
3. 等待 CLI prompt ready；
4. 保存 ready pane；
5. literal 发送输入；
6. 保存 submitted/running/terminal pane；
7. 检查 session、pane process、超时和终态；
8. 保存脚本 stdout/stderr 和退出状态。

人工 attach 只能辅助观察。

### 启动

使用仓库和 binary 绝对路径，并固定 cwd：

```bash
tmux new-session -d -s "$session" -c "$repo_root" -x 200 -y 60 \
  "$repo_root/built-claude --dangerously-skip-permissions --debug --debug-file $evidence_dir/debug.log"
```

session 名应包含项目、目标、时间戳和随机/PID 后缀。创建前确认不存在，不通过 `kill-session` 解决重名。session 存在不代表 binary 已启动，必须从 pane 和 pane process 核对。

### Readiness

发送输入前强制轮询 pane，确认 CLI prompt 已出现；超时则保存 pane/debug 并停止该次验收，不得盲目发送。

### 精确输入

将完整输入保存到证据目录，使用 literal 模式，Enter 分开发送：

```bash
tmux send-keys -t "$target" -l -- "$exact_input"
tmux send-keys -t "$target" Enter
```

不要把未经转义的用户输入直接拼接进 shell 命令。

## slash command 任务设计

示例：

```text
/deep-research <具体、只读、可核验的研究任务>
/code-review <具体、只读、可核验的审查任务>
```

输入应明确：

- 研究或审查哪些代码和行为；
- 是否允许修改文件；
- 正常使用命令自身的 Agent/Workflow 调度；
- 输出文件和行号；
- 不修改、不提交、不 push、不创建 worktree，除非目标本身必须测试这些行为。

Agent/Workflow 可能产生大量网络调用和 token。限定范围和终止条件，不进行无限重试或无界 fan-out。

## 并行验收

多个独立命令使用多个独立 tmux/built-claude 进程并行验收，不要塞入同一 CLI session。每个 session 必须使用独立：

- session/pane target；
- evidence directory；
- input file；
- debug log；
- marker；
- Task ID / Run ID。

记录每个命令的入口、计划/实际 Agent 数、token、duration、状态和最终报告。检查并行运行之间没有 ID 或证据串线。

## 调度检查矩阵

1. **入口解析**
   - pane 出现预期 `WorkflowTool(...)`、`Workflow(...)` 或 `Agent(...)`；
   - 没有 `Unknown command`、错误入口或脚本语法错误。
2. **Agent fan-out**
   - 状态从 `0/N agents` 推进；
   - completed count 和 token 更新；
   - 并行 workflow 状态相互独立。
3. **后台生命周期**
   - 父 CLI 显示 background workflow running 并恢复可交互；
   - 完成通知回到同一父会话；
   - terminal 明确变为 `done`、`failed` 或 `stopped`。
4. **修复相关路径**
   - foreground → background 不重启 Agent stream；
   - summarizer handoff 不重复启动，terminal 只停止一次；
   - completed 后 classifier/worktree 失败不改报 failed；
   - failed/killed 通知保留 usage；
   - notification retry 不永久丢失且不产生竞态重复；
   - warnings 数组和展示文本去重一致。
5. **隔离与约束**
   - nested Agent、worktree、Workflow 内 Agent 正常；
   - worktree terminal 后完成清理；
   - CLI 运行前后 Git 可见状态没有非预期变化。

普通 CLI 无法稳定触发的故障路径必须标为“自动化测试覆盖”“受控 fault injection”或 `not covered`，不能假称由普通交互验收覆盖。

## pane、debug 与终态证据

保存多个原始 pane 快照：

```text
01-ready-pane.txt
02-submitted-pane.txt
03-running-pane.txt
04-terminal-pane.txt
```

优先捕获完整 history；若另存 stripped/normalized 版本，必须保留原始文件并记录转换方式。

- pane 证明用户可见 CLI/TUI 行为。
- debug log 是 Agent/Workflow 路由、handoff、summary ownership、notification 等内部流程的必要证据。
- 两者通过时间戳、session、输入、Task ID 和 Run ID 关联。
- debug log 搜索不到内部流程 marker 时，不得把该内部路径判为通过；只能报告 UI 观察和证据限制。
- 不得声称 debug log 包含未实际检索到的事件。

终态使用组合证据，而非单一 glyph：

- workflow/Agent 名或稳定 ID；
- `running → done/failed/stopped` 迁移；
- 对应 debug 事件；
- 父 CLI 恢复可交互；
- tmux session/pane process 状态；
- 必要时发送无副作用 marker 确认 prompt 恢复。

等待脚本必须有最大时限和 poll interval，并检查 session 消失或进程提前退出。timeout 后仍运行应报告 `running`，不是 `failed`。

不要只匹配 prompt 中可能出现的 `failed`、`completed` 或 marker；不要依赖易受宽度和 ANSI 影响的完整渲染行。优先使用 `case` 或结构化状态组合，避免 shell 不兼容的复杂条件。

## Git 状态基线

记录三个基线：

1. build 前；
2. build 后、CLI 启动前；
3. CLI 验收结束后。

第 2 与第 3 次比较用于判断被测只读 workflow 是否修改 Git 可见文件；构建产生的预期变化单独报告。`git status --short` 只证明 Git 可见变化，不代表所有 ignored 文件。

## 失败与重试

- build、tmux 启动、readiness、入口解析失败后，不得继续套用旧证据。
- 不盲目重复发送同一 slash command。
- 重试必须创建新的 session 和 evidence directory，并说明原因。
- timeout 或长工作流仍运行时保留 session，报告 `X/N agents`、token 和 elapsed。
- 不得将 `running` 报成完成。

## 与 claude-debug 的分工

同时遵守项目 `claude-debug` skill：

- 本 skill 负责最新 binary、script-driven tmux、stdin 输入、pane/TUI、Agent/Workflow 生命周期、证据隔离和终态归档。
- `claude-debug` 负责 debug flags、日志保留/脱敏、内部事件解释和敏感数据边界。

若要求 official parity，使用仓库根目录 `official-claude`，为 official/local 分别创建独立脚本、tmux session 和 evidence directory；官方成功不能证明本地通过。

## 报告格式

```markdown
## 范围
- Binary/path/version/hash:
- tmux sessions:
- Evidence directories:
- Exact inputs:

## 调度结果
| 命令 | binary-side 入口 | Agent 进度 | 终态 | pane/debug 证据 |
|---|---|---:|---|---|

## 修复路径检查
1. ...

## 发现
1. ...

## 未完成或限制
- ...

## Git 状态对照
- build 前：
- CLI 前：
- CLI 后：
```

状态必须严格使用 `passed`、`running`、`failed`、`stopped` 或 `not covered`。
