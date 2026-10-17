# Mods 自有 pane 查询与重载验收（2026-10-07）

## Scope

基线提交 `005fae9c507b5e3c511cea65ded62daaef20beda`，本地版本保持 `2.1.280`。本批接通作者 `$.ui.panes()` / `ui.panes`，验证自有记录、五个公开字段、放置顺序、准备阶段与重载发布、Worker 副本和旧绘制/焦点回执。独立提交候选与完整工作区分别构建，保护用户其他 Claude 会话，不推送。

本方法查询已有 pane 宿主。无终端 SDK 的 pane 登记、ui_panes/show/focus/close 控制、system/ui_panes 推送和全部 UI/diff 仍未完成。

## Evidence

- Source-confirmed：官方 2.1.292 生成声明的 `UiPane`、无参便捷方法、readonly 列表、空操作输入、value/deny hook 及 testing EngineCall；完整声明固定在现有 assets。本批不重写官方声明。
- Source-confirmed：本地只读提取 `chunk-96mvg299.js` 的 ZYo/qme/Ei，以插件身份过滤引擎记录，open 在 unplaced 前，查询快照及记录冻结。作者声明明确重载后的模块应发现仍留在引擎中的 pane。
- Runtime-observed：真实 Worker 返回可修改的独立结果，空事件冻结，拦截/拒绝、额外 JavaScript 参数、跨插件顺序、暂存关闭、重载 lease 和旧回调有回归。
- Binary-observed：官方 2.1.292、独立候选、完整工作区使用相同终端尺寸、离线配置和 literal stdin；打开、查询、G1/G2 按钮、重载、重开、关闭及 /exit 全程来自各自单次 tmux 运行。
- 最新来源复核仍为 [Anthropic package metadata](https://registry.npmjs.org/@anthropic-ai/claude-code/latest) 的 2.1.292，包 shasum `ecf88deee4c6b1b099d14a8571f1d5cad2ff1897`。方法背景见 [官方 Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)；精确类型以实际安装版本生成的声明为准。

## Findings

1. 只返回本插件的 id、title、isShown、isFocused、isPlaced；不泄漏 owner、drawing、tree 或其他插件。按打开顺序排列，已放置项在前；放置状态与绘制树是否存在分开。
2. 新激活代次以引擎现有记录准备 pane，暂存开关不改变旧画面；发布按原全局位置替换保留项，仅追加新项，撤销旧 drawing。关闭、卸载和候选撤销仍清理记录。
3. Worker 便捷方法忽略额外 JavaScript 参数，以现有 wire 编解码复制返回数据；作者修改结果不改变引擎。TypeScript 保留无参、readonly 列表及可修改记录属性。
4. 待绘制的人工焦点只报告同一 pane 对象的落点；替换 owner 或同激活内重开不能把新画面的焦点算成旧请求成功。
5. 原 `does not inherit ... after reload` 断言与官方引擎记录语义冲突，仅 reload 分支改为保留可见/焦点；close、unload、candidate-release 负例不变。原 pending focus 替换负例不放宽，补充同激活内替换负例。

## Commands / artifacts

隔离批次：`/private/tmp/mods-panes-292-20261007-bqmtbs_z`。运行器为本批 `run.py`，所有测试使用 `bun test --no-env-file`、自有 HOME/config/TMP/XDG，未复制凭据；make build 输出至私有目录，未替换共享 built-claude 或 official-claude。

| 最终门禁 | 结果 | 源码 manifest SHA-256 |
| --- | --- | --- |
| candidate-focused4 | 444 pass / 0 fail / 3 skip / 1458 expect，9 文件 | `7d0a5201c20986f2111215736edc31580024e40929bb3f1b30c4c35a87d7073c` |
| candidate-check2 | exit 0 | `7d0a5201c20986f2111215736edc31580024e40929bb3f1b30c4c35a87d7073c` |
| candidate-build2 | exit 0 | `7d0a5201c20986f2111215736edc31580024e40929bb3f1b30c4c35a87d7073c` |
| workspace-focused2 | 461 pass / 0 fail / 3 skip / 1510 expect，9 文件 | `8170a8edbe548400d722cad64756ce2c412598bded7850d2d62b3aa99c1c1524` |
| workspace-check2 | exit 0 | `8170a8edbe548400d722cad64756ce2c412598bded7850d2d62b3aa99c1c1524` |
| workspace-build2 | exit 0 | `8170a8edbe548400d722cad64756ce2c412598bded7850d2d62b3aa99c1c1524` |

九个文件为 uiPanes、uiPanes.types、ui、runtimeUi、uiEnvironment、loader、environment、remoteUiControl、remoteUiRender。三个 skip 是已有完整官方图 fixture 缺失，仍不计通过。候选与工作区数字不能相加；工作区包含其他未提交测试。make release-check 包含全局 TypeScript/lint、CHANGELOG、strict SDK UI types、missing import 与 diff 检查。

原生 driver `native-pane-list.py` 有 100 秒全局、15 秒目标及 5 秒稳定画面上限，以回执、实际画面和退出状态为屏障。三侧各有 9 条作者回执；45 项必要查询/生命周期/隔离检查通过，原生 UI 焦点差异另保留，不能称全部回执完全一致。

| 原生制品 | SHA-256 | bytes | 证据 |
| --- | --- | --- | --- |
| official | `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f` | 235017328 | `native-pane-list-official-p4/evidence/result.json` |
| candidate | `f0c90aa65ebd805f5b02f7b0bc2bda44c538b0b35d4f26ecbf8334aa1e3edba9` | 102298850 | `native-pane-list-candidate-p2/evidence/result.json` |
| workspace | `3504efee00a839a4e2937c206716dafad581d36b92d228544b3d76243e034d15` | 102265826 | `native-pane-list-workspace-p1/evidence/result.json` |

每份证据保留 argv、环境、制品 mtime/hash、driver hash、插件前后 hash、授权 G2 夹具修改、准确输入字节、PTY、txt/ANSI capture、debug 与自有 PID/PGID 清理。最终三侧均正常 /exit 返回 0，pane 与 tmux server 进程组消失，制品未变化。全程禁止外网、用户配置、Keychain 和非私有写入，仅提供占位 key。

## Failures retained

- 原提交加七项 pane 回归：0 pass / 7 fail，未支持公开方法及重载保留。
- 初次候选相邻验证：140 pass / 3 fail；Worker 冻结结果、旧 reload 断言及焦点回执问题均保留原日志。修复后原焦点负例通过，新增同激活替换负例也通过。
- 第一次完整工作区合并错误地叠加已有 pane sugar，在 Worker 模板字符串中重复声明 const panes：331 pass / 130 fail / 3 skip。静态检查不能发现模板内语法错误；修正整合后重新执行相关测试、检查与构建，最终 461/0/3。未删除、skip 或弱化这些失败断言。
- 官方 p1 鼠标回执屏障失败，p2 定位到 driver 把官方 ui.close 对象参数改成字符串；后续恢复 PaneCloseArgs。候选 p1 点击持有键盘后未返回 composer，正常退出失败；如实保留，终态后已核验清理。最终 driver 明确点击后返回 composer，并使用稳定 ANSI 画面后输入。

## Risks / limits

- G1/G2 点击时，候选与完整工作区的 pane isFocused 为 true，官方为 false，共四条相邻状态差异，完整记录在 pane-list-comparison.json。返回 composer 后的七个主查询阶段两侧一致。该既有鼠标焦点行为继续处理，不能以本批查询正确宣称完整 UI parity。
- 候选通过列表、重载与按钮流程，不等于全部 physical cells 与官方相同；独立 Focus/Band/Select/diff 完整效果仍未闭合。未新增浏览器 Client 执行或远程 pane 控制验收。
- 本批只跑相关九文件，未重跑旧 response 的 155 文件或全仓门禁；此前已确认的 trusted stream callback abort 失败仍开放，不声称已经修复。G5 指 Gap 5 session authoring，不是模型名。
- 阅读 response.md、fix-instructions.md、improvment.md 作为历史证据，保留其失败和范围；用户后续明确授权按独立功能签名提交，不挟带全部 WIP。
- 共享 CHANGELOG/README 中已有另一会话的整理：完整工作区保留版本汇总并增补本批条目；提交只含自己的增量，不收纳未提交的文档整理或其他生产功能。构建 manifest 包含实际嵌入的 CHANGELOG，README/报告不进入制品。
