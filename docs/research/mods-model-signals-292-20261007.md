# Mods model.complete 作者 options、取消与回执对照（官方 2.1.292）

本批候选从 `8cacfa0912ac5520ab2a98680d9717ac39bcc284` 构造；只纳入模型完成取消和直接受影响的结算/日志路径。ROOT 其他未提交功能、父 turn.step 取消、fork、调用链、UI/diff 和全量发布门禁保持独立。

## 契约与证据来源

- Source-confirmed：本轮 registry `latest` 仍为 2.1.292，包 shasum `ecf88deee4c6b1b099d14a8571f1d5cad2ff1897`。固定官方 binary SHA256 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`；版本来源 https://registry.npmjs.org/@anthropic-ai/claude-code/latest 。
- Source-confirmed：本地提取的 `chunk-r9hj3tk2.js` 的 Hw/bs/bm 与 `chunk-vnyc2bdc.js` 的 Das：signal 读取一次；已取消时先于请求规范化返回共享冻结回执；不用的 options/额外参数被忽略；信号以结构形状检查；拒绝时作者 signal 已取消则返回共享回执。静态提取物不执行、不上传。
- Binary-observed：真实命令 `/owned-params <scenario>` 进入官方 stdin，35 场景分别覆盖无 signal/额外或非对象 options、非法/空 signal、提前取消与错误请求/getter/回执身份、活动真实及 duck signal、修改回执、迟取消、deadline、Hook 中取消、HTTP 中取消和并发调用。
- options 信号不是 `model.complete` 的 `e` 字段。提前取消不进入 Hook/HTTP；普通及核心超时/取消回执与 usage 可修改；作者端提前/Hook 取消回执冻结。并发只取消目标调用，成功与取消后均移除监听器；getter 一次，提前取消时不读取请求 getter。
- 作者声明仍严格要求 `ModelCompleteOptions.signal?: AbortSignal`，运行时 JavaScript 的宽松 options 不扩大 TypeScript 契约。

## 实现与回归边界

- Worker complete wrapper 复用冻结回执，快照 signal，忽略未使用参数，并只对 complete 的普通返回值保留可变数据；引擎、公开事件与其他结果的既有冻结策略保留。
- 按环境+调用编号存储独立 host 控制器，跨 Worker 只传取消事件与原因名称/消息；公开事件不携带 signal。自有模型信号合并保留原始原因，完成/卸载清理控制器和监听器。
- model.complete 分发给协作式核心和 Hook 有界结算机会，避免抢先拒绝破坏核心的取消回执；忽略取消的核心在 5 秒 grace 后拒绝。其他事件的立即取消行为仍有原分发器回归覆盖。
- `ui.log` 可在活动 Hook 处理取消时完成最终诊断，卸载状态仍拒绝写入。只有模型 Hook 的取消消息在本批新增 reason 投影；通用 next.signal 的完整 AbortSignal/其他事件原因契约尚未关闭。
- debug 新增 `environment/call/active` 三项；双方各三条活动取消记录，不含 prompt 或取消原因文本。正式模型日志继续记录解析模型、参数、deadline、结果和用量。
- ROOT 旧取消 WIP 的“null/空数组/extra/null signal 全部非法”断言根据官方观察纠正，四次成功/一次 HooksError 的原 intent 有明确检查；该 WIP 文件未进入本批提交。父取消/classify/fork 的既有 WIP 保留。

## Assertions

| ID | Subject / predicate | Required / observed evidence | Runtime | Verdict |
|---|---|---|---|---|
| MCS1 | options、信号形状、请求检查先后、getter 次数与回执身份一致 | 原始官方源码窗口、31 个作者表达式 fixture；三侧 35 场景 | done | passed |
| MCS2 | 普通/核心取消可修改，提前/Hook 取消冻结 | 自动化 mutation/frozen 检查及三侧精确回执 | done | passed |
| MCS3 | 并发与环境隔离、detach、取消理由与最终日志 | Worker 阻塞/释放回归、HTTP/hook entered/completed 因果屏障与 reason 回执 | done | passed |
| MCS4 | 相邻分发/UI/模型路径、严格作者类型 | 最新候选/ROOT suite、release-check、三侧实际生成声明正反例 | n/a | passed |
| MCS5 | 构建来源、输入、原始 fixture/二进制、进程/服务终态 | source manifest、构建 metadata、原始 pane/ANSI/raw/debug、正常 exit0、自有 HTTP/server 清理 | done | passed |
| OPEN | 父 turn.step 原生取消、classify/fork 全路径、完整 API/UI/diff/G5、155 文件逐文件门禁 | 当前批次不足以证明 | n/a | not covered |

## 最终检查

- 候选 `candidate-suite2`：**601 pass / 0 fail / 5 既有 skip / 2197 expect / 20 files**；ROOT `workspace-suite2`：**635 / 0 / 5 / 2327 / 21 files**。不把不同轮次/两份源码相加为一个全量数字。
- 双方 `make release-check` exit0（39.726/41.771s），`make build CLAUDE_CODE_BUILD_DIR=<独立路径>` exit0（3.719/3.777s）；本地版本仍 2.1.280。
- 候选 source manifest SHA256 `f4b01289babb2656ec156c068014b41f1fc7733ba54f9467758806656bb568df`，ROOT `0e9705ba90de2b1892ef4eeff2aeb6af36bb1dd5c2c3c667c215bf93033fc828`，检查/构建/最终 suite 期间均保持不变。
- 新候选 binary SHA256 `621ceecd1f57c9a48e697c20ae034b1cffe1ad0168dc1abf43bbe49d01885c47`；新 ROOT 隔离 binary `7f96c530f02839704c5bc4c25495689c3b9cf92bad45d6883e6a737135ae1b8b`。未覆盖共享 `built-claude` 或 `official-claude`。
- 官方/候选/ROOT 最终每侧 **35 回执 / 20 enter Hook / 1 caught Hook / 19 HTTP**；literal stdin、fixture、所有回执字段（包括冻结、getter、attach/detach、因果屏障）、事件/原因与请求投影一致。
- 请求比较先验证 attribution 版本/CCH 及 metadata 身份形状，然后只排除 attribution 首块及动态 metadata；其他 HTTP 字段全部比较。**不声称完整请求 body 字节相等**。
- HTTP 的 entered/completed 文件屏障确认取消回执早于受控回复；并发另一调用成功。所有侧正常 `/exit` exit0，自有 HTTP、request threads 和 tmux server 已停止，无 dropped 日志，原始 fixture 和 binary 哈希不变。
- 三侧实际生成声明以 TypeScript strict/noEmit/skipLibCheck=false/lib.es2023 编译；7 个预期非法类型都被拒绝，允许普通回执 text/usage 修改，0 diagnostics。声明文件哈希不同，不宣称字节一致。

## 原失败与修复

- 原 HEAD 作者契约 RED：11 pass / 20 fail；保留 `candidate-red-options`。
- 第一版原生候选 `native-candidate-extended1` 虽正常退出，仍有两条冻结状态差异，且缺失 Hook caught 事件/最终日志；明确为 **failed**。记录 `native-comparison-extended1-failure.json`，没有将“进程退出成功”当成功能通过。
- 新核心/Hook 回归的有效 RED `candidate-red-cancel2` 为 5/2；初次 fixture 使用不存在的 flush 方法、一次 logger 导入错误、后续合并信号丢失原因的失败分别保留。fixture 改用公开 settle、修正导入，并以模型专用合并保留原始原因；不删除或弱化预期。
- 修复后最小测试 `candidate-green-cancel5` 97/0；最终 suite/check/build 及三侧 native 重新执行，报告只使用最终状态。

## 本地可审计记录与复现

全部本地证据根：`/private/tmp/mods-model-cancel-292-20261007-7yiuynpk`。

- 自动化驱动 `run.py`，每项 `start.json/result.json/before.json/log.txt` 记录精确命令、配置、source SHA、退出、deadline 和自有 PGID；不用个人 API key，不复制凭证。
- 交互驱动 `native-options-extended.py`；三个 `native-<side>-extended2/evidence/` 保存该次 driver、argv、160×40 terminal、stdin hex、pane/ANSI/raw/debug、生成声明、HTTP 请求及退出证据。每次唯一 HOME/config/cache/runtime/tmp、仅本机 HTTP/自有 Unix socket，禁止读取个人 Claude/Keychain 状态。
- `compare-native.py extended2` 的三侧结果：`native-comparison-extended2.json`；`bun check-author-types.mjs` 的结果：`author-type-comparison.json`；新 debug 检查：`<side>-signal-debug-audit.json`。
- 可重复自动化：`bun test --no-env-file ./src/services/mods/modelSignals.test.ts ./src/services/mods/modelLocalCancellation.test.ts ./src/services/mods/modelAbort.test.ts`。fixture 中的表达式/预期来自自有官方 probe，不含官方提取 JS。
- 原有 Claude PID 94223/70780 的启动时间和命令只读核对一致；未发输入或信号。提交前严格对照原 3154 文件，3145 个非本批原文件的字节/mtime 保留，GPG 签名与候选精确 blobs 在提交后另行验证。

接口背景：[Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)。文档描述不足之处使用固定官方源码+实际入口观察；不据此扩展为完整兼容结论。
