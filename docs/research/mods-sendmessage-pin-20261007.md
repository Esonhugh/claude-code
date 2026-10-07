# SendMessage 目标绑定、pin 与恢复契约研究（2026-10-07）

本批先保留实现前 RED，再补齐本会话子 Agent 的 pin、目标确认、历史恢复与同步名称登记。下表最初的本地失败属于基线；最终验收见末节。跨会话解析及整体 Mods 目标仍未完成。

## 固定证据与基线

- 开始时 HEAD 为 `8e570f5d4440479292faf15fe13ba28630305612`，暂存区为空，原有278项 WIP 不变。
- 证据根：`/private/tmp/mods-pin-ee3qwifg`。重新核对 [官方 npm 元数据](https://registry.npmjs.org/@anthropic-ai/claude-code/latest) 仍为2.1.292，dist shasum `ecf88deee4c6b1b099d14a8571f1d5cad2ff1897`。
- 官方 binary：`/private/tmp/mods-fork-routing-20261007-2afwted_/official/official-claude-2.1.292`，SHA256 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`。
- 本轮独立HEAD候选与当前工作区各重新 make build，均exit0、源码未变。baseline build源码清单SHA分别为 `4c645948d4bb751acd98e338b7d4e1226c53e679c9d753fe6faee19e8f2e70bb`、`c5bfae7032683a746ec920598c849d542f88f25620a5e15f95c61928ec1d5ff0`。候选后来新增RED测试的清单不同，不能混称为已构建/通过的修复候选。

## 真实终端差异

`native-pin.py` 通过实际 stdin 的 Mods 命令调用 `$.agent.spawn` 启动两个同名、不同ID的后台 Agent，两个真实 worker API 响应保持未放行；再调用公开 `$.tool.call({tool:'SendMessage',...})`。两侧均160×40私有tmux、隔离HOME/config/UDS、dummy key、本机确定性API及cold binary。退出前通过两次用户停止快捷键停止本场自建任务，检查两个元数据标记，正常退出并清理 owned PGID。

| 步骤 | 官方 q-official-o2 | 当前工作区 q-workspace-r1 | 本地判定 |
| --- | --- | --- | --- |
| 首次向 pin-target 发消息 | success:true；pin为A的ID、名称和ref | success:true；无pin | failed：缺少身份回执和保存 |
| 名称换绑至B后，继续发裸名 | success:false；要求确认，未发送 | success:true；队列投递到新的B | failed：缺少换绑护栏 |
| 明确 pin-target [B-ref] | success:true；pin更新为B | Unknown recipient，success:false | failed：本地Agent ref寻址缺失 |
| 确认后再次发裸名 | success:true；继续返回B的pin | success:true；仍无pin | 同一身份绑定尚未实现 |
| 用旧A原始Agent ID寻址 | success:true；pin.name为原始ID，ref与A一致 | success:true；无pin | 原始ID能投递，但身份回执缺失 |

两场driver均exit0、observed、API关闭、binary不变、无owned process group遗留；工作区行另有 `parityVerdict: not aligned`。成功清理不改变上表三个失败。完整公开hook输入/回执、作者调用结果、字面stdin、pane/ANSI/PTY、debug、API请求与停止元数据在各场evidence下。未把本地模型服务替换成真实供应商请求。

首次官方 q-official-o1 的五项行为断言均成立，但仍保持中的Agent让 `/exit` 弹出退出确认，5秒退出屏障失败；日志保留。修正驱动的正常停止流程后o2整场重跑，没有增加期限或拼接成功片段。

## 官方源码契约

对应提取模块均在固定版本 extract-292/all 下；`pin-oracle.json` 记录SHA256。仅受控执行提取的函数，未执行完整解包程序。

- `chunk-8hjj56g8` 的 Wr：NFKC、移除非空白控制/格式/孤立代理字符、trim/lowercase、连续空白变连字符。b6接受名称后的6到12位小写十六进制ref。
- nqe/R/an：`sha256(kind + ':' + id)`取前12位作为身份指纹，常规pin ref取前6位。候选列表xe会按指纹冲突延长展示ref；解析器me匹配列表上的实际ref，不能擅自把任意更长哈希前缀当成有效确认。
- `chunk-m164kzmv` 的 dDt：主会话、原始ID、精确队友/注册名称优先；再做规范化匹配、明确ref、全候选索引与最少3字符的前缀匹配。in-process候选优先，歧义、查询不完整、名称复用、远程身份声明都参与结果，不能只靠Map.get或远程peer解析。
- `chunk-anjw0kd1` 的 aOo/O：普通live/stopped/evicted子Agent参与pin，structured/main/mailbox/user-stopped等分支不参与。读取绑定使用Object.hasOwn。同一ID返回原绑定；新绑定先由生命周期服务保存，再执行投递/恢复；这与“只在投递成功后保存”不同。
- 裸名换绑通常返回rebound；明确ref才能更新。规范化名称相同但输入恰好是新的不同字面名称时，有一个proceed且不返回/改写旧pin的分支，不能简单把所有case变体都拒绝。
- pin类型为 `{id, name, ref}`；恢复schema要求success:true、name长度1到200、id为合法Agent ID且长度不超过1024、ref符合6到12位小写hex。
- tOr只从真实assistant SendMessage tool_use及相匹配的非error user tool_result恢复，使用该user消息的 `toolUseResult` 元数据；不是从wire JSON文本猜测，也不是从任意带pin对象恢复。后来的有效绑定覆盖前面的同名绑定。
- `chunk-e0nsmd4r` 的生命周期服务拥有setSendMessagePin；`chunk-8q7p93rh` 会话rehydration使用lOo，切换/恢复先清空再重建；`chunk-jjy8yg8v` print入口也从历史恢复；`chunk-30y37pmc` clear/branch状态清空pins。这些是同一契约的必要消费者。
- `chunk-cbhx2qdb` 的模型格式化器从数据移除display和inlineHandback；普通JSON保留pin，禁用来源框架的inline JSON也保留pin，默认framed inline报告只保留success/message头。因此不能为了“补字段”把pin硬塞进默认模型报告头，公开hook回执仍含pin。

## 可复跑oracle与RED

`oracle.mjs` 受控提取 Wr/b6/R/an/tE/mst/aOo/O/tOr/lOo/nqe，依赖注入只用于不会执行真实云查询的固定候选和声明校验。24项断言通过，提取函数集合SHA256 `eab397762bb976fa17d79290a14945ae51fbff7d7aaa7c08b40d2dec42916891`。这验证官方函数契约，不是本地实现通过。

覆盖新/重复/evicted绑定、structured/user-stopped/mailbox排除、裸名/前缀换绑、ref确认、不同字面名称、Unicode规范化/ref语法，以及成功元数据恢复、拒绝/错误/错误tool/不匹配ID/非法pin/wire字符串拒绝、历史最后绑定覆盖。第一次提取遗漏nqe依赖的错误已保留，补齐实际原函数后执行成功。

独立候选中新增 `src/tools/SendMessageTool/SendMessageTool.pin.test.ts`，通过隔离生产模块调用复现live receipt、rebound拒绝且B队列不应变化、ref确认与后续裸名稳定绑定。`candidate-pin-red1` 为0pass/3fail、exit1，配置/进程组清理成功。此失败测试暂留私有候选，未迁入用户工作区，也未提交。

另观察到同一场作者调用的额外差异：官方最终作者回执不含hook内ref，而当前本地仍返回ref；官方tool.call hook输入还补出SendMessage summary。内部ref所属层和coerceInput生产点尚需沿client/author边界追踪，不能只在host删除ref或随意补摘要后宣称对齐。

## 实现范围与剩余边界

本批实现连接：目标解析/规范化/ref及歧义，类型和session pins状态，pin guard与投递/恢复数据，模型格式化的三种分支，成功toolUseResult历史恢复，REPL/print/clear/branch/切换消费者，以及真实普通/nested/fork/teammate相邻流程。已有用户取消规则和只读标记必须保留。

下节的新 probe 已补真实模型 SendMessage 的冷恢复、fork/clear 和 print；实现前的作者调用不替代这些证据。被 hook 改写回执后的历史恢复、真实 MessageSelector 回退手势及完整目标注册策略仍需专项验证。跨本机/云/bridge身份、所有操作UI、Workflow、G5、全量门禁与整体Mods API/UI/diff目标继续，用户明确的Privacy Mode例外仍单独保留。

## 实现与最终验收

新增 `src/utils/sendMessagePins.ts` 管理规范化、准确 ref、本会话具名/原始 ID/唯一前缀解析、绑定护栏和成功回执恢复。AppState 的两处默认初始化均含 sendMessagePins；SendMessage 在执行前保存身份，拒绝换绑时不入队，成功时带 pin。异步子调用通过 root task writer 保存绑定，用户取消分支保持无 pin 回执。终端消费 display，模型格式化移除它，默认 framed inline 头继续省略 pin。

`sessionRestore` 连接交互恢复和 CLI 恢复/分支；REPL 和 print 的直接初始历史也恢复绑定；clear 清空 pins 并保留活跃任务名称；REPL 回退从保留消息重建。官方原始 ID 恢复 schema、成功 metadata 过滤与最后有效绑定优先规则均有生产 helper 回归。

真实 print 对照发现原实现只登记后台 Agent 名称：同步 Agent 完成后发送裸名返回 Unknown recipient，无法执行 guard。补齐同步登记，使用现有 root lifecycle writer；即使 foreground task 已移出内存，名称仍可定位到磁盘恢复目标。新测试分别覆盖后台能力启用/禁用，固定普通 Agent 同步前提（fork 强制后台关闭、定义 background:false、run_in_background:false），不增加生产测试开关。

候选基于固定 HEAD，工作区保留已有 WIP；最终两侧各 **143 pass / 0 fail / 0 skip，15 files**，每侧 make release-check 和 make build 均 exit0。测试、check、build 共用各侧最终清单 SHA：

- 候选：`eddd1385c4ed7a420c37c758831e4d91fc0f9366586e07b32b56e751f0e3e52d`。
- 工作区：`66121b8df5d85938b89c61520d552ebf492bc94d20e7e432a1310b9beaa717d6`。

源码在每场期间不变，各 runner 的 owned PGID 均结束；完整清单见 final-verification.json。

| 断言与入口 | 官方 | 最终候选 | 最终工作区 | 判定 |
| --- | --- | --- | --- | --- |
| 实际 Mods spawn/call：首次 pin、裸名换绑拒绝、ref 确认、重复 pin、旧 raw ID | q-official-o10 | q-candidate-c7 | q-workspace-r4 | passed |
| 实际模型：成功 pin 写入 toolUseResult；正常退出后恢复会话再换绑拒绝 | h-official-o9 | h-candidate-c7 | h-workspace-r4 | passed |
| 模型用 ref 确认新目标；wire 结果无 display；终端显示专属拒绝提示 | 同上 | 同上 | 同上 | passed |
| /clear 更换会话 ID、清空 pin，运行中 B 的名称继续使用并重新绑定 | 同上 | 同上 | 同上 | passed |
| --resume + --fork-session 新 ID 按完整历史恢复最后的 B 绑定 | 同上 | 同上 | 同上 | passed |
| -p + --resume-session-at 按截取历史恢复 A pin，同步 D 名称登记后拒绝换绑 | 同上 | 同上 | 同上 | passed：直接模型工具路径 |
| 相邻 nested Agent、fork skill、默认后台、Ctrl+B 移交和 SendMessage | 本场未重跑官方 | n-candidate-c7 | n-workspace-r4 | passed：本地相邻回归 |
| 普通 Agent 禁用后台后的 inline 恢复、同 ID、回执和无重复通知 | 本场未重跑官方 | p-candidate-c7inline | p-workspace-r4inline | passed：本地相邻回归 |

以上共10场完整 native run，均正常终态、binary 不变、API关闭、无owned PGID遗留。历史场景在 seed 成功 pin 保存后用真实用户快捷键停止本场保持中的 A；不会把停止后的拒绝误当首次 pin 成功。ref/clear 两阶段 B 仍保持未放行。print 直接核对模型实际收到的 SendMessage tool_result；两侧本地 `printHookObserved:false`，官方 true，因此不能宣称 Mods print hook 的接入已对齐。交互 fork 不使用仅对 print 生效的 resume-session-at；原会话的完整历史最后 pin 为 B，print 截取到 seed 后的最后 pin 为 A。

保留的失败与修正：官方历史 o3 的全 turn 日志被官方 tokens 脱敏成非 JSON，改为只记录 agentId/answer/reason；o4 的 worker 标记误判了主会话通知，修为独立完整 prompt 标记并以用户停止结束保持任务；o5 将 tool_result 多个 text block 合并后当单个 JSON，修为解析实际 JSON 头并检查 display；o6 假定 clear 前后同 ID 只有一份 metadata，改为检查该 ID 的实际取消记录；o7 给交互 fork 使用了 print 专属截断参数，按真实入口区分完整和截取历史。候选 q-c2 调用了 HEAD 不支持的 public spawn background 字段，改为三侧支持的默认背景输入；h-c4 未找到 HEAD print hook，最终改为核对真实模型工具结果并独立记录 hook 接入；h-c5/工作区h-r3 暴露同步名称登记缺口，修复生产代码后全场重跑。单测 tests2/tests3 的同步 fixture 未关闭 fork 强制后台前提，断言失败保留，补齐明确 fixture 模式后最终143项全量重跑。首轮 check1 指出主入口初始化字段和不完整消息 fixture 的类型问题，均修复并重新通过检查。

仍未覆盖：真实回退手势和所有逐帧 UI 状态、hook 改写 pin 的历史恢复、完整名字注册/保留策略、跨会话/云/bridge 的统一身份解析、所有 resolver 歧义/不可用来源、Mods print hook 接入、Workflow、G5、完整官方 diff 与全部变更的整体验收。仅完成本批本会话子 Agent 绑定，不将整体目标标记 complete。
