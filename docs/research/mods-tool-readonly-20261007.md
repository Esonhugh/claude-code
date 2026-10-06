# Mods tool.call 只读标记（2026-10-07）

本批修复核心执行没有返回 `isReadOnly`，以及跨插件传递时标记可被伪造或错误继承的缺口。该字段被官方 diff mod 用来决定是否刷新文件变更；完整 Mods/UI/diff 目标仍未完成。

## 契约与依据

- 本轮 npm latest 复核为 2.1.292：[官方发布元数据](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)。[官方 Mods reference](https://code.claude.com/docs/en/plugins/mods/reference) 明确应优先使用安装版本的声明。
- Source-confirmed：已提取的 `chunk-pwkr374y.js` 在权限/经典 hook 改写后、真实 tool.call 前检查实际输入，将结果记录到本次执行；执行后回执只在检查为真时附加标记。拒绝或输入校验提前返回不带标记，执行中的错误可带标记。
- Source-confirmed：`chunk-r9hj3tk2.js` 的 Un/Na 在离开一个插件时去掉它声称的标记，只有插件外下游 next 回执的同一个 ref 和相同结果才恢复它；结果比较允许排序后的 JSON 等价，适用于 catch、结果复制和多次 next。
- Source-confirmed：`chunk-fh33yjpm.js` 的作者操作最终处理函数 et 从 $.tool.call 回执移除标记。安装的声明复用较宽的 ToolCallResult，不能仅按类型推断这个运行时边界。
- Source-confirmed：`chunk-01whafa0.js` 的官方 diff 判定 Zs 仅把非 deny 且未标记只读的结果视为可能需要刷新；标记描述当前调用，不是由它启动的子工具。

## 修复与回归设计

- 19 项新回归在 clean HEAD 候选及 ROOT 上最初均为 3 pass / 16 fail。初版权限夹具未请求权限决策，修正为 ask 后重新复现；没有削弱原断言。
- 执行记录在真实调用前记下工具自己的判定；adapter 输出该事实；dispatcher 在插件的 normal/catch/fallback 返回边界做引用校验；作者 host 的最终回执去掉字段。
- 三个旧夹具补齐 Tool 的必需方法，不在生产代码添加测试专用分支。经典 hook 相邻回归初次发现缺失方法导致 8 fail，补齐基础夹具后通过。循环对象通过保留规范化对象身份及时拒绝，不原地修改被冻结回执。

## 验证与证据

完整证据根：`/private/tmp/mods-ro-w3vv6ytt`，汇总为该目录的 `validation-summary.json`。

- 最终相关回归：候选 **234 pass / 0 fail / 2 skip**，ROOT **252 pass / 0 fail / 2 skip**，均为实际七个文件；其中本批新增 **22** 项。两项 skip 是原有可选官方 native fixture 分支，未新增或放宽 skip；不能把它们计为通过。
- 候选与 ROOT 的 `make release-check`、本轮 `make build` 均 exit 0。每侧最终 tests/check/build 的全源码 manifest 分别一致，候选 `7913cffaae915c1180427aaf5b0fb8effe0e148d3f59a0b1dffbf095f48a074b`，ROOT `ff929d4c33480208ae693fff24b9cd3104e082eb1bb8f54c17cb1f1894cace23`。制品放在私有 build2 目录，未使用或覆盖旧 ROOT built-claude；Make 版本仍为 2.1.280。
- 对官方提取的纯函数执行 **20** 个独立边界输入，对象键序、冻结值、重复引用、循环值和 bigint 等的字段/标记结果与本地一致；不把该计数混入 Bun 回归数。
- 本轮最终 **12 场**原生交互通过：`n-official-o9readonly/o10same`、`n-candidate-c3readonly/c3same`、`n-workspace-r3readonly/r3same`，以及两侧 `n-*-c3inline/r3inline`、`p-*-c3inline/r3inline`、`n-candidate-ca3`、`n-workspace-ra3`。前六场各真实触发十种工具/改写场景及一个作者调用，对比同插件内部原始回执和跨插件处理后的字段；同一文件明确 Read→Write 后，Bash 实际写入与 diff 的 changed content 均核对。后六场回归普通 Agent、subtask、同 ID 恢复、nested、fork skill 与 Ctrl+B；四场恢复公开回执均打印 isReadOnly:true。
- 全部目标在独立 160×40 tmux、隔离 HOME/config、占位 key、本地确定性 API 中串行运行；cold 二进制字节未改变，正常 exit 0、公共 session/成本与保存记录一致，无自有进程组残留。未调用真实 Anthropic API。Workflow 在相邻实际模型工具目录中未暴露，记为 not covered。

| Assertion | 证据 | Verdict |
|---|---|---|
| RO1 实际获准参数决定标记，包含改写和执行错误 | 新回归、原生 Read/Bash/core probes | passed |
| RO2 同插件内部与跨插件边界行为匹配 | 两类六场官方/候选/ROOT probes、20 个纯函数输入 | passed |
| RO3 作者回执移除标记，下游观察仍有 | 每场 RO_AUTHOR/RO_OUTER 与实际 host 回归 | passed |
| RO4 实际写入和官方 diff 基本内容可见 | 文件字节断言、diff-visible-result pane/debug | passed |
| RO5 受影响 Agent/恢复/相邻流程无重复交付或进程残留 | 六场同批新二进制的输入/pane/debug/终态 | passed；Workflow not covered |

所有尝试保留：早期观察者和改写者位于同一插件，看到的是内部原始结果，不能当作跨插件处理后结果；独立文件复验排除了读取缓存推测。随后拆为独立插件，确认了准确边界。缺文件 Read 是真实调用抛错，所以仍带只读标记；diff 写入后已自动打开，首次 /diff 将它关闭，驱动改为按实际 toggle 状态再次打开。候选曾因 Write 未先 Read 而拒绝写入，两侧最终明确使用相同 Read→Write 流程；该旧 Write 行为差异没有被掩盖。同插件控制的首次重复无 matcher 注册和复用 Agent 驱动缺失 UI 输入夹具均单独记录并修正，未删断言、吞错或延长 deadline。

## 未覆盖与工作区保护

本批不宣称所有类型/函数已与官方一致：SendMessage pin、报告扫描、完整 wire 换行，G5 物理/逻辑帧矩阵、Workflow 和完整 diff 焦点/窄屏/样式仍需分别完成。远程 MCP 元数据真实性不由本地工具判定回归证明。原生对照还发现本地 Write 先读要求、Read 的 mitigation reminder、Bash 无输出文本与官方最新实现的差异，留待独立功能批次，不声称本轮全部工具结果字节一致。

基线 HEAD 4187607774ba22da59e038f50615b20e83c6e89f、278 条 WIP、空 index。候选从该 HEAD 单独建立，ROOT 只迁入功能 delta，保留既有 union 类型及其他 Claude 改动；签名提交使用候选 patch，不整体暂存共享文件。response.md、fix-instructions.md、improvment.md、旧 built-claude 和 diff 制品的字节/mtime 单独核对。
