# SubAgent effort 实现与验收（2026-10-07）

## 实现约定

`Agent` 工具新增可选 `effort` 参数。选择优先级为：

1. 本次工具参数 `effort`。
2. 所选 agent 定义的 `effort`。
3. 调用方当前 `AppState.effortValue`。
4. 现有 `getDefaultEffortForModel` 能解析的调用方模型默认值。

未配置参数和定义时默认继承主 agent；嵌套调用继承直接父 agent。未能解析模型默认值时，沿用 API 默认行为。选择发生在启动时，使用局部定义副本；不会修改父状态或共享定义。`CLAUDE_CODE_EFFORT_LEVEL` 继续在 API 层覆盖所选值，并传递给 tmux teammate。

接受现有 `EffortValue`：`none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`、`ultra`、`ultracode` 和整数。空字符串、未知字符串、`null`、小数、无限值被拒绝；数值 `0` 不视为缺失。省略字段即继承，无须填写 `"inherit"`。不改变 provider 的现有 effort 转换或可用档位规则。

同步/后台子 agent 使用同一选择规则。进程内 teammate 传递到 runner；tmux split-pane 和 separate-window 使用一次 `--effort` 参数。后台元数据记录选择，普通 agent 和进程内 teammate 的恢复路径读取它，即使调用方后来改变 effort 也保留原值。旧元数据没有 effort 时沿用原有继承行为。已有 forked skill 的 effort 作用域优先级保持不变。

## 修改位置

- `src/tools/AgentTool/AgentTool.tsx`：输入 schema、局部 effort 选择、Mods 启动事件传递、启动调试字段、teammate 参数与 worktree 清理后的元数据。
- `src/tools/shared/spawnMultiAgent.ts`、`src/utils/swarm/spawnUtils.ts`、`src/utils/swarm/inProcessRunner.ts`：各后端 effort 选择和参数/环境传递。
- `src/tools/AgentTool/runAgent.ts`、`src/utils/sessionStorage.ts`：后台 effort 元数据。
- `src/tools/AgentTool/resumeAgent.ts`、`src/utils/swarm/resumeInProcessTeammate.ts`：恢复启动时的 effort。
- `src/services/mods/agents.ts`、`runtime.ts`、`toolHost.ts`：内部事件与宿主调用保留并校验 effort。生成的官方 Mods 声明未修改；不将这个 runtime 扩展作为官方 Mods 类型或运行时 parity 结论。
- README 与 CHANGELOG：使用示例、优先级、继承和验收边界。

## 源码检查

证据根目录：`/private/tmp/cc-agent-effort-20261007-tuxMiR`。测试通过 `env -i` 和独立 HOME/config/tmp 运行。

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| `bun test src/tools/AgentTool/AgentTool.nesting.test.ts` | 8 pass / 0 fail | `tests-after.log` |
| 相关九个文件的回归 | 41 pass / 0 fail | `tests-final.log` |
| 补充普通 agent 恢复的 low/0、父状态及定义隔离断言 | 文件级断言通过，exit 0 | `tests-resume-effort.log` |
| 补充 tmux effort 环境转发断言 | 1 pass / 0 fail（上述集合的子集） | `tests-env-effort.log` |
| `bun x tsc --noEmit --pretty false` | exit 0 | `typecheck-final.log`、`typecheck-complete.log` |
| 改动文件 `bun x eslint --quiet ...` | exit 0 | `lint-final.log`、`lint-complete.log` |
| `make build CLAUDE_CODE_BUILD_DIR=/private/tmp/cc-agent-effort-20261007-tuxMiR/build` | exit 0 | `build.log` |
| `git diff --check`、`bun run check:changelog` | exit 0 | `changelog.log` |

九个回归文件为：`spawnMultiAgent.test.ts`、`teammateMetadata.test.ts`、`teammateResume.test.ts`、`runAgent.subagentStop.test.ts`、`resumeAgent.permissionMode.test.ts`、Mods `agents.test.ts` / `toolHost.test.ts`、`effort.test.ts`、SDK `effortSchemas.test.ts`。

最初的隔离回归能复现工具 schema 丢弃 effort、显式参数无法覆盖定义的问题，保留在 `tests-before-isolated.log`。持久化测试还遇到已有测试与当前实现不一致：元数据已写入 model，但精确预期未包含；读取函数已等待在途写入，而测试在持有写入屏障时等待读取，造成死锁。更新了精确元数据预期，并验证原始磁盘 JSON 在写入中仍完整、公开 reader 等待后返回最终值，没有放宽运行时行为。最终相关回归全部通过。

## 真实二进制 tmux 验收

