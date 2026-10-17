# Mods 远程 roster 与 SDK 连接控制 — 2026-10-07

## 验收范围

以官方 2.1.292 为固定基准，接通 stream-json 的 `ui_attach` / `ui_detach` 并对齐传输 roster 的 observation 顺序。不会把连接控制通过计为 `ui_render`、client module、交互事件、responder、完整 UI/diff 或 G5 通过。

## 官方证据

官方制品 SHA-256：`97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`，235017328 字节。官方源只作读取分析，未执行解包代码。最新包元数据检查的版本为 2.1.292；来源：[Anthropic package metadata](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)。

- `chunk-96mvg299.js` 的 `Tw` 以 clientId 存储连接，重复 attach 更新 viewport/answers，保留初始 surface，返回 false。
- `chunk-5zgdeqqz.js` 的 `WSs` / `NIt` 在 `session.attach` / `session.detach` 前同步更新 roster；hook 失败只记录诊断。
- `chunk-jjy8yg8v.js` 的 `ui_attach` / `ui_detach` 先发送更新后的 surfaces，再等待 hook 通知。会话结束按 roster 顺序通知 `reason:'end'`。
- 生成的作者声明规定这些事件为观察事件，终端 binding 不触发 attach。

原生驱动通过独占 tmux 的 stdin 向实际 CLI 管道输入 JSON 控制请求；只用私有 HOME/config/XDG/TMP/cwd、虚拟 localhost API 和 dummy key，沙箱拒绝真实 ~/.claude、Keychain 与外网。各端串行执行，前一端正常退出、HTTP/请求线程及自有 tmux/进程组全部清理后才启动下一端。

## 实现和验收边界

新增 host-only `runtime.remoteClients`，对外作者 `$` 不增加 capability。控制入口先校验，再变更 roster 并回执；通知 promise 独立收尾。显式传输连接保留到 detach/end，绘制站点释放只释放它自己的引用。

旧内部 remote consumer 尚未统一为实际传输连接，仍以站点引用计数管理未显式连接的客户端；后续绘制桥需要统一该路径。对远程 `answers` 只验证并记录声明，不据此宣称五类 responder 已能工作。Mods session 不可用时返回明确错误。当前 Print 启动初始化的其他字段与官方、完整 surface admission 与客户端资源协议不在这项有限结果之内。官方还在显式 attach 后发出 system/ui_panes 通知，本批未接通这类通知，不把整个 stdout 流算作相同。

## 执行记录

证据根：`/private/tmp/mods-remote-roster-292-20261007-wfq1i0yl`。原生原始结果、精确命令、环境、fixture/driver/binary hash、stdout 与逐请求事件记录在各 `native-*/evidence/result.json`；所有失败尝试保留。

- `native-official-red1`：驱动直接使用 TTY stdin，官方 print 拒绝无 prompt；已清理。随后改用 tmux 内的 `cat | CLI` 管道，实际 stdin 输入仍由自有终端传递。
- `native-official-red2`：含 ui_render 的真实协议全部取得回执；末尾日志解析误将已带引号的 REDACTED 再次加引号，驱动记录 extractionError。保留原始 stdout/debug；后续修正解析再重新验收，不将此尝试算作最终通过。
- 修复前候选/工作区对连接控制返回 `Unsupported control request subtype`，证明实际生产入口缺口。
- 最终聚焦测试、类型/构建及三端控制请求比较追加在本报告末尾，以 JSON 证据为准。


## 原生启动竞态与修复

`native-workspace-final2` 获得全部连接回执，但只记录 7 条 owner 事件：session.start 晚于三次 attach，attach 通知因捕获尚未发布的空 hook 列表而遗漏。该轮不能算通过。修复为 SDK 控制等待 inbound binding 完成，直接 host 通知等待当前发布队列后读取 hook 列表；补充延迟发布的真实 Worker 回归与绑定前控制回归。未在驱动中加入等待插件就绪的延时来掩盖竞态。

另一个保留差异：fixture 的空 `register()` 在官方可加载，本地报告需要 on 参数。它不包含事件，本批只比较 owner 的连接事件；loader 的这个差异须另行修复，不能宣称所有 fixture 插件完全同样被接纳。


## EOF 管道边界

`native-candidate-eager1` 一次输入全部 12 条控制请求后立即 EOF，仅收到 initialize 与四项非法输入回执；合法连接控制仍在等待 binding，而输出已关闭。官方 `native-official-eager1` 收到全部 12 个回执。修复为控制器跟踪尚未发送回执的请求，print 在 EOF 关闭输出前等待这些请求；不等待 attach hook 的完整执行才发送回执。最终 EOF 对照另附结果，失败尝试保留原始日志与完整清理记录。


## 最终结果（final5 源码）

- 15 文件聚焦回归：候选 521 pass / 0 fail / 3 skip，工作区 549 pass / 0 fail / 3 skip；原有 skip 保留。候选 2493、工作区 2588 个断言，以原始日志为准。
- candidate 的 test / release-check / build 均 exit 0，source hash 固定为 `3337f0c002869a790a99003a02c6d46150e4a7b6d27d5f1411ba1a61cab14cca`，检查前后源码未变，所有构建/测试自有进程组已清理。
- workspace 的 test / release-check / build 均 exit 0，source hash 固定为 `7830a4e91bacee7b8d1ea7aed9b32428d19a64e60924c0da5cc16cb4080ac39f`，检查前后源码未变，所有构建/测试自有进程组已清理。
- `native-{official,candidate,workspace}-final5`：同一 driver hash、fixture 和输入；各有 12 个控制回执与 12 条 owner 生命周期事件。69 项比较通过，三端正常 EOF exit 0，HTTP、请求线程、tmux pane/server/process group 全部清理，无模型 POST。
- `native-{official,candidate,workspace}-eager2`：一次输入全部 JSON 行后立即 EOF，各取得全部 12 个回执；按 request_id 对照 initialize 以外的 11 个回执，并核对 10 条生命周期事件。44 项比较通过；三端正常 exit 0、完整清理、零模型 POST。此并发结束路径不要求 attach 的 150 ms 延迟 hook 正常退出后才关闭，官方与本地均保留相同的取消/结束观察。
- 控制回执时机、readonly 事件、duplicate/no-op、输入错误、真实 hook 错误、不回滚的 roster、session.end reason 与末尾 roster 均有证据。initialize 字段、system/ui_panes、ui_render、交互/client modules、admission、responders 及 loader 空 register 差异继续处理，完整 API/UI/diff/G5 未完成。

| 制品 | 字节数 | SHA-256 |
| --- | ---: | --- |
| official | 235017328 | `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f` |
| candidate | 102199778 | `d767f61d09be0aa06202d7d311e954327753be43079e89f0076c0802a5f1382c` |
| workspace | 102084194 | `238b272e4ebd9a4ab24edbf93943d66e0eec598577ba56e5c3bcece0e37d351e` |

最终比较：`native-comparison.json` 和 `eager-comparison.json`；源码/官方提取来源：`official-source-manifest.json`；签名与原 WIP/进程保留状态以本证据目录的 `commit-proof.json` 为准。最终比较只证明此有限专项，不把整段 stdout 或所有 Mods 行为算作一致。
