# fork 技能 agent 类型对齐（2026-10-07）

本批修复共享技能加载器把 YAML 数字/布尔值误标为 string 的问题。`agent: 42` 过去无法匹配名称为 `"42"` 的代理，实际落入默认代理；现在与官方一样将非 null/undefined 的值转换为字符串。null 和缺失保持未指定。只提交这处生产修复、回归及说明；默认后台路由和 fork 权限持久化/恢复仍由后续批次处理。

证据根：`/private/tmp/mods-fork-routing-20261007-2afwted_`。父提交：`10d29758d494d79627e5cc5d5626dbecc078d767`。独立候选由该 HEAD 克隆，ROOT 原有 278 项 WIP 保留；不 push。

## 官方基准与证据类型

2026-10-07 查询 [官方 npm 元数据](https://registry.npmjs.org/@anthropic-ai/claude-code/latest) 得到 2.1.292。平台包与公共类型包按固定版本下载，SHA-512 integrity 均校验通过；没有安装或执行包脚本。

- Binary-observed：官方 native SHA-256 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`，235017328 bytes；sdk-tools.d.ts SHA-256 `d850d83ecd9e5f92be6e1d98b54b228e68ce0cc32767391f6e20573a4870e024`。身份与包元数据在 official/identity.json、download/ 中。
- Source-confirmed：本地静态提取 2517 个 Bun 模块，其中 138 个压缩模块逐个解压并记录原始/解码哈希，不执行提取代码。extractor SHA-256 `2a45f7df253cbe506d18d8984d62f1d2d3ac36052e7104bbdbd1d274cf5ec48b`；provenance、日志与 module-manifest.json 在 official/ 中。
- Source-confirmed：chunk-pwkr374y.js 的共享技能解析器与插件工厂都使用非 null 的 agent 转 String，缺失/null 返回 undefined。模块 SHA-256 `8b93f8413302c356042d9ae35eefb64605e2eb82432f0c3c24d4d0e29a8d078d`；有界片段与偏移在 official/agent-type-source.json。提取产物只保留本地，不加入仓库。
- Runtime-observed：下述相同脚本的三侧编译 CLI 对照证明实际代理选择、模型、独立身份与保存结果，不仅检查加载器返回值。配置概念参见 [Anthropic skills](https://code.claude.com/docs/en/skills#run-skills-in-a-subagent) 和 [subagents](https://code.claude.com/docs/en/sub-agents)。文档链接不代替本轮二进制证据。

## 修复与 RED

生产改动仅 src/skills/loadSkillsDir.ts 中的一行：去掉无运行时转换的 string 类型断言，按官方规则 String 转换。文件技能、旧 commands 和 MCP builder 共享此解析器；插件工厂此前已对齐，不重复改动。已有 PromptCommand.agent 定义继续为可选 string，不引入新公开字段或依赖。

- candidate-agent-red 初次 0 pass / 4 fail：用户及 MCP builder 复现数字与字符串不相等；项目/旧 commands 两项因 HOME 与 cwd 相同而未发现技能，不能称为产品 RED。
- candidate-agent-green1 为 59 pass / 2 fail：生产修复使用户/MCP 两项通过，项目/旧 commands 仍受同一夹具问题影响。
- 夹具将 HOME 放在独立子目录后，以原生产代码完整重跑 candidate-agent-red2：0 pass / 4 fail，四项均因实际 42 与预期 string 不相等失败。保留旧失败，不弱化断言、增加 skip 或延长时限。
- workspace-red-build 成功；native-workspace-red1 用该本轮制品在首个 `/local-number` 入口选错代理，真实 system/model 断言失败。终端、API 与 owned PGID 清理结果保留。

新增回归使用四个隔离进程，实际读取项目、用户、旧命令文件及已注册 MCP builder。每侧八组字段包括数字、零、两个布尔、null、缺失、字符串及 inline；同时检查来源、参数替换和真实 prepareForkedCommandContext 代理选择。MCP builder 回归不宣称远端服务器权限或原生 MCP 会话覆盖。

## 最终自动化与制品

精确集合：`bun test --no-env-file ./src/skills/loadSkillsDir.forkAgent.test.ts ./src/skills/loadSkillsDir.mcpResourceRoot.test.ts ./src/skills/mcpSkills.test.ts ./src/utils/plugins/loadPluginCommands.fork.test.ts ./src/utils/processUserInput/processSlashCommand.concurrency.test.ts ./src/tools/SkillTool/prompt.test.ts`。

| 验证 | 候选 | ROOT | 证据 |
| --- | --- | --- | --- |
| 6 个相关 Bun 文件 | 61 pass / 0 fail / 28 expect | 61 pass / 0 fail / 28 expect | candidate-agent-final / workspace-agent-final |
| Make build | exit 0 | exit 0 | candidate-build1 / workspace-build1 |
| Make release-check | exit 0 | exit 0 | candidate-check1 / workspace-check1 |

四个新隔离进程包含多条 node:assert；只按 Bun 实际计数报告。每侧测试、构建、检查绑定同一个源码清单 SHA，sourceUnchanged=true、owned PGID 无残留。runner 使用私有 HOME/config/TMP/XDG、不继承个人凭据，120 秒上限未改。CHANGELOG 内嵌源码在最终构建前更新；研究记录和验收账本不参与内嵌链。

| 制品 | 源清单 SHA-256 | binary SHA-256 | bytes |
| --- | --- | --- | --- |
| candidate | `7b1215448c80412107ed3e5658125080381026f96d86b84d2b39ac990f48aef6` | `aa407f16c43858d6a9e34a23f70e9445aa7f483e79f44fe0dbb1210cc61fbccf` | 102051170 |
| workspace | `8f0574d1884859a0328562b4bd7612a166c26d8db28eb7fcd008553ab9b46dd0` | `80467f93cc855cb8d92f433e387c40f0d9a192b266eabb9b72bb4b4fc70dc619` | 101952098 |

Makefile 版本仍为 2.1.280，本批不更改发布版本。完整 path/mtime 在 built-binaries.json；ROOT 原 built-claude 的字节/mtime 保留。

## 真实 fork 入口

native-agent-types.py 使用 160×40 scripted tmux、独立 HOME/配置/虚拟 key、cold compiled binary 和本机确定性 API。sandbox 禁止外网、Keychain 与仓库写入；API 保持未完成时立即保存 running pane，之后完成并检查终态。只清理本场拥有的 PGID。

| 场次 | 会话 ID | API 请求数 | 秒 |
| --- | --- | --- | --- |
| native-official-o2 | 250e2462-d84e-4e35-971b-29397ee56fc7 | 13 | 6.609 |
| native-candidate-c1 | d1f93583-4844-4847-afcc-24878321ef2c | 18 | 5.447 |
| native-workspace-r1 | 9dc50684-c9ef-400b-bf6e-0f148840442c | 18 | 5.551 |

三侧同一 driver SHA-256 `71c066c0ab986cbf88f3e5934373ba97ee8b7a7e79ab138a37a6d390080bd105`。每场五个 slash（项目数字/字符串/null、旧命令数字、用户数字）和两个真实 SkillTool（数字/null）均通过；数值/string 选择 agentType 42、Haiku，null 选择 general-purpose、Sonnet。七个入口与模型字段逐项精确相等；每场七个不同的实际 agent ID、对应 meta.agentType 与已保存 transcript 结果均核对。

同步夹具显式带 background: false；没有后台完成通知、重复 fork 或自有进程遗留。/epoch、正常 /exit=0 与保存账本一致。官方本场成本 0.001015、本地两场 0.00105；辅助请求数量和模型路由仍有差异，不宣称费用或所有 API 字段完整匹配。O1 未加最后的身份断言，保留作早期证据；最终只使用 O2/C1/R1 同脚本完整对照。结果在 native-agent-types-summary.json，原始输入、pane/ANSI/PTY、debug、requests、JSONL、meta 与 driver-used.py 在各场 evidence。

## 相邻入口与边界

native-adjacent.py 在同一批新制品中重验公开 Mod 并发拒绝、普通全局并发拒绝、nested Agent、插件同步 fork 的 slash/SkillTool、Ctrl-B 移交原流、普通后台通知与实际 SendMessage 恢复，并尝试真实 Workflow 工具。

| 场次 | 会话 ID | API 请求数 | Workflow |
| --- | --- | --- | --- |
| native-official-n1 | 4f85d5b2-7259-4899-8000-632f28e4086a | 44 | passed |
| native-candidate-n2 | 8f41feb1-df18-4099-8a0e-e3aaedc36244 | 42 | not covered |
| native-workspace-n3 | 860124a5-1613-4fbe-9af7-53f2c845f6a6 | 42 | not covered |

两场本地工具目录没有 Workflow/WorkflowTool，明确 not covered；官方实际执行一次 Workflow child。其他相邻断言通过，包括拒绝不产生子 API、configured plugin agent/Haiku、移交不重启、恢复保持原 ID/模型、Mod 零普通通知与普通 Agent 一次通知。三场均 /exit=0、账本一致、API 关闭、cold binary 未改、自有进程组已清理；完整 proof 在 native-adjacent-summary.json。不把未暴露的 Workflow 当作通过。

本批仅关闭共享 fork agent 名称解析缺口。默认后台路由/命名、fork 权限范围快照及恢复、同步前台父任务、完整取消/worktree/remote/teammate/MCP/Workflow 组合、G5、同进程全量门禁及完整函数/类型/上下文/UI/官方 diff viewer 继续验收。

## 提交范围与保护

提交只包含共享加载器、新测试、CHANGELOG、README、mods-test 和本研究记录。暂存从干净候选构造精确 patch，不暂存 ROOT 的其他 WIP。原 response.md/improvment.md/fix-instructions.md、289 资产、旧 binary 及无关文件字节与 mtime 均核对；未操作其他 Claude 进程，不 push。README 包含实际用法和官方链接，历史失败不改写为成功。
