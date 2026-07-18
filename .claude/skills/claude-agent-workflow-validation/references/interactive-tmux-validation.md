# Scripted tmux 交互验收配方

本 reference 展开 `claude-agent-workflow-validation` 的强制执行细节。主 `SKILL.md` 是规则权威；本文件不得降低 build、证据隔离、readiness、终态和 retry 要求。

## 1. Preflight 与 build 基线

从仓库根目录开始：

1. 读取 `Makefile`，确认 `VERSION`、`make build` 和 `built-claude` 路径。
2. 保存 build 前 `git status --short`。
3. 当前源码验收必须在本轮执行 `make build`；失败时停止，不回退旧 binary。
4. 保存 build 后、CLI 前 `git status --short`。
5. 记录 `built-claude` 绝对路径、version、mtime、SHA-256、cwd、terminal size、flags 和非敏感 env。

仅当用户明确要求验证既有制品时可跳过 build，并在报告标明。

## 2. 唯一运行与证据目录

每次运行创建新 session 和新目录，禁止覆盖旧证据：

```bash
repo_root="$(pwd)"
target_name="<validated-feature>"
run_id="<timestamp>-$target_name-<pid>"
evidence_dir="/tmp/tmux-cli-validation/$run_id"
config_dir="/tmp/claude-validation-config/$run_id"
home_dir="/tmp/claude-validation-home/$run_id"
session="cc-$target_name-$run_id"
target="$session:0.0"
mkdir -p "$evidence_dir" "$config_dir" "$home_dir"
printf '%s' "$exact_input" > "$evidence_dir/input.txt"
printf '%s\n' "$target" > "$evidence_dir/pane-target.txt"
```

创建前确认 session 不存在；重名时生成新名称，不通过 `kill-session` 清除未知 session。

## 3. 启动与 readiness

固定 cwd 和 terminal geometry，并正确分隔 argv：

```bash
tmux new-session -d -s "$session" -c "$repo_root" -x 200 -y 60 \
  -e "CC_VALIDATION_REPO_ROOT=$repo_root" \
  -e "CC_VALIDATION_EVIDENCE_DIR=$evidence_dir" \
  -e "CC_VALIDATION_CONFIG_DIR=$config_dir" \
  -e "CC_VALIDATION_HOME=$home_dir" \
  "$repo_root/.claude/skills/claude-agent-workflow-validation/scripts/launch-built-claude.sh"
```

Tmux 只接收 launcher 路径这一个 shell-command；动态参数通过 session environment 提供，launcher 再以固定 argv `exec` binary。每次运行使用独立 writable `HOME`、`CLAUDE_CONFIG_DIR` 和 XDG state。启动前使用已认证的一次性 config fixture，或只读映射最小 auth source；不要把凭证复制到 evidence directory。Tmux 不支持 `new-session -e` 时，生成 `0700` 的 per-run wrapper 并只执行其路径。

启动后使用有最大时限和 poll interval 的脚本检查：

- session 仍存在；
- pane current command/PID 指向目标进程；
- pane 出现可识别 prompt-ready 状态；
- binary 没有提前退出。

Readiness 超时或进程提前退出时保存当前 pane、debug log 和驱动脚本输出，停止该次运行。不得盲目发送输入，也不得借用其他运行的 ready pane。

## 4. 分阶段输入与 pane capture

每个阶段发生时立即 capture，不要在结束后用同一画面伪造四个阶段：

```bash
tmux capture-pane -p -e -S - -t "$session" > "$evidence_dir/01-ready-pane.txt"
tmux send-keys -t "$session" -l -- "$exact_input"
tmux send-keys -t "$session" Enter
tmux capture-pane -p -e -S - -t "$session" > "$evidence_dir/02-submitted-pane.txt"
# 观察到 Agent/Workflow running 后：
tmux capture-pane -p -e -S - -t "$session" > "$evidence_dir/03-running-pane.txt"
# 观察到终态并确认 prompt 恢复后：
tmux capture-pane -p -e -S - -t "$session" > "$evidence_dir/04-terminal-pane.txt"
```

Slash command 必须输入 CLI stdin。保留 raw ANSI history；若另存 normalized 副本，记录转换方式。

## 5. Binary-side 证据隔离

Assistant-side `Agent`、`Workflow`、`Skill`、Task/Run 查询不能证明 binary-side 行为。若误调用：

1. 停止或忽略 parent-side 调用；
2. 将其标记为 `invalid evidence`；
3. 从结果表和 binary-side 统计中排除；
4. 在限制中披露；
5. 不因此中止仍有效的 tmux session。

所有 pane、debug、input、Task ID、Run ID、Agent progress 和 notification 必须来自同一次 tmux 运行。

## 6. 串行、并行与配置隔离

默认串行。仅在两类情况并行：

1. 用户明确要求并行且目标相互独立；
2. 验收对象本身就是并发、隔离或竞态。

并行运行必须分别使用独立 session、evidence directory、input、debug log、marker、Task/Run ID、`HOME`、`CLAUDE_CONFIG_DIR`、settings 和 writable cache/state。Auth 如需共享，应显式记录只读共享边界，不复制或打印凭证。不要把多个目标塞进同一 CLI session。

## 7. Official/local parity

为 `official-claude` 与 `built-claude` 建立独立 session 和 evidence directory，保持 prompt、terminal dimensions、settings、auth state、model env 和影响行为的配置一致。只改变 binary path。官方成功不能替代本地通过。

## 8. Assertion、runtime state 与 verdict

为每个目标列出 assertion、必要 pane/debug/Git 证据和缺失证据时的判定。Binary runtime state 使用 `running | done | failed | stopped`；validation verdict 使用 `passed | running | failed | stopped | not covered`。`done` 只说明 binary 结束，不能在缺少内部 marker 或关联证据时自动升级为 `passed`。

需要验证内部 marker 时，将检索 pattern、执行命令和结果保存为 `debug-marker-search.txt`。

## 9. 终态判定

使用组合证据：

- 稳定 Agent/Workflow 名或 ID；
- `running → done/failed/stopped` 迁移；
- 同次运行的 debug event；
- 父 CLI 恢复可交互；
- pane process/session 状态；
- 必要时无副作用 marker。

需要验证内部 routing、handoff、summary ownership 或 notification 时，debug log 中必须检索到相应 marker。检索不到时只能报告 UI observation 和 `not covered`/限制，不能标记该内部路径 `passed`。Timeout 后进程仍运行则报告 `running`。

## 10. 失败与 retry

Build、启动、readiness、入口解析或证据关联失败后不得继续套用旧证据。不要在同一 session 重复发送同一 slash command。Retry 可使用相同 exact input，但必须创建新的 session、evidence directory 和 config directory，并记录重试原因；旧证据保留，不拼接成功片段。

## 11. 收尾基线与报告

验收结束后保存第三次 `git status --short`，用 CLI 前/CLI 后对照识别非预期 Git 可见改动。记录：

- session/window/pane target；
- binary path/version/mtime/SHA-256；
- exact input；
- binary-side Task/Run ID 和 Agent progress；
- pane/debug/input/driver stdout/stderr 绝对路径；
- `passed | running | failed | stopped | not covered`；
- 覆盖限制与 redactions。

完整 pane/debug 若含 secrets 或 private prompt，只保留本地并报告脱敏摘录和路径。未经用户要求，不删除 session 或证据目录。
