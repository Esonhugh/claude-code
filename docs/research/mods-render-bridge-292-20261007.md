# Mods SDK 远程绘制与模块包，官方 2.1.292

## Scope

- Source-confirmed：SDK loop 控制解析、renderer engine 引用/缓存/资源归属、模块包快照和 import 重写；本地 remoteUiControl/remoteUiRender、ui mount、loader、runtime 与 SDK 类型。
- Runtime-observed：隔离官方二进制 2.1.292，SHA-256 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`。当前最新版本来源：[Anthropic package metadata](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)。
- 授权：本地分析、实现、验证与增量签名提交；不 push、不更改共享制品、不向其他 Claude 终端输入。
- evidence root：`/private/tmp/mods-render-bridge-292-20261007-d9yp0dou`；原始失败和全部 stdout/stderr/输入/debug/pane 保留。

## Contract

接通 ui_render、ui_press、ui_input、ui_select、ui_client_module。remote drawing 保存实际引擎引用、回调 lease；回调仅在当前树下按插件、handle、surface、可选组件/实例/key 匹配。替换树或退出后旧回调失效。重叠请求各自完成，旧 hook 不因新请求或 control_cancel_request 被中断；取消只抑制回包。

没有匹配 hook 时返回 engine ref 0，但 hooked 单独按组件判断；next(e) 产生 ref 1，rewritten=true，嵌套返回树选首个非零 ref。普通 hook 抛错继续核心 ref 1，非法返回树回退 ref 0；已成功 .catch 的下游树继续保留。transcript 组件的 onScreen 只取 on_screen；tool_use_id 缺失/非字符串用 instance_id 补齐。output 超过 65536 UTF-16 单元时截断，不切断末端代理对。空 instance_id 合法且绕过缓存；列数/全屏变化使缓存失效，行数变化不使缓存失效。

remote Client 不在服务端执行。wire Client 使用 client.plugin，交互叶节点不携带内部 group；空 Box/Text props 省略。模块包只用已准入 declaration 源快照，按 entry 图保留文件顺序，重写静态/动态相对 import、claude-code 与未准入/计算 import。hash=SHA-256(JSON.stringify({files,modules,limits}))。

`assets/mods-client-runtime-2.1.292.json` 保存官方原生 ui_client_module 回执的两个固定数据文件，附版本、binary SHA 和来源说明；不在宿主执行它们、不向第三方上传提取产物。runtime source SHA-256 `833ab9dd15983d1fbdad634bf41a7ea633f092ac806539c7e927100f0e89e1b7`；hooks-types source SHA-256 `7908c3310f4764acd78ef09276fc3ed5c1315e456b5aa95aa18363b8baf87b55`。独立 Client fixture 模块包 hash `9ad0ce36658d0192ea713ec6529d6c36e716993b8a4b13579c9cf80b0343b320`，模块体若在服务端运行会直接抛错。

## Validation history

- red1：本地 loader 拒绝官方允许的顶层命名 hook；增加静态角色扫描与导入/嵌套/generator 边界回归。
- red2/3：远程 null surface binding 无法 ui.resolve；由已连接 roster 提供远程 UI 可用性，不改变 withheld UI 的准入限制。
- red4/5：desktop Client 被 terminal validator 拒绝；只放开 desktop，mobile/vscode 仍无 Client。
- wide1：26 文件 1155 pass / 8 fail / 6 skip / 5192 expect，exit1。发现绘制结果校验包装遗漏默认 validator、SSH EOF 静态范围回归，并复现 5 项 HEAD 已有远程消费冻结/失败 paint 缓存问题。
- baseline-ui-group：未修改 HEAD 61 pass / 5 fail / 275 expect，exit1；修复扩展树的远程冻结和仅成功绘制复用缓存。
- baseline-host-hooks：未修改 HEAD 25 pass / 1 fail / 164 expect，exit1；trusted stream callback nested work pauses budget and inherits abort 仍失败，actual generic AbortError，expected 原取消信息。与本批 remote control 绘制取消不同，保留断言并列为后续独立修复。
- recovery3：4 文件 75 pass / 0 fail / 344 expect，exit0。

## Assertions

最终候选/完整工作区 L1、release-check、make build、串行真实 tmux 控制回执及副作用证明在下方补充。任何 running/failed/not covered 项不等同通过。

## Remaining scope

本批不是完整官方 Mods/UI/diff 验收。还有 11 类远程控制（prompt、pane、scroll/focus、client_press/message/fault）、5 类 loop responder、system pane/scroll/focus 推送、外部浏览器 Client 生命周期、完整终端 35 帧的两个 Select 差异、完整官方 diff 操作、G5 六种认证和旧 response 155 文件门禁，以及上述既有 trusted stream 取消差异。共享内部 consumer 之外的缓存版本/限额边界仍需继续核对。使用背景：[Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)。


## Final evidence

| Assertion | Required / observed evidence | Runtime | Verdict |
|---|---|---|---|
| R-1 返回树、props、rewritten/hooked、窗口与 UTF-16 边界 | 三方同 driver/fixture/input；每侧 40 条实际控制回执；native-comparison.json | done | passed |
| R-2 回调所有者、真实 handle 使用、改树后失效 | Button/Input/Select 实际 Worker 回调与旧 press handled:false；仅 opaque handle 按插件/键/类型映射比较 | done | passed |
| R-3 Client 不在服务端挂载，模块包内容/hash 一致 | Client 组件若挂载即抛错；三方树、完整 files/modules/limits 和 SHA-256 一致 | done | passed |
| R-4 重叠请求各自完成，取消只抑制回包 | 回复顺序 rewrite/text/wait 三方一致；cancel 的实际 enter/exit 及零回包；相邻请求成功 | done | passed |
| R-5 EOF、fixture、进程与 HTTP 收尾无副作用 | 三方 EOF exit0；owned pane/PGID、HTTP/thread 全清理，fixture 与制品保持原字节，零模型 POST | done | passed |
| R-6 类型/lint/导入审计与新制品来源 | candidate-final2-check/build；workspace-final4-check/build；每侧源 manifest 固定 | n/a | passed |
| R-7 26 文件完整相邻回归全部通过 | 候选 1163 pass / 1 fail / 6 skip / 5218 expect；冻结工作区 1209 pass / 1 fail / 6 skip / 5400 expect，均 exit1 | n/a | failed：同一 HEAD 已有 trusted stream 取消失败保留，不能声称全组通过 |
| R-8 完整 Mods、浏览器 Client、UI/diff/G5/155 文件 | 见 Remaining scope | n/a | not covered |

两个最终 L1 目录为 candidate-regressions-final3、workspace-regressions-final4；通过的类型/构建日志目录见表。候选源 SHA-256 `6ed088a666b869f5853a2cdb90e1cf3d4c413ccc60897afd54e5ef1773174a52`；冻结完整工作区源 SHA-256 `6d9ff0d8970b58c4f4075ac8028eb5cea384e50adffa68d5cef08eddf8d2641b`。源 manifest 覆盖 CHANGELOG/Makefile/src/types/vendor/scripts/assets/tests。

三方串行 native-*-final3 各 40 条回执、42 条 owner 事件；native-comparison.json 的 176 项检查全部通过。比较完整 UI 控制回执（不比较 initialize 元数据），生命周期私有 cwd/session/resume 作归一化；opaque handle 实际用于各侧请求后才归一化。独立观察事件排序仅用于 payload 集合比较，重叠回包顺序和 cancel enter/exit 顺序另有严格断言。原生驱动只访问本次私有目录、localhost stub 和自己创建的 tmux TTY；无真实凭据、外网请求或共享终端输入。

验证期间其他进程新增 Channels 与构建脚本工作，初始 live ROOT 检查出现 channelNotification.test.ts 类型错误和 sourceUnchanged=false；随后 live ROOT 类型检查通过且 sourceUnchanged=true。最终工作区 L1/L2/build 使用 integrated-current 的完整冻结副本（3208 文件，包含其他进程的改动；未回滚 ROOT），而不是把变化中的 checkout 宣称为固定快照。途中原 WIP 冻结尝试因 main.tsx 已被并发改动而主动中止，所有尝试保留。

只提交候选的 16 个文件增量，根工作区原有 WIP 及并发 Channels 改动继续保留。README 的 Channels 新章节与 print 的 Channels 注释经单独 diff 审查，无本批 Mods 逻辑重叠；不纳入暂存补丁。源码合并保留 ROOT 的 callerChain reset、远程 deep freeze 和 registration descriptions。签名、精确暂存 blob、父提交、工作区保留和两个旧 Claude 进程身份在 commit-proof.json 中记录；无 push。
