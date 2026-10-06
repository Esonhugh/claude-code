# 用户取消 Agent 后的自动恢复拒绝（2026-10-07）

本批限定普通本地 Agent 的用户停止标记、保存与 SendMessage 自动恢复拒绝。完整 Mods 设计目标仍在进行；本报告不替代 G5、全部变更门禁或完整 API/UI/diff 验收。

## 变更契约与官方依据

- 最新核对 [npm 官方元数据](https://registry.npmjs.org/@anthropic-ai/claude-code/latest) 为 2.1.292，dist shasum 为 ecf88deee4c6b1b099d14a8571f1d5cad2ff1897。
- 官方 binary：`/private/tmp/mods-fork-routing-20261007-2afwted_/official/official-claude-2.1.292`；SHA256 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`。
- 本批证据根：`/private/tmp/mods-stop-mrnctyrx`。`official-source.json` 固定模块路径、字节数、SHA256 和索引片段，仅做静态阅读，没有执行解包后的完整程序。
- Source-confirmed：chunk-m164kzmv 的 X 先检查 running，再区分 stoppedByUser 与普通终态；chunk-cbhx2qdb 的取消分支返回 success:false，不恢复。chunk-h53p3mjv 的共享恢复同时校验元数据和注册前最新 live 状态；chunk-6k255kzr 的 VSe/hoe/fn 只为 user 来源记录与保存停止标记。
- 用户可见契约：两次 `ctrl+x ctrl+k` 确认停止后台 Agent；随后 SendMessage 拒绝，冷进程 `--continue` 后仍拒绝，不产生新的 worker 请求。模型 TaskStop、系统 abort、完成或失败任务保持可恢复。
- 相邻风险：元数据字段/权限、正常恢复、fork 技能权限、根任务计数、前后台移交、嵌套 Agent、完成通知，以及 tool.call 的只读标记。

## 实现与类型

`LocalAgentTaskState` 和 `AgentMetadata` 的 `stoppedByUser?: boolean` 与终态分开；旧元数据缺少该字段仍可恢复。UI 明确的停止入口和 SDK 控制入口设置 user 来源，模型 TaskStop 默认不设置。

元数据按 Agent 排队，在队列内部读取旧文件并更新，再用临时文件原子替换；保留文件权限。后续普通写入保留已记录的取消标记，读者等待正在进行的更新。这样用户停止与原始启动/工作树元数据写入交错时不会丢掉取消标记。现有工作区的串行/原子写入 WIP 在迁移时保留，独立候选带有此功能需要的实现。

SendMessage 对内存中的已取消任务立即返回官方回执；共享恢复对磁盘标记或异步准备期间的用户停止抛出 AgentStoppedByUserError，并在实际注册前再次检查当前状态。原会话直接拒绝和冷恢复异常回执沿用官方各自措辞，不把两者合并。

`[AgentCancellation]` 日志包含完整 ID、user_stopped、message_refused/resume_refused 及 live/metadata 来源；不打印消息正文。持久化失败会记录警告，SDK 停止等待更新时会传播错误；全部文件系统故障组合没有在本批实测。

## 自动化与构建

- RED：candidate-red1 为4pass/6fail。6个用户取消用例缺少来源标记；4个模型/系统停止及正常终态恢复已通过。
- 中间 candidate-green2/candidate-check1 因独立 HEAD 缺少新增原子写入需要的 randomUUID/rename 导入而失败；完整日志保留，补齐真实依赖，没有改弱断言。
- 最终两侧的 test-final1 均59pass/0fail，7文件；adjacent1 均72pass/0fail，6文件；合计各131pass/0fail/0skip。另有 LocalAgentTask.progress 的既有 assert 脚本打印 passed，不额外计入数量。
- 新11个隔离生产模块子进程覆盖 user、raw ID、cold、恢复准备期间取消、SDK stop、bulk stop、后续元数据写入、model stop、system kill、completed 和 failed；没有新增测试专用生产分支或放宽期限。
- 每侧最终 make release-check 与 make build 均exit0；所有最终测试/check/build 的源码清单哈希一致。候选：`4c645948d4bb751acd98e338b7d4e1226c53e679c9d753fe6faee19e8f2e70bb`；ROOT：`c5bfae7032683a746ec920598c849d542f88f25620a5e15f95c61928ec1d5ff0`。
- 完整命令、cwd、隔离环境、120秒上限、退出码、源码前后哈希与进程组清理记录在对应 result.json 和两份 final-validation.json 中。两侧使用隔离 HOME/config/TMPDIR/XDG，测试自带占位 key；不读取个人认证，不调用实际供应商 API。

## 真实终端证据

全部使用160×40私有 tmux、独立配置/UDS/证据根、本机确定性 API 和 cold binary。每场保留字面 stdin/按键、pane/ANSI、PTY、debug、API wire/请求、会话保存以及 owned PGID 清理。每场全局90秒、屏障15秒、API保持60秒；没有增加期限。最终9场均exit0、observed、API关闭、binary未变且没有 owned process group 遗留。

| 场景 | 官方 | 独立候选 | 当前工作区 | 结论 |
| --- | --- | --- | --- | --- |
| 用户快捷键停止，原会话和冷恢复 SendMessage | u-official-o2 | u-candidate-c1 | u-workspace-r1 | 两次不同官方措辞的 success:false 完全一致；元数据 true，零新 worker 请求，公开只读标记 true |
| `/subtask` 完成后同步恢复 | 本批以此前确定的契约作回归 | n-candidate-c1inline | n-workspace-r1inline | 同 ID/历史/模型，保持响应时不提前返回，无重复完成通知 |
| 普通 Agent 完成后同步恢复 | 本批以此前确定的契约作回归 | p-candidate-c1inline | p-workspace-r1inline | 同 ID、普通模型与报告，正常恢复仍可用 |
| 综合相邻入口 | 不冒充本批新增官方对照 | n-candidate-ca3 | n-workspace-ra3 | 并发限额、nested、fork 技能 slash/SkillTool、Ctrl+B、普通后台启动/恢复/通知通过；Workflow仍not covered |

Workflow/WorkflowTool 在两侧综合场景的实际模型工具目录中缺席，真实 stdin 输入已尝试并保存 `WORKFLOW-NOT-EXPOSED`。这两项不计作通过，也没有调用当前助手的 Workflow/Agent 代替。

保留的失败证据：u-official-o1 的 live 拒绝已通过，但冷恢复请求合并历史停止通知后被假 API 驱动误判，没有实际发出 SendMessage；修正识别后整场 o2 从头重跑通过。ca1/ca2 在启动前引用旧 build2 标签而失败，未启动 CLI；精确修正临时 driver 的制品参数后 ca3 与 ra3 从新会话完整通过。失败记录没有删除，没有拼接其成功片段。

## Assertion 边界

| ID | 断言/必要证据 | 证据 | 判定 |
| --- | --- | --- | --- |
| CANCEL-1 | 用户停止独立标记与磁盘保存 | 新11项生产模块回归；u 三场元数据/debug | passed |
| CANCEL-2 | 原会话与冷恢复拒绝，零新 worker | u 三场公开 hook 回执、真实模型 tool_result、API requests | passed |
| CANCEL-3 | 模型/系统停止及正常终态保持恢复 | 新回归与普通/子任务/综合终端场 | passed；真实模型 TaskStop 对照不在本批 |
| CANCEL-4 | 异步恢复准备跨越用户停止不重启 | race 子进程的阻塞读取与注册前检查 | passed，受控生产模块回归；未冒充终端竞态 |
| CANCEL-5 | 构建/源码身份/无用户环境污染 | final-validation.json/final-native.json/提交前后审计 | passed，提交审计另见 postcommit.json |
| CANCEL-6 | SDK control frame、视图 Escape、footer 关闭的完整UI矩阵 | 实际 SDK 来源接线、导航回归和 helper 测试 | not covered：这些入口未分别做官方终端/SDK frame 对照 |

仍待完成：SendMessage 完整目标解析、pin/rebind、resumedAgentId/ownership、observer 与 teammate 取消语义、全文件系统/中断故障矩阵、Workflow、G5、全部改动逐文件/同进程全量门禁、完整 Mods API/类型/上下文/UI/官方 diff viewer。只读 Read/Write/Bash 的已知剩余文本及 Write 前置读取差异也未由本批关闭。全部受保护报告、资产及其他 Claude 进程保留；不 push。
