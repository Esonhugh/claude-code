# 禁用后台任务时的 SendMessage 同步恢复（2026-10-07）

本批关闭 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` 下提前返回后台回执的缺陷，并对齐同 ID 恢复、报告格式和结果显示。整个 Mods/SendMessage/API/UI/diff 目标仍未完成。

## 契约与源码依据

- 官方 npm latest 本轮复核为 **2.1.292**：[发布元数据](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)。官方用法见 [恢复子 Agent](https://code.claude.com/docs/en/sub-agents#resume-subagents)。
- 官方已提取模块：`chunk-h53p3mjv.js` 的 reply/notification 路由及等待执行；`chunk-cbhx2qdb.js` 的 SendMessage 返回与工具映射；`chunk-h49y0q62.js` 的 UI 文本；`chunk-rpwf9ext.js` 的分段哈希/缩进框架；`chunk-nrxdyhzh.js` 的后台开关。完整绝对路径与 SHA 保存于本批 `source-evidence.json`，提取代码仅保留本地。
- `Source-confirmed`：reply 在后台任务禁用或内置 web-fetch 条件下等待恢复执行，压制 owner 通知，返回 `inlineHandback`，沿用异步 task 的进度与身份。
- 本地本批实现后台任务环境开关条件；web-fetch 的额外身份路由仍需单独迁移。`background:false` 并非该官方额外条件，不能由函数名误推。
- 同步恢复不修改 fork 的父模型继承和普通 Agent 的模型路由。自动恢复与未禁用后台的 SendMessage 保持后台通知路径。
- `inlineHandback` 暴露 `displayName/content/harnessNoteCount/harnessTailCount/harnessSectionHash`。本地当前报告无已生成的独立 harness 前后注释，计数为零；格式器对合法分段进行哈希核验，失效或越界分段按完整模型报告展示，不丢弃文本。

## 复现与修复

- ROOT 改动前的隔离回归为 **1 pass / 6 fail**；六个同步场景均在“恢复仍运行，SendMessage 已返回”断言失败。真实本轮 RED 二进制也在保持恢复 API 响应时发现工具已提前返回。
- 复用共享 `runAsyncAgentLifecycle`，新增可选 owner 通知判定。同步 reply 等待生命周期完成，沿用 task 状态、并发槽、权限与历史恢复；父查询中断会中止该恢复执行。成功、失败与中断都不重复交付后台通知。
- 工具结果按官方框架缩进报告；分段哈希使用 JavaScript UTF-16 字符长度和官方 SHA-256 16 位前缀。所有官方换行分隔符都保留缩进，模型输出中的伪造框架不会出现在列零。
- UI 显示 `Resumed agent <name>. Result:` 和报告。原始 Agent ID 使用官方前七位缩写；具名调用保留名称。`CLAUDE_CODE_HANDBACK_PROVENANCE=0` 保留原始 JSON 报告路径。
- `[AgentResume]` 调试日志包含完整 ID、模型、inline/notification 交付方式及成功交付终态；终端证据另保存对应 ID 的 marker 检索结果。

## 自动化与构建

| 对象 | 检查 | 结果 |
|---|---|---|
| 只含本批修改的候选 | 9 个相关文件 | 71 pass / 0 fail |
| 当前工作区 | 相同 9 文件 | 71 pass / 0 fail |
| 两侧原有 SendMessage routing | 各自单独运行 | 1 个隔离包装测试通过；内层用例见原始日志 |
| 两侧 permissionMode 恢复 | 各自单独运行 | 顶层 assert 脚本完成、退出 0；Bun 注册 0 case，不计为新增用例 |
| 两侧 Make | release-check 与本轮 build2 | 全部退出 0，源码清单在运行前后未变 |
| 官方纯格式函数对照 | 7 个文本/换行案例、8 个分段案例 | 15 案逐字一致，分段哈希一致 |

精确命令、环境、源码清单、超时、退出值与清理记录位于 `/private/tmp/mods-resume-inline-r_wuly21/<label>/result.json` 和 `log.txt`。新增测试隔离 HOME/config/tmp，使用占位认证，不继承真实 API key/OAuth，不删除、跳过或放宽断言。

早期候选错误均保留：错误的 env 模块导入、控制字符正则的 lint 提示、空文本被构造器替换为 `(no content)` 的夹具、将不存在的 result.resolvedModel 当作模型证据，以及官方普通 worker 请求包含系统提示导致的识别错误。修正后使用新的标签/终端重新验证；未把失败片段混入最终证据。

## 本轮真实终端矩阵

每次均为独立 tmux、冷复制制品、临时配置及本机受控 API。使用真实 stdin/Agent/SendMessage/Mods 入口，保存 pane、原始 PTY、请求、debug、session 与费用状态。恢复响应保持未放行时检查工具不得提前返回；放行后核对结果与清理。

| 流程 | 官方 | 候选 | 工作区 |
|---|---|---|---|
| /subtask 完成后 SendMessage 同步恢复 | n-official-o2inline | n-candidate-c2inline | n-workspace-r2inline |
| 普通 Agent 前台完成后同步恢复 | p-official-o4inline | p-candidate-c2inline | p-workspace-r2inline |
| 默认后台恢复与唯一完成通知 | n-official-o1default | n-candidate-c2default | n-workspace-r2default |
| nested Agent、fork slash/SkillTool、前后台切换、普通恢复 | 本批不新增官方此行 | n-candidate-ca2 | n-workspace-ra2 |

以上 **11 次运行**终态均为 `observed`，退出 0；没有遗留自身进程组，API 已关闭，二进制未变。Workflow 实际入口尝试得到模型工具目录未暴露 Workflow/WorkflowTool，分别为 **not covered**，不计成 Workflow 通过。失败/中断、分段异常和关闭框架开关本批由隔离自动化覆盖，未冒充普通终端故障验证。

核心 assertions：

| ID | Predicate / 必要证据 | 本批证据与 verdict |
|---|---|---|
| R1 | inline 工具等待被恢复 API 流完成 | 六侧 inline held pane、请求/工具结果屏障及隔离回归：passed |
| R2 | 同 ID，fork 主模型/普通 Haiku，恢复历史不丢失 | BOUND_TURN ID、API model/messages、公开结果与回归：passed |
| R3 | inline 不重复通知，默认后台恰好一次通知 | 本次会话 root transcript、debug、task/queue 回归：passed |
| R4 | 公开 inline 内容、分段计数/哈希与工具格式文本一致 | 三侧公开 tool.call 探针及官方纯函数对照：passed |
| R5 | 七位原始 ID、报告 UI、父会话可继续并正常退出 | 本次 terminal pane、后续无副作用 marker、exit/session：passed |
| R6 | 共享生命周期相邻消费者不回归 | 两侧 nested/skill/Ctrl+B/恢复终端与 owner/concurrency 回归：passed；Workflow not covered |

每条的实际 session、pane/debug/input 路径、二进制 SHA/mtime/字节数、源码 SHA、断言和结果保存于本批 `validation-summary.json`；无需依赖旧制品补足结果。Make 版本仍是 2.1.280，本批为未发布源码对齐，不声称本地制品就是官方 2.1.292。

## 仍需继续的差异

- `Binary-observed`：官方 SendMessage 的公开 result 含 `pin`，外层 tool.call 含 `isReadOnly:true`；两侧本地本轮均缺少这两个字段。这里的 inline 五字段与 public text 相同，不能据此宣称整个公开返回类型一致。
- `Binary-observed`：官方 public tool.call 的格式文本与本地逐字相同；发送给 API 的该 text 还多一个末尾换行，本地未添加。完整 wire 文本一致仍未达到，不伪称缓存命中或所有请求字节一致。
- 共享报告的指令扫描、生成 harness 注释、pin/目标解析、用户取消后的恢复规则、内置 web-fetch 特殊恢复、完整冷启动/子任务等待关系仍需分别闭合。
- 默认 `/fork` 独立后台会话、agent view 映射、完整任务 UI、Workflow、G5、全量 suite 与整体 Mods API/UI/diff 目标继续；本批不是完整兼容声明。

## 工作区保护

开始时记录 HEAD `2628df519705ec90b43a29d79197aeba0a31cfbd`、空 index、278 条既有未提交状态及文件 SHA/mtime。实现只覆盖本批 delta，SendMessage 的其他 Claude 修改保留；候选基于 clean HEAD 单独验证。ROOT 的旧 `built-claude`、response.md、fix-instructions.md、improvment.md 和旧 diff 制品保持原字节与时间。提交前使用候选 patch 的反向副本核对原始 WIP；签名与提交范围核验保存在本批 `postcommit.json`。
