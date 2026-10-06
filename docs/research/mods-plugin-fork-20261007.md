# 插件 fork 技能入口对齐（2026-10-07）

## 本批结论

插件的 `SKILL.md`、旧 `commands/*.md` 与 manifest 自定义技能路径此前丢失 `context` 和 `agent`：即使作者声明 fork，运行时仍把技能展开到主会话。本批在插件工厂保留这两个字段，让 slash 与模型的 SkillTool 调用使用已有隔离执行器及指定 agent。

本批运行显式声明 `background: false`。本地当前入口始终同步；官方默认后台路由、其权限范围持久化/恢复和父子任务等待/续跑仍是未完成项。不能从本批同步成功推导全部 Mods、UI 或 diff viewer 已匹配。

## 官方依据与类型

- 2026-10-07 重查 npm `latest` 为 2.1.291；对照使用真实编译 CLI，未执行提取的 JS 代替 CLI。
- 官方二进制 SHA-256：`9a1d2ed6bb4421e8fc80c892c0413f293be3ee50ae3d7dda1a7622197a056690`，233211568 bytes。
- 原始插件工厂 `chunk-v1gtm86q.js` SHA-256：`5b96cbe6aa3e77b2dd1f8ccbe557dd0bb41c322cd63c1bc8f863a039879678db`，offset 956053 附近分别使用精确 `context === "fork"` 和非空 `String(agent)`。完整来源、偏移和限定片段保存在证据根 `official-plugin-fork-source.json`。
- 本地 `PromptCommand` 已定义 `context?: 'inline' | 'fork'` 和 `agent?: string`，工厂返回值继续通过 `satisfies Command` 检查，不新增公共作者 API 或 d.ts 字段。
- `context: inline`、缺省或大小写不符的值保持无 fork 标记；非空 agent 转为字符串，null/缺省保持未指定。测试保留数字字符串化与 null 案例；没有扩大 context 枚举。
- 使用方法见 [README](../../README.md)；配置含义参考 [Anthropic 官方 skills 文档](https://code.claude.com/docs/en/skills#run-skills-in-a-subagent)。文档说明上下文隔离，最新具体路由仍以固定 CLI 的运行结果核实。

## RED 与 Bun 回归

证据根：`/private/tmp/mods-fork-background-20261007-jzycztn8`。候选基于父提交 `dd0fe4957c73139b593ec64a705754e1d69b1a96`，使用仓库既有依赖。

- `candidate-plugin-red`：真实插件文件发现的 4 个隔离进程全部失败，直接复现 context/agent 丢失；无网络和真实 key。
- `native-workspace-red1`：本轮修改前重新 Make 构建 ROOT，以实际 slash 输入复现 `Plugin fork did not select its configured agent`。原断言未删改。
- `candidate-plugin-green`：41 pass / 0 fail / 0 skip，5 文件，184 expect。
- `workspace-plugin-green`：42 pass / 0 fail / 0 skip，5 文件，185 expect；当前工作区的既有 Mod 命令测试比干净 HEAD 多一例，未作为本批修改提交。
- 新测试通过真实 `--plugin-dir` 对应的公共发现路径加载临时 manifest、默认技能、旧 commands 和自定义 skills 路径；同时核对参数/插件路径替换以及 inline/无效 context。测试不 mock 文件加载器、技能工厂或执行路由。
- 相邻检查包括同步 slash/SkillTool 名额与身份、MCP 资源根、SkillTool prompt 和 Mod 命令投影；隔离 child 防止全局配置/loader cache 污染同进程其他测试。

## Make 与编译身份

- 两侧 `make build` 和最终 `make release-check` 均 exit 0，未升级依赖、绕过 hook、增加期限或引入新 skip。
- 首次发布检查只因本批 README EOF 空行失败；修正后保留原检查并完整重跑，记录在 `candidate-check2` / `workspace-check2`。运行时源码未再修改。
- 候选最终源码清单 SHA-256：`371b78ad0d2db50a4ca5aa89badd9d6edbfa6ba68530d9f15ba50723d0152605`；binary SHA-256：`a605cded88931090c7c75c5f2e96302beb2989c4a0f17384620ed7cb738e6940`。
- ROOT 最终源码清单 SHA-256：`8e440c0e7055fc3ee9507bb440bef19de6abfb4c2f5c3c402c955ce1fd2c12f8`；binary SHA-256：`6ac6150e7034d1c0ea7ca7c4bbe9868e287b985dc597a3b67f5ac6b91d95bfd2`。
- 清单覆盖 CHANGELOG 与 src/types/vendor/scripts/assets；README/研究记录不在构建清单中。各次运行另保存完整文件清单、二进制 bytes/mtime、argv、环境和 driver SHA-256。
- 本地 Make 版本仍为 2.1.280；本批对照目标为官方 2.1.291，没有用版本号变更替代行为验收。

## 原生入口结果

三场使用完全相同的 `native-plugin-fork.py`，driver SHA-256 `563147943c5f830eba4cec2278d0ccb4702abe40228e59cccd36a5477acac813`。固定 160×40 私有 tmux、独立 HOME/config/TMP/XDG、一次性测试 key 和本机确定性 API；sandbox 拒绝外部网络、个人 Claude 配置/Keychain 和仓库写入。按官方、候选、ROOT 串行运行，只清理各自创建的进程组。

| 场次 | session | 两个 fork 入口 | API 请求数 | 终态 |
| --- | --- | --- | --- | --- |
| native-official-p1 | 06e12ec1-a2a1-4d7c-ac9e-4c2e04e7d9a2 | 2 / Haiku / 指定插件 agent | 34 | exit 0；无自有进程残留 |
| native-candidate-c1 | e2c65705-816f-4405-a220-523cf3b47a30 | 2 / Haiku / 指定插件 agent | 33 | exit 0；无自有进程残留 |
| native-workspace-r1 | 0eb94568-5526-4ca2-8283-0e1acf19da00 | 2 / Haiku / 指定插件 agent | 33 | exit 0；无自有进程残留 |

每场实际输入 `/canonical-root-native:cap-fork`；另一个主模型请求真实调用 SkillTool，而非从 Mod 直接调用内部执行器。配置选择 `canonical-root-native:fork-worker`，其系统提示具有独立 marker，agent 模型为 Haiku。两次 fork 的实际请求都含该 marker 并使用 Haiku，metadata 的 agentType 均匹配配置，公开 turn.complete 的两个 ID 独立且与 metadata 文件匹配。

- slash 在另一 Mod 子任务占用一个普通名额时成功运行，其内部 Agent leaf 接受并只执行一次；fork worker 自身不额外消耗普通 Agent 名额。
- SkillTool 返回 `completed (forked execution)` 及 `FORKED-DONE`，父模型随后输出 `SKILL-PARENT-DONE`。
- 相邻实际入口涵盖 Mod 插件限额/全局拒绝、普通与嵌套 Agent、前台 Ctrl-B 移交、普通后台完成通知。Mod 完成通知为 0，普通控制任务通知为 1，未产生重复执行或残留 owned PGID。
- 每场 `/exit` 实际 pane_dead/pane_dead_status 为 `1 0`；公共 session ID、启动时间、cost 与正常退出保存的项目/模型分项一致，API 已关闭且 cold binary 不变。
- 官方费用 0.0030500000000000015，本地两场约 0.002385000000000001；辅助模型调用与 token-reminder/metadata 字段仍有差异，不能声称完整请求、费用、类型或上下文已逐项一致。原始请求与 meta 保留供下一批分析。
- 保留 pane、ANSI、PTY、debug、字面输入、API 请求、JSONL、meta、成本及退出状态。汇总和身份核对见 `native-summary.json`。

## 默认后台路径的独立发现

同一证据根的另一个 `native-background-skill.py` 在官方 `native-official-o4` 完整通过（10 个 API 请求，exit 0）。它不声明 background 字段，并在父/子模型 API 分别暂停：

1. 初始 fork API 尚未完成时，CLI 已回执 `Running in the background as @cap-fork`，公共 agent.list 返回运行任务及名称。
2. 普通 Agent 在全局 limit=1 时仍能启动，证明初始技能 worker 未占普通 Agent 名额。
3. fork 的第一轮模型已结束、自己的后台 leaf 仍未完成时，公共 agent.list 显示父任务 `waiting`；主会话尚未收到父任务完成通知。
4. leaf 完成后，父任务自动接收子任务通知并再次调用模型，得到 `FORK-AFTER-CHILD-DONE`；随后才向主会话发送一次最终完成通知。

`native-workspace-red2` 使用本轮修改前的新 ROOT binary 失败于后台启动回执，本地仍同步。该缺口未因插件字段修复而关闭。不能以简单异步包装代替官方父子生命周期。

早期官方 o1 的夹具把第一次流结束误判为最终通知；o2 的 held barrier 依赖释放后才记录的 forkLeaf 标志；o3 把公共等待状态错设为 running。修正夹具后另开 o4 全程完成，未增大期限或拼接失败场次。本批保留全部原始失败与 driver；官方路由及恢复拒绝的静态片段见 `official-background-skill-source.json`。

## 提交边界与剩余目标

仅提交插件工厂的 context/agent 字段、真实文件回归及本批 README/CHANGELOG/mods-test/研究记录。原 278 个 WIP、ROOT 旧 built-claude、289 资产及 response/improvment/fix-instructions 的原内容/mtime 保留；不操作其他 Claude 进程，不 push。

默认后台/禁用回退、任务命名和恢复权限范围、递归技能保护、完整 Workflow/恢复/故障矩阵、G5、全部函数/类型/上下文/UI/官方 diff viewer 和同进程全量验收仍待完成。此前 Workflow 相邻基线失败仍保持待处理状态，见 [同步 fork 专项](mods-fork-capacity-20261007.md)；本批不修改共享 Agent 生命周期，也不把定向成功提升为全量通过。
