# Mods ui.log 的 print 接收端和交互显示（2026-10-07）

本批基于固定 HEAD `19e37fd`，按一个功能点提交 ui.log 的主机接收、SDK 事件、notice 显示、类型/schema 和相关回归。其他 Claude 进程及工作区 WIP 保留；不 push。整体 Mods API/UI/diff/G5 目标仍未完成。

## 官方契约与原问题

2026-10-07 重新检查 [Anthropic 包注册信息](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)，最新版本仍为 **2.1.292**，包 shasum `ecf88deee4c6b1b099d14a8571f1d5cad2ff1897`。固定原件 `/private/tmp/mods-fork-routing-20261007-2afwted_/official/official-claude-2.1.292`，SHA256 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`。本地提取模块与声明路径记录在 `/private/tmp/mods-print-log-u72nglqb/official-oracle.json`，未上传提取代码。

Source-confirmed：

- `chunk-pwkr374y` 的 ui.log host op 按 hook 最终的 to 分流；XUo 输出 debug 目标，Wie 输出 transcript 目标。公开便利方法同步返回 void，不能将 await 当完成屏障。
- `chunk-ryf16qtd` 的 y0e/Wie 在 debug 和 transcript 路径都截断到 10000 个 UTF-16 单元并追加省略号；`chunk-3813s4yh` 的 ne 避免截断代理对。
- `chunk-jjy8yg8v` 的 oP 仅为 stream-json 安装 transcript 接收端，经 Fc 输出 `system/ui_log`，含 plugin、text、uuid、session_id。debug 目标不发此事件。
- `chunk-8q7p93rh` 的 kdt/sCe 生成 informational/notice 消息。默认终端显示无圆点的暗色提示；普通 info 仍可隐藏。
- 官方 author 声明 `claude-code.d.ts-5e522846.txt.zst:2392` 描述 headless ui_log 和不发往模型的契约。完整终端格式清理、远程 surface policy 和所有 UI 状态不由本批关闭。

原 pin 报告的 `printHookObserved:false` 只是在 debug 中找不到 PIN_HOOK。实际旧工作区 debug 有 `$.ui.log dropped: UI log is unavailable on this host`，说明 hook 已执行，缺失的是 print 的日志接收端。不能由日志标记缺失推断 hook 没有接入。该报告已更正并保留原始观察数据。

另一真实差异：交互日志已保存为 informational/info，默认 UI 隐藏；官方保存为 informational/notice。原候选 `l-candidate-c1` 的命令 void 回执、debug 和持久日志都存在，但 transcript 显示屏障失败，证明该差异。

## 实现和精确类型

print 绑定提供 uiLog，保留插件身份和最终目标，按官方 UTF-16 边界截断；stream-json 的 transcript 目标进入现有 outbound 队列，使用新 UUID 和当前会话 ID，其他目标/格式只进入启用的 debug 日志。ui_log 不参与最后模型结果的选择，不进入模型消息或持久 transcript。

新增导出的 `SDKUILogMessage` 与对应 `SDKUILogMessageSchema`，并加入 SDKMessage 和 SDKMessageSchema 的 union。生成器脚本当前不在仓库中，因此同步编辑现有 generated 声明并以严格类型及 runtime schema 回归核对六个必要字段，不使用 any 替代公共事件类型。

交互日志使用 notice 级别及 `plugin: text`；SystemTextMessage 为 notice 保留默认可见、dim、无圆点行为。原 info 隐藏及 warning 圆点/颜色断言继续保留。完整长行和控制字符格式清理仍需专项对照，未宣称全部终端格式已一致。

独立候选的旧 print.peer 回归漏掉 APPEND_LITERAL 已有的 session scope，新增一行准确预期；不改生产 prompt 行为、不删除断言。该修正已存在于工作区 WIP，本批提交相关一行；该文件初始仅此改动，提交后恢复 clean。其余 277 项 WIP 保持原字节和 mtime。

## 隔离自动化、检查和构建

证据根 `/private/tmp/mods-print-log-u72nglqb`；`run.py` 为每场提供独立 HOME/config/tmp/cache/runtime、无真实 key、无 dotenv、120 秒硬期限和自建 PGID 清理。没有增加生产测试开关或延长成功期限。

最终 `candidate-log-tests7`、`workspace-log-tests7` 均 0 fail/0 skip：外层分别 **54 pass、55 pass，8 files**；其中两个隔离包装分别执行 3 项日志测试、8 项 headless 相邻测试，扣除包装后实际分别 **63、64 项**。工作区多出的既有 Worker 回归保持原 WIP，不整文件纳入本批。

测试覆盖启动缓冲、默认/debug 目标、middleware 改写、非法目标、代理对截断、三种输出格式、结构化事件身份、schema 必需字段、严格 SDK union/export、实际 Ink notice/info/warning 显示，以及现有 Worker、UI 和 headless 相邻路径。

两侧 `log-check3` 的 make release-check 与 `log-build3` 的 make build 均 exit0。测试/check/build 的最终源码清单 SHA：

- 候选：`42fb1adefeb0fda8a3d9f3727eda460ef008cf5bb13251536945c9e6c0bbacae`。
- 工作区：`6f0c6408bd9957d19f1d905f210930b8acf165b0f8515267ff487f9845708be7`。

每场源码保持不变，owned PGID 结束；构建到私有目录，未替换共享 built-claude。

## 真实入口与官方对照

`native-log.py` 三侧均脚本驱动私有 160×40 tmux、独立配置/UDS、占位认证、本机确定性 API 和 cold standalone binary；依次运行 text、json、stream-json 和交互入口。实际模型先调用 Read，再完成；交互另从 stdin 输入 `/logprobe`，不用 assistant-side 工具模拟。

| 断言 | 官方 | 候选 | 工作区 | 判定 |
| --- | --- | --- | --- | --- |
| 三种 print 的启动、turn.start、真实 Read tool.call 和 turn.complete 日志 | l-official-o3 | l-candidate-c2 | l-workspace-r1 | passed |
| default/debug/rewrite 目标、非法目标诊断及 UTF-16 截断 | 同上 | 同上 | 同上 | passed |
| stream-json 只发 transcript ui_log，六个字段正确，会话与 init 相同 | 同上 | 同上 | 同上 | passed |
| text/json 输出无插件日志；三种格式的模型输入和持久 transcript 无日志 | 同上 | 同上 | 同上 | passed |
| `/logprobe` void 回执，默认 transcript 可见，debug 内容不绘制 | 同上 | 同上 | 同上 | passed |
| 交互实际模型工具/完成 hook，正常退出和无进程/配置污染 | 同上 | 同上 | 同上 | passed |

三场完整 driver 共 12 个 CLI 进程，均正常 exit0、binary 不变、API 关闭、无 owned PGID 遗留；每个 assertion 有同场输入、pane/ANSI/PTY、debug、stdout/stderr、API 请求和结果记录。

附加 `native-pin-history.py` 用同一批两侧新构建重跑成功 pin 保存、冷恢复拒绝换绑、ref 确认、clear、fork 及 print 截取历史消费；候选 `h-candidate-c3` 和工作区 `h-workspace-r2` 的 printHookObserved 均 true，实际 SendMessage hook 回执与模型结果一致。旧官方 `h-official-o9` 的同版对照记录仍保留，不把它算成本批新的官方历史运行。

## 保留的失败与验收边界

- `candidate-log-red1`：新最小回归内层 0 pass/3 fail，复现缺失主机 sink。
- tests1/2：误把 void fire-and-forget 的不同 middleware 完成顺序写成固定顺序；修正 fixture 为保留每项精确内容/次数及启动先后，单独核对完成后的全部结果，不引入 sleep。tests3 指出候选旧 scope 预期漏字段，补齐准确预期后重跑。
- `l-official-o1`：首次完整对照发现 stream-json 实际会发 ui_log，旧驱动错误地要求所有格式都无日志；因此补齐生产事件及 SDK schema/type，并按正式结构重跑。
- `l-official-o2`：驱动把命令的 local-command stdout 与 ui.log 混用 NLOG 前缀，误报模型污染；改为逐个检查实际日志标记，命令结果保留其正常模型行为。o3 整场通过。
- `l-candidate-c1`：默认 UI 隐藏 info 日志；补齐 notice 类型和实际渲染后 c2 整场通过。
- tests6：新渲染 fixture 在 React render 外调用带 hooks 的组件；修为实际 Probe 内调用。check2 指出测试 fixture 字面类型被扩宽；补齐 literal 类型。所有最后门禁在最终源码整场重跑，不拼接早期成功片段。

仍未关闭完整终端文本清理/长行格式、remote/bridge surface 准入、所有其他 print 主机能力、全部 Mods API/UI、官方 diff viewer、G5、Workflow 和全部变更的整体验收。原 response.md 的全文件门禁结论是历史资料，不能用本批聚焦通过替代全量刷新。整体 goal 保持 active。
