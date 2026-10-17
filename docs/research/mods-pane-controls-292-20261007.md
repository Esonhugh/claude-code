# SDK Pane 控制与无终端登记对照

本批于 2026-10-07 开始，2026-10-08 完成实现与验证。SDK Pane 专项通过；完整 Mods/UI/diff/G5 目标仍未完成。源代码基础为 `5715d2c`，验证期间保留并吸收并发文档提交 `2e82b2d`，最终候选基于后者。当前本地构建版本仍为 `2.1.280`。

## 对照依据

- **Source-confirmed**：官方 2.1.292 的 Pane 服务位于只读解包的 `chunk-96mvg299.js`：`Ei`/`qme` 管理 open/unplaced；`YYo`/`ZYo` 对应打开与插件查询；`Por`/`D4` 对应显示与焦点；`DZe` 对应关闭。SDK chunk `chunk-jjy8yg8v.js` 的四条控制直接使用同一服务，并发送有限字段的 `system/ui_panes`。
- **Source-confirmed**：`QYo` 与 `Tor`/`Bq` 的标题校验允许 LF/CR/Tab 和正常代理对，拒绝 C0/C1 的其余字符、孤立代理项及 U+10EEEE。`.ui.close` 的 public origin 只有 kind，next.origin 保留调用插件与 tier。
- **Binary-observed**：固定官方二进制 SHA256 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`，235017328 bytes。没有修改原二进制。包 registry latest 本轮核实为 2.1.292，shasum `ecf88deee4c6b1b099d14a8571f1d5cad2ff1897`。[包元数据](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)。
- 公开 [Mods reference](https://code.claude.com/docs/en/plugins/mods/reference) 标注 as of 2.1.290，说明安装版本生成的声明优先；本批沿用已校对的 2.1.292 声明，公开作者 API 未另造 show/focus/closePane 方法。新方法仅属于可信宿主控制服务。

## 实现与可观察契约

1. 无终端会话可以登记 Pane，同一 canonical Map 服务作者 ui.panes、SDK roster 和生命周期。metadata 登记不调用终端 draw；外部客户端以 ui_render 取得内容。已放置 SDK 记录只有 id/title/plugin 和存在的 true manners、rows、columns，未放置项仍在作者五字段查询中。
2. ui_pane_show 对未知或未放置 ID 不改状态；有实际焦点时，焦点随切换项移动。ui_pane_focus(null) 清实际焦点，任何 focus 请求都清 focus_requested_id；无效 ID 保留原焦点与显示项。打开时 focus:true 只提出请求，无终端作者查询仍报告实际焦点 false。
3. 无测量 viewport 时默认可放置。只有不支持 layout 的测量客户端时，新项返回官方等待 reason。任意 isFullscreen 布尔值均表示可放置；attach/detach 更新 roster 后、钩子与回执前放置等待项，按顺序追加，已放置项不撤回。
4. 活动 Pane 同 ID 更新保留原插件与打开顺序，替换省略的 manners/rows/columns。peer 可以更新和关闭，但其 ui.panes 查询不取得原插件记录。
5. SDK close 以 person/engine-core 调用关闭钩子；deny 保留，throw 与只读 ID 改写落回原 ID 的 core。缺失 ID 返回 true。在途重复关闭立即返回 false，不重复 hook；control_cancel_request 不取消这四类控制。卸载仍走原生命周期服务，关闭清焦点请求并撤销对应外部绘制、回调和 Client 地址。
6. system/ui_panes 使用有限 SDKMessage/schema 类型与 uuid/session_id。public projection 的 JSON 变化触发推送，draw revision 和关闭进行中不造成虚假通知；登记后的初始 roster 会发送一次。消息通过 SDK 输出队列并从模型消息/最后结果判定路径排除。调试日志打印 count/shown/focused/requested，拒绝日志保留关闭 ID 与原因。

## 验证

初始 8 项红测全部失败；先后修复 no-terminal 拒绝、状态方法缺失和源代码差异。真实对照又发现登记时 isShown:false 与 public close origin 多 name 两项差异，保留失败比较 `native-comparison-c2-failed.json`，修正后通过。类型门禁发现同名 panes 变量，lint 指出刻意检测控制字符的正则；分别改名、为这一个明确的 validator 添加有说明的 no-control-regex 抑制，未削弱校验或测试断言。

| 制品 | 聚焦 13 文件 | release-check | build | 源码 SHA256 |
| --- | --- | --- | --- | --- |
| 独立候选 | 464 pass / 0 fail / 3 skip，1633 expect | exit0 | exit0 | 0b90a1a6cfb61fe728afbb200ec9b7faa3565c88533392ffda37d2842da63066 |
| 完整工作区冻结 | 481 pass / 0 fail / 3 skip，1685 expect | exit0 | exit0 | 327365d58f810f2d3deae4ee9f5130a3f5c87f6712af37e8cbf23b5753d9b352 |

命令为独立环境内的 `bun test --no-env-file`，覆盖 uiRemotePanes/ui/uiPanes/runtimeUi/uiEnvironment/loader/environment/remoteUiControl/remoteUiRender/remoteUiClient/remoteUiFault/remoteUiFaultTypes 与作者类型测试；使用 `make release-check`（含全源码类型、lint、SDK type/schema 双向检查）及私有输出目录的 `make build`。3 项既有 skip 保留，未新增 skip。每个门禁均无超时、源码不变、自有进程组无残留。

| 新制品 | SHA256 |
| --- | --- |
| 候选 candidate-build4-output/built-claude | 9e90263f3dc3a283220e9463f0a1e77c1463824c456348950e6686dcbea3f8a0 |
| 工作区 workspace-build1-output/built-claude | 2c16c7f5db95a6bef6579e02e979e8606ba54f622a44847229cc94233008c236 |

官方、候选、工作区使用同一 SDK driver/插件夹具/真实 stdin 输入，分别为 `native-official-oracle3`、`native-candidate-c3`、`native-workspace-w1`。每侧 161 条控制回执、131 条观察事件、24 次 system/ui_panes，另有相邻 Client fault 的 3 次 ui_invalidate；模型 HTTP POST 为 0。**592 项比较全部通过**，每侧正常 EOF exit0，tmux pane、server group、HTTP server 和 request threads 全部清理，二进制与夹具校验不变。

对比仅规范化按 plugin/element/type 对应的不透明句柄、私有 cwd、生成 session/resume 和推送 uuid/session_id；实际句柄用于 stdin；pane 操作顺序、完整回执和状态推送顺序/载荷原样比较，envelope 单独验证。全体观察事件的异步顺序允许独立，Pane 观察顺序另外逐项严格比较。

终端相邻验收：官方、候选和完整工作区各完成 9 条观察，正常 /exit0 与自有 pane/server 清理；45 项 inventory/交互/重载/关闭比较通过。四项既有 G1/G2 鼠标点击焦点差异保留：两种本地制品报告 isFocused:true，官方报告 false。该差异未标为完整 UI 对齐。

## 剩余边界

- 四类合法客户端控制仍未接通：ui_prompt_edit、ui_prompt_autocomplete、ui_scroll、ui_focus。五类 responder、其他 system 推送和浏览器 Client 真实执行仍开放；当前客户端控制路由为 14/18。
- 当前测试证明活动 Pane 的 peer 更新和关闭。准备阶段的跨插件同 ID 冲突、初始加载期间并发 viewport 转换、SDK 重接推送与终端焦点请求确认需要专门官方对照；不能从普通 SDK 稳态用例推导为完整兼容。
- 已知终端鼠标焦点差异继续保留，不代表完整 UI 与官方相同。官方 diff viewer 的完整效果、交互、操作流程，以及 G5 authoring 与旧 response 的全量 WIP 门禁仍需要后续批次。
- `/tmp/claude-502/response.md` 的 146/155 文件通过、9 文件失败是历史冻结结果，本轮未重跑其全量集合；先前 nested stream cancellation 的原因保持问题也未在本批修复。

## 本地证据

批次目录：`/private/tmp/mods-pane-controls-292-20261007-p80zadap`。源码和官方解包只保留在本地。门禁 ledger 为 candidate-focused6/check4/build4 与 workspace-focused1/check1/build1。native-comparison.json 保存全部 592 checks、允许的规范化和未覆盖范围；pane-list-comparison.json 保存终端对照结果；各 native 目录保留实际输入、stdout/debug、捕获帧、退出与清理记录。

保留两个用户 Claude 进程（94223 与 70780）；未发送输入或信号。未替换共享 built-claude/official-claude，未使用真实 auth/用户配置/外部模型服务；提交只包含本批增量，其他 WIP 保留。不 push。