使用新构建的 `built-claude`，通过脚本操作私有 tmux server `cc-effort-tuxMiR`。每组具有独立 HOME/config/cwd/tmp，使用虚拟 API key 和本地 OpenAI Responses SSE 假服务；不请求外部模型。主 agent 模型为 `gpt-main-fixture`，effort 为 `xhigh`；子 agent 显式使用 `gpt-child-fixture`。

| 场景 | 工具/定义配置 | 子请求 `reasoning.effort` | 实际路径 | 原 pane |
| --- | --- | --- | --- | --- |
| 显式参数 | 工具 `low` | `low` | 后台 | `cc-effort-explicit-8795:0.0` |
| 默认继承 | 工具/定义均省略 | `xhigh` | 后台 | `cc-effort-inherit-8795:0.0` |
| 定义默认 | 定义 `medium`，工具省略 | `medium` | 后台 | `cc-effort-definition-8795:0.0` |
| 同步显式参数 | 工具 `low` | `low` | 前台 | `cc-effort-explicit-foreground-final-16722:0.0` |
| 同步定义默认 | 定义 `medium`，工具省略 | `medium` | 前台 | `cc-effort-definition-foreground-final-16722:0.0` |

主 agent 的所有 `gpt-main-fixture` 请求仍为 `xhigh`；每组只有一次匹配该子任务的模型请求。后台 sidecar 分别保存 `low`、`xhigh`、`medium`。启动 debug 中 effort 与请求相符；同步两组还断言 `isAsync: false`。

当前默认 fork 模式会强制后台执行，因此前三组按真实后台路径记录，不能仅凭工具的 `run_in_background: false` 认定前台。同步验收使用 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`，在模块加载前注入。仅在 settings.env 中设置该开关的尝试仍进入后台，其失败证据保留在 `failure-foreground.json`；调整受控启动脚本后两组通过。未改变这项既有后台调度行为。

脚本为 `validate.py` 与 `validate-foreground-final.py`。请求保留在 `provider-requests.json` / `provider-requests-foreground-final.json`，结论在 `results.json` / `results-foreground-final.json`。各场景 `evidence/` 含 `invocation.json`、`target.txt`、输入、ready/submitted/running/terminal pane、debug 日志与启动参数摘要。五组 CLI 均通过 `/exit` 正常退出，原 session/pane 以 remain-on-exit 保留；失败尝试的 CLI 也由后续脚本正常退出。

首次补充验收的自动审批因模型容量不足未执行，重试审批后执行成功；未绕过审批。tmux teammate 两种后端由源码测试验证命令和环境传递，此批真实二进制场景验证普通前台/后台子 agent，没有声称完成真实多 pane teammate 生命周期或外部 provider 可用性验证。

## 产物

- 验收二进制：`/private/tmp/cc-agent-effort-20261007-tuxMiR/build/built-claude`。
- 版本：`2.1.280 (Claude Code)`。
- SHA-256：`820e165eca88260086a62b785edf28fbb46a3ef5a6fe4638750988797afb0900`。
- 已原子更新工作区根目录 `built-claude`，哈希与验收产物一致；更新前核对旧哈希，避免覆盖其他构建。
- 原 Channels 二进制备份：`/private/tmp/cc-agent-effort-20261007-tuxMiR/original-built-claude`，SHA-256 为 `db6ec36ca0cb8e8e2acd35b0a0e33d5cbef759f5d7b40a89f0098ac660ef965f`。

本批没有提交、推送或发布，保留工作区原有 WIP。


## 分功能提交复验

提交时以已提交源码的隔离副本提取两个功能补丁，排除其他 WIP。Channels 独立补丁复验为 22 pass / 0 fail，类型、构建脚本和变更日志检查通过。effort 的 Agent 参数/继承测试为 2 pass / 0 fail，六个相关文件为 38 pass / 0 fail，spawn 文件级断言通过；类型、lint、变更日志检查和隔离构建通过。日志位于 `/private/tmp/cc-feature-commits-20261007-2tog5014`。

该副本的新二进制通过私有 tmux 和本地假服务再次验证 `low` 显式参数、`xhigh` 继承、`medium` 定义默认三组请求，结果为 `runtime/results.json`。二进制位于 `build-candidate/built-claude`，SHA-256 为 `bc8cc657c6315b2a3505903192830ba5fea43bec42677f00ff1e1e194d4f3d86`；未替换先前工作区已验证的二进制。

独立 effort 提交在已有 AgentTool middleware validator 中直接增加 effort 校验。工作区中的共享 validator 重构，以及尚未提交的 teammate identity/retention/resume helper 和相关测试，仍属于其他 WIP；这些文件内的适配继续保留在工作区，不作为本次核心参数提交的依赖。普通后台 agent 的既有恢复入口、进程内 teammate 各轮 effort 和两个 tmux 后端的传递均包含在 effort 提交内。实现阶段的全工作区验证与本节的独立提交验证按各自范围理解。
