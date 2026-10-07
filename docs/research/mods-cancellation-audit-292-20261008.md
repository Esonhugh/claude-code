# Mods 取消原因修复与历史八类控制复核

日期：2026-10-08。基线 `cd276f7200b65d31f64bb7ae9d9761bcb09426ec` 加本批增量；候选与完整工作区分别冻结。本批完成取消原因修复和历史缺口重验；完整官方兼容的目标继续进行。

## 取消根因与修复

trusted stream callback 在 $.clock.sleep 中等待父信号；通用 combinedAbortSignal 不传 reason，使嵌套调用用 AbortError 结算，外层自定义 Error 丢失。本批仅在 Mods runtime 的 dispatch 与 trusted facade 使用现有保留 reason 的组合器，不修改其他消费者的通用 utility。

两侧修复前均 **25 pass / 1 fail**，原 `cancel stream callback` 失败保留于 candidate-red/workspace-red。修复后保留原 toThrow，并加原始对象严格相等、frame/nested reason、stream result、暂停预算和能力失效检查；增加局部 clock 在途/预先取消及非模型事件预先取消。三处相邻测试从旧通用 AbortError 预期改为严格原始 reason 身份，阻塞解除、reader 停止、所属进程退出和 core 不重放断言均保留。

候选14文件 **495 pass / 4 skip / 0 fail / 2679 expect**；完整工作区同一集合 **534 pass / 4 skip / 0 fail / 2833 expect**。四 skip 是可选官方 diff、完整声明/Worker及 agents-md/telemetry 夹具，不计为通过。首次新增局部取消测试错误地期待整个 hook 必须失败，普通 hook 实有 fallback；原失败保留，修正为在 clock 调用处捕获并核对原 reason，产品 fallback 未改。candidate-focused1/workspace-focused1 保留相邻旧三处错误预期的失败，focused2 为最终通过。

## 同输入原生重验

固定官方 **2.1.292** SHA256 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`。三个制品复用同一历史八类控制 fixture/driver，各自独立 HOME/config/TMP/XDG/cwd、localhost HTTP 与自有 tmux；每次完全退出清理后才运行下一侧。每侧111回执、91观察，模型POST为0，正常EOF exit0；HTTP/请求线程、所属 pane/server group 全退出，夹具和二进制未改变。

| 控制 | official | candidate | workspace |
| --- | --- | --- | --- |
| ui_prompt_edit | `{"text":"draft","cursor":5}` | `"Unsupported control request subtype: ui_prompt_edit"` | `"Unsupported control request subtype: ui_prompt_edit"` |
| ui_prompt_autocomplete | `{"suggestions":[],"start":0}` | `"Unsupported control request subtype: ui_prompt_autocomplete"` | `"Unsupported control request subtype: ui_prompt_autocomplete"` |
| ui_panes | `{"panes":[],"shown_id":null,"focused_id":null,"focus_requested_id":null}` | `{"panes":[],"shown_id":null,"focused_id":null,"focus_requested_id":null}` | `{"panes":[],"shown_id":null,"focused_id":null,"focus_requested_id":null}` |
| ui_pane_show | `{"shown_id":null}` | `{"shown_id":null}` | `{"shown_id":null}` |
| ui_pane_focus | `{"focused_id":null}` | `{"focused_id":null}` | `{"focused_id":null}` |
| ui_close | `{"closed":true}` | `{"closed":true}` | `{"closed":true}` |
| ui_scroll | `{"moved":false,"offset":0,"deny":"no such site"}` | `{"moved":false,"offset":0,"deny":"no such site"}` | `{"moved":false,"offset":0,"deny":"no such site"}` |
| ui_focus | `{"moved":false,"element":null,"deny":"no such site"}` | `"Unsupported control request subtype: ui_focus"` | `"Unsupported control request subtype: ui_focus"` |

官方/候选 **279/282**，三侧 **418/424**；剩余差异恰为两本地侧各三类 ui_prompt_edit、ui_prompt_autocomplete、ui_focus Unsupported。四个 Pane 控制已由6b13695接通，scroll由cd276f7接通。原绘制、句柄、消息、故障恢复、并发序列和取消相邻比较通过。每个 opaque handle 按所属插件和首次 drawing lease/控件类型/key 对应，不能合并同key的新代次；生成session/cwd和独立观察次序有限规范化，原回执逐项比较。

该驱动验证缺失站点回执及原已有流程，不代替完整 Pane/scroll 状态专项、focus/prompt、浏览器 Client 或终端 diff。自定义 reason 的 trusted host callback 故障由源码回归验证，真实 CLI 验证相邻公共控制取消；两层证据分开。

## 制品与门禁

| 侧 | 最终 build/check source SHA256 | binary SHA256 |
| --- | --- | --- |
| candidate | `8376dc58e733f3c0e2bc222d138882a79848469311ebd0e53af134d124dff754` | `8452beae77c929adc5f1a2820abf61e7917db5131a6499bc3df04393f9d36b29` |
| workspace | `f50da5afa220d962178845dbed37dee303b11a41d31b00893733aecb50cf79a6` | `abc09c39e63d1d536e33cadddd4484df44d320fc1754f7bada2feafe7d4b3413` |

两侧 make release-check 与 make build CLAUDE_CODE_BUILD_DIR=<private-output> 均 exit0。focused2 在最终 CHANGELOG 文本更新前执行，与 build/check 的输入只有 CHANGELOG.md 不同；生产源码、测试、类型、资源和构建脚本摘要完全一致。研究文档后写，不改变制品身份。完整输入在 focused-files.json，每个门禁有 start/result/before.json。

证据根 `/private/tmp/mods-cancel-audit-292-20261008-l3v04h3y`。运行方式：

```sh
python3 <evidence>/run.py candidate test candidate-focused2 <focused-files>
python3 <evidence>/run.py workspace test workspace-focused2 <focused-files>
python3 <evidence>/run.py candidate check candidate-check1
python3 <evidence>/run.py workspace check workspace-check1
python3 <evidence>/run.py candidate build candidate-build1
python3 <evidence>/run.py workspace build workspace-build1
python3 <evidence>/native-control.py official n1
python3 <evidence>/native-control.py candidate n1
python3 <evidence>/native-control.py workspace n1
python3 <evidence>/compare-audit.py pair
python3 <evidence>/compare-audit.py
```

默认门禁使用隔离环境；native 扩展执行仍附加子进程沙箱，只准自有临时目录、TTY及localhost。未接触真实认证、用户原Claude进程、系统剪贴板或共享制品。

## 跨报告核对与必须完成的后续

旧实现审查基于005fae9，原274/282与取消25/1保留为修复前记录。另一聊天“审查 mods 实现与文档”冻结6b13695和当时WIP于 `/private/tmp/cc-full-check-20261008-7gpegrv_`：release-check通过，但完整binary矩阵27项计划0项记录，因readiness-smoke未进入dummy provider分支而要求不存在的认证夹具。补充流程及stale focus断言不代替完整矩阵。

该全量诊断确认 environment.ts 的catch对Proxy继续执行 instanceof Error，会触发getPrototypeOf trap并绕过回包/active-call清理；焦点/布局与diff/UI失败也需按原输入重验。这些不属于本次取消专项已修复项。后续必须修复三类控制、Proxy处理、responder/system与浏览器Client，处置验收夹具和过时契约，并执行完整终端、diff、G5与相关失败路径；Privacy Mode之外不以未实现/未覆盖作为最终完成结论。

本批分项签名提交，保留其他WIP、不push，目标继续执行。
