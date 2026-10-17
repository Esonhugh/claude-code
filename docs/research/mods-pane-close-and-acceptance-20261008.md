# Pane 人工关闭与验收有效性（2026-10-08）

关闭入口已实现，完整 UI/diff 与发布验收尚未通过。本批只提交关闭功能、回归和说明；私有工作区中的帧证据与验收守卫另行核对，不混入这一功能提交。

## 操作与契约

实际聚焦的 Pane 使用默认 `Ctrl+X X`，Input/Select 使用 PaneField 同一默认 chord。自定义配置已启用时，可分别在两个上下文中重绑或解绑 `pane:close`；普通按钮持焦使用 Pane。关闭 mark、`closeOnEscape` 和 chord 共用释放后关闭的顺序。先撤销组件焦点请求、释放 DOM 与可信 host 焦点，再调用当前插件 owner/id 的 `ui.close`，origin 为 person。hook 保持打开或抛错时，面板仍存在但旧的请求不能迟到恢复焦点；新请求仍可聚焦。不可见、失焦、其他 DOM 持焦和 Band 不接受此关闭 chord。

`Pane`、`PaneField`、`pane:close` 已进入 schema、类型、默认表及配置 validator。自定义文件加载仍受当前构建的 keybinding customization rollout 控制；本批不将 parser 单测写成所有构建的完整文件加载验收。

使用方式与上下文依据：[Anthropic keybindings](https://code.claude.com/docs/en/keybindings)、[Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)。固定解包对照为官方 2.1.292 的 Voe/Doe/FVo/U2t/D4/DZe：先清 field/ring 和 host focus，再人工关闭，失焦会使旧 ticket 失效。2026-10-08 的公共 npm registry latest 查询结果为 2.1.293；本批没有 2.1.293 native 对跑结论。

## 复现与修复证据

真实 Ink stdin 和 createModUi 回归复现并修复：PaneField Input 的第二个 chord 键被控件先消费；Select 未被计入字段上下文；配置 validator 不认识 Pane/PaneField；关闭 hook 保持打开或抛错前未释放 host；实际 AbovePrompt consumer 没有 Band 标记；挂起的 person focus 在否决关闭后仍能写回 host。保留失败前像与修复后像，不把错误 Select props 或错误 Band 导航夹具当作产品缺陷。

新增在途场景：真实 Tab 进入 ui.focus 延迟边界，发送 Ctrl+X X，关闭 hook 保持面板打开，释放旧 focus。旧请求返回 deny，host focusedId 与实际 DOM activeElement 仍为空；新显式 host ui.focus 成功。末阳性不是第二次 Ink Tab，也不是外部 PTY/Worker。non-null/同 ID/invalid ID 的在途组合、automatic 挂起组合和多 owner 替换尚未在本轮做专项。

## 同源验证

| 候选 | source SHA-256 | 已完成 |
| --- | --- | --- |
| 干净关闭 C3，父 HEAD 28af98e1ff94feef8e5766cb48804cb45b190795 | 37e45a6211de8e4602d88d22508dd4115ea598f0a19d0ebb428061b744337fcd | ModsPane、ModsAbovePrompt、ui、defaultBindings 四文件 291/0/1748；release-check exit0 |
| 包含工作区其他变更的冻结候选 FO | 32eea1503bcebfafe3d34e934f1dd6b65e6d16898834a7a54e017bd8ad583c08 | 上述相邻项与 ModsPane.evidence 五文件 308/0/1832；驱动回归、release-check、build exit0 |

各 runner 使用私有 HOME/config/tmp、禁用外部流量和真实账户认证；源码前后不变，所属进程组已退出。C3 独立只读报告 SHA-256 为 `10e4a15fc582cb900a721a914661ed199c4e29cb746402dbd042308f98ef3faa`，112 份证据、18 份源码复读零漂移。文档加入后的候选与 C3 code bytes 单独核对，不能沿用 C3 的整仓 epoch。

关闭回归命令为 `bun test --no-env-file ./src/components/ModsPane.test.tsx ./src/components/ModsAbovePrompt.test.tsx ./src/services/mods/ui.test.ts ./src/keybindings/defaultBindings.test.ts`；检查与构建使用 `make release-check` / `make build`，具体隔离 env 与 before/result 日志保存在 `/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/pane-close-race-tests1`、`pane-close-race-check1` 与各 `terminal-pane-owned-*` 目录。临时证据须另行归档才能在其他机器复验。

## 验收有效性仍须关闭

第十五轮原始完整矩阵 29/29 完成、27 通过、2 失败；manifest SHA-256 为 `6b0c4aee2be805180039967a5eeb38fd32244c79745e6a1fa150611d4479fc4f`，binary SHA-256 为 `b2a801e330e1a51cf7773a89acd818d222d0fafbd5aa91a3f696543316626647`。保留 builtin-mods、terminal-canonical-diff 失败；terminal-interaction 在该轮通过，不能复判旧 run。第十六轮 FO 新制品 29 项全部执行、26 通过、3 失败（builtin-mods、terminal-canonical-diff、terminal-interaction）；manifest SHA-256 为 `d7638b04f1b003577f714f37c8bcc079ef0df017f53b0116216d364f0db53fa0`，binary SHA-256 为 `49f2dc860ffcb99b02b2180255724b6c0e0719212d7a89ea5c83aa6f930912b1`。正常退出、源码前后不变、认证清理无错误、所属 lease 已释放。canonical 第二次 Tab 的 host 状态为 base，但帧71–72缺少该控件的几何和实际焦点，严格守卫因此拒绝；后续关闭/重开没有执行，不能认定 native 关闭功能通过。完整逐帧和其余失败继续处理。

私有候选已经以失败对照收紧 Tab 检查点 roster、当前真实控制焦点、输入/检查点 IO 上下界、独立物理 viewport 和实际 resize ACK，并把 mounted 但不可见的 Pane 与真正 paintable 的 Pane 分开；完整驱动回归通过。这些是独立候选的已验证实现，不代表本提交已包含其源码。

当前 v1 帧边界同步 ACK 会改变产品时序，`productTimingEquivalent:false` 必须继续阻止完整逐帧通过；不得删帧、强制重绘、逐键等待或放宽单元格断言。非阻塞真实 terminal write journal、独立输出映射、resize/termios epoch、逐帧实际 paint 覆盖、实际语义输入消费的 owner/generation 仍需实现与验证。原零高度裁剪尝试未复现缓存误判，不能据此声称覆盖了所有 culled cache。完整官方 diff、浏览器 Client、293 类型/行为及其他公开 API 继续保留在目标内。
