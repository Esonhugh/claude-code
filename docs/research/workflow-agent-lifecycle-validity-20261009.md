# Workflow Agent 生命周期与验收有效性

Native39 完整门禁正常收尾：30项 / 27通过 / 3失败。code-review、workflow、workflow-retry-partial-failure、workflow-failure-detail 均通过最终验收；其余失败为 builtin-mods、terminal-canonical-diff、terminal-interaction。整体仍未通过。

## 实现与使用

Git基线 adcaead1b0e83b17eb18d15ea676f790d6078e22。Workflow启用和脚本使用见[README](../../README.md#workflow-配置与使用)。`agent(...)` 与plan明确请求前台执行，实际Agent路由仍由官方兼容的fork/定义规则决定；Workflow捕获可信launch回调中的实际task，后台回执只能关联本次已注册任务，随后等待真实状态和result。不会把async_launched换成伪造的完成结果。

进度由实际Agent消息产生，WeakMap只绑定本次host调用context，子context复制不继承；启动即后台及前台转后台均使用同一观察路径。取消先把原reason传给本次worker的控制器，再停止对应task；前台返回部分结果也不能把已取消Workflow误报成功。无关后台Agent继续运行。完成或失败后注销进度观察与父取消监听。

Workflow拥有自己的父完成通知，不再让子后台通知引发额外父查询。完成、失败、停止通知带task/tool ID、已测token/tool用量、时长和实际输出文件；XML转义保留。暂停仍可恢复且不发终态通知，已结束run不重复启动和通知。通知实现与已有未提交源码审查对齐，保留其他Claude工作；没有修改作者公开$接口或放宽既有返回值校验。

## 失败对照与处置

| 原件 | 结果与边界 |
|---|---|
| lifecycle-red1 / background-red1 | 真实AgentTool入口的plan/script仍把后台启动当失败；headless测试不能代表交互式fork路由。 |
| Native37 | 只显式run_in_background=false，完整30项24通过6失败；真实CLI仍强制后台。旧GREEN不继承。 |
| lifecycle-proofs-red3 | 失败拒绝和取消隔离已通过，实际进度未转发；修复消息产生处的observer。 |
| Native38 | 同一冻结源码30项26通过4失败；workflow及retry实际通过，code-review真实worker完成但通知usage缺失，严格identity守卫继续拒收。 |
| transition-red1 | 后台task归属拒绝真实；进度夹具使用end_turn会提前完成，不能独立作为取消产品RED。 |
| transition-red2 | 改用真实tool-use/result进度：转后台过早结束、取消返回partial completed或unowned错误仍复现；通知完成/失败/停止缺契约。保留实际2pass/7fail外层、0pass/3fail子日志。 |
| final2-tests1 | 四完整文件12pass/0fail/138expect；2+2+3+3个子案例日志分别保留，不重复相加。 |
| final2-plan1 / script1 | 完整Node assert程序完成并输出passed；Bun显示0 tests，不能虚构测试数量。script测试进入plan mode须私有planModeAvailable=true，基线同样需要，生产权限guard不改。 |
| final2-routing1 | 五完整相邻文件8pass/0fail/16expect，另三个Node assert完成标记核实。 |
| final2-check1 / build1 / driver1 | 同一冻结source完整release-check、新binary及实际默认release-driver入口通过，保留所有已有回归。 |
| Native39 | Native39 完整门禁正常收尾：30项 / 27通过 / 3失败。code-review、workflow、workflow-retry-partial-failure、workflow-failure-detail 均通过最终验收；其余失败为 builtin-mods、terminal-canonical-diff、terminal-interaction。整体仍未通过。 |
| final2-integration-tests1 | 私有共享WIP合并快照独立通过，source 3374dfe469fbbbc1d46f142bc3df361f8f74e16aeef318d21d76f6abc13b11f9；不是主binary source。 |

早期lifecycle-proofs-red1/2与failure-debug只到夹具超时；Bun对未结束Promise过早rejects断言阻塞释放屏障，改用普通outcome收集后才有真实red3。过滤诊断不算完整测试；旧超时、失败及原件不回写。

## 同轮身份与可复查命令

source `5a781ed6114efbd88b86532dcdbfbc06bec9562a16e40da9b32b05e7c94d81ab`；binary `98a9d45f612a2a3ba0225a1a1693cbe07706e2b3973a550eb36a5033774d78a4`；最终manifest SHA `767178b80b7749d3dffe832838e45812679a3f4ae28281ace32061cd6fd7c98b`。完整原件 `/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/full-gate39-evidence/driver-final-manifest.json`，disposition `/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/full-gate39-disposition.json`。动态required从committed release range、全部候选diff及untracked共同推导；原有七项追加场景保留。完整矩阵正常收尾，原件最终重读，源码无漂移，owned group已退出。process.spawn最终closure继续独立通过。

```sh
bun test ./src/tools/WorkflowTool/workerForeground.test.ts ./src/tools/WorkflowTool/workerBackgroundLifecycle.test.ts ./src/tools/WorkflowTool/workerForegroundContinuation.test.ts ./src/tools/WorkflowTool/workflowNotifications.test.ts
bun test ./src/tools/WorkflowTool/runWorkflow.test.ts
# 完整script回归在私有CLAUDE_CONFIG_DIR/settings.json设置planModeAvailable=true
bun test ./src/tools/WorkflowTool/workflowScriptRuntime.test.ts
python3 .claude/skills/release-validation/scripts/test-release-driver.py
make release-check
make build
```

本次真实命令、私有环境与每个epoch的SHA存于before/start/result/log，完整native命令存于full-gate39-command.json；不读共享凭据，不停止他人进程。文档在新candidate闭合，编译代码/门禁/probe与已验证source逐字节相同；提交按生命周期、通知、文档分批，组合最终代码使用此验证，逻辑中间commit没有各自单独完整gate。

## 尚未闭合的验收

三类终端结果继续按失败保留。当前native broker已无ACK，但内存帧与IO只在退出后落盘；canonical的运行中frameFloor/IoId无法形成真实关联。下一批需要建立不会阻塞产品的有界在线观察，并将持有的live receipt与最终原件重新绑定，缺失或溢出拒收；不能由pane文字生成frame witness。legacy diff关闭缺对应debug事件，native geometry报告与旧driver字段也需按真实backend契约接通，保留关闭、重开、resize和输入owner全矩阵。非阻塞采集本身不证明productTimingEquivalent。

真实帧cell、termios/resize历史、OS read/parser/owner链和无观测对照须分别闭合；完整terminal/diff、browser/Client、其余11个生产方法及四路发布仍未通过。任何当前源码或后续官方版本变化均需新的epoch，固定官方293参考不自动代表未来latest。本批不宣告完整Mods或发布完成。
