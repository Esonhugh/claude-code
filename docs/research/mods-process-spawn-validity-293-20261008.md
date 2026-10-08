# process.spawn 与验收有效性

本批接通真实 process.spawn；完整 Mods、终端/UI 与四路发布仍未通过，官方 oracle 和源码单测不能替代本地 binary。

## 来源与契约

Git 基线 72f28776057278cc110a34f82a7abba490cd096e。固定官方2.1.293嵌入声明 SHA 为 9a78f057e9a3abf3228a59e7f8ed50e2150fb0b1f02312dd4efc033466dfcc95；主来源 chunk SHA 为 5bb5d783ea57231ddbe2e119fc706cfde18ee5e6493f9ac10fe2c9eab9739f43。固定版本不自动代表今后的 latest。

公开调用同步返回流，投影 argv/cwd/env/input；真实 host 合并会话 cwd/env、写入并结束 stdin，UTF-8 解码 stdout/stderr，返回 code/signal。1 MiB 字符积压阈值控制两根管道，无 run 的输出截断或 timeout。middleware 读取 ValueOrDeny，公开 facade 读取 raw value；官方仅检查 value/deny 外层，作者 TypeScript 定义仍严格要求正确 code/signal 类型。

public stream 的环境 lifetime 与 invocation 持有的 next 分开，标记来自可信宿主 WeakMap，作者不能伪造 owner/signal/lifetime。正常 hook 返回保有流，父取消、超时、主动关闭和模块卸载停止归属该操作的孩子；退休后不得首次启动孩子。关闭还枚举已脱离原进程组的后代，SIGKILL 前重查开始时间。

正常/恢复 invocation 各有新操作控制器。正常返回不 abort；timeout/显式关闭 abort；catch 使用新的控制器，保留的 next 分支独立继续，不能重播。普通 spawn hook 的自身预算按下游块及外层 pull 重置，catch 只有一段1000ms；共享 turn.step 保持累计预算。

首次 pull 前 return 不启动孩子、result pending；读一块后关闭拒绝未完成结果，错误 HooksError；与等待中的 pull 同时 return，该 pull/result 完成、value undefined。共享取消层保留实际进入的原因，避免换通用错误制造额外 teardown failure。

## 实际失败与处置

隔离原件目录 `/private/tmp/mods-remote-composer-292-20261008-rptx4ocs`。各 epoch 的 before/result/log 保存实际命令、私有环境、源码摘要、结果与自有进程组回收；修复建新 candidate，旧原件不回写。

| 原件 | 处置 |
|---|---|
| process-spawn-red1 | 真实 loader 拒绝 unsupported core capability，保存缺实现 RED。 |
| retirement-red1 / boundary-red1 | 真实退休首次pull、关闭、每块预算及跨进程组后代缺口；后续独立修复。 |
| process-spawn-testing-red1 | 真实 plugin test runner 返回 Promise/Unsupported；修复同步流与raw/wrapped区别。 |
| process-spawn-callback-deny-red1 | 真实 test runner 的 host callback 吞掉 HooksError 与 author/op 前缀；独立修复并校验名称、消息和 result 拒绝，依据官方 public factory 源码，尚未声称官方 native testkit 实测。 |
| process-spawn-final2-native1 | 八项 CLI 功能契约均满足，但自有 tmux socket 未释放，整体失败；保持 cleanup 必须成立，复用已有 socket 身份核对和关闭 helper 后重新验收。 |
| spawn-native-official-receipt4 | 八个官方实际 tmux author 案，正常退出、六个自有孩子已退出，异常 value 透传；不是本地通过。 |
| process-spawn-receipt-red1 | 本地过严深检查触发 fallback；按官方外层检查对齐。 |
| process-spawn-target-red1 | exit0，但新增回归未进入默认执行清单，不计新target覆盖。 |
| process-spawn-target-roster-red1 | 改入实际retained清单，默认入口真实拒绝缺process target映射。 |
| process-spawn-closure-driver-red1 | 实际默认回归揭示七种 final-coverage 误接收：漏列原件变化、改ID、去hash、漏原件proof、改report并重hash、binary/probe重绑；固定唯一断言ID、driver持有完整proof map/report/binary/probe身份，并最终重读全部原件和回算，旧GREEN不继承。 |
| timeout-red1 / timeout-fair-red1 | 先到Worker心跳/下游等待暂停预算，未到目标取消边界；不能冒充该边界产品RED。 |
| process-spawn-timeout-idle-red1 | 首次真实pipe pull返回，自身预算实际超时，fallback完成但child未退出；finally卸载回收。真正取消缺口RED。 |
| process-spawn-timeout-green1 | 超时停止孩子通过，但close callback作用域错误使三项失败；不是最终通过。 |
| process-spawn-scope-green1 | 过渡source54eaaa6e…，22/0/123expect；实际超时停止旧孩子与catch新孩子退出通过，不代表最终binary/gate。 |

相邻 runner.integration 的旧 usage 夹具缺官方必需 startedAt；干净 HEAD 的 process-spawn-usage-baseline-red2 与候选 process-spawn-usage-candidate-red1 均真实失败。补全 stub 和完整 expected value 的 startedAt，保留 schema 校验和无生产服务断言；首轮 baseline-red1 缺 ignored 证据目录属夹具错误，不作为产品RED。合并14文件的 final7-tests1 在120s上限停止，不能记通过，后续按完整文件分组串行重跑。

相邻 hostOperations 曾有87/1 hardlink realpath差异；干净HEAD与后续recovery各88/0。未称最初失败为确认的旧问题，未放宽断言；最终同epoch仍重跑。只读独立审查 `/private/tmp/mods-spawn-testing-review-j_x9pd33/REPORT.md` 固定testing-green的19/0，58项输入复读零漂移、ownedJobs=[]；value检查及stream timeout在后续epoch独立修复，旧报告不继承新结果。

## 可执行验收

run-binary-gate 从相关 host/runtime/dispatch/protocol/loader/environment/worker/testing/runner 路径强制加入 mods-process-spawn，保留其他全部required targets。新binary的作者 slash command 在隔离HOME/config/cwd/sandbox/tmux/socket及dummy credential中触发八个契约，不能拿readiness或组件mock代替。

validate-mods-process-spawn 保存原始PTY、输入hex journal、debug receipt、实际child ledger、driver及binary copy。关闭报告摘要由stdout交给门禁持有；门禁重查该摘要，再读关闭原件核对摘要与receipt/child/input，重新计算检查项。改写report、漏child、绿色标记或缺原件不得通过。静态官方JSON只用于验证器负例，不是当前binary证据。

```sh
bun test ./src/services/mods/processSpawn.test.ts ./src/services/mods/processSpawn.types.test.ts ./src/services/mods/processSpawnTesting.test.ts
python3 .claude/skills/release-validation/scripts/test-release-driver.py
make release-check
make build
```

新binary、动态baseline及完整gate须同一冻结epoch串行执行。实际完整命令、结果与清理在driver-final-manifest.json中；身份不匹配、缺required target、错误receipt或遗留进程失败。Native35六项、完整diff/Client/browser/终端生命周期及其余11个生产方法仍未闭合，不因本批单测而勾掉。

## 最终有限处置（2026-10-09）

Native36 完整门禁正常结束：30项 / 24通过 / 6失败，overall failed。新增 mods-process-spawn 通过实际八项作者 CLI 契约和最终关闭原件重查；其余失败为 builtin-mods、code-review、terminal-canonical-diff、terminal-interaction、workflow、workflow-retry-partial-failure。

| 入口 | 实际结果与边界 |
|---|---|
| final8-tests1 + runner1 | 完整14文件746通过 / 7原有skip / 0失败，2653 expect；保留旧skip，不宣告所跳过路径通过。 |
| final8-check1 / build1 / driver1 | 同一冻结source通过release-check全阶段、新build及实际默认release-driver入口。 |
| full-gate36 | 完整30项正常结束24通过/6失败，新target通过最终coverage重查；全部旧required及七个additive目标保留，无outer timeout。 |
| integration-tests1 | 私有合并快照21/1，既有test registrar只接受turn.step生成器，真实process.spawn testkit被拒绝。 |
| integration-green-tests1 | 独立合并source44/0/251expect；保留原有懒加载/注册校验，绑定native generator next并准入exact process.spawn。未修改其他Claude工作代码用于“通过”，未等同主binary epoch。 |

主source `b5fb32bf65f5c2b5bfbab8bd002c19651f55ab729c173915a95ce8ce52beec7b`；binary `fdca27fe4253014308298f15d592dadc6d6964ce6ebaa1956c650b65edd20b81`；manifest SHA `5c4a0735d23050ca8b9ca462e4640b0093f8a66ba46d78f1f8dd7d7be044b17f`。最终process断言覆盖955个原件文件；root/held report/binary/probe/evidence map均由driver持有，完整roster、重算的检查项及最终复读均通过。源码无漂移、自有driver进程组退出；原报告和反例不回写。

完整原件：`/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/full-gate36-evidence/driver-final-manifest.json`，摘要处置：`/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/full-gate36-disposition.json`。相关default RED：process-spawn-closure-driver-red1；default最终GREEN：process-spawn-final8-driver1。只读审查final4问题与final6有限修复分别封存于 `/private/tmp/process-spawn-final4-readonly-16zgvl9n/REPORT.md`、`/private/tmp/process-spawn-final6-readonly-1ij0ikpb/REPORT.md`；后者SHA `bebd25c1438b5fa65b4c742e5d7e07797ce46fa4c713fd11942be9716d02132e`，没有运行验证或借未来结果。

文档闭合在新candidate中更新；编译代码、生产门禁和probe与已验证frozen source逐字节等价，未重写它的before/result/log。提交按实现、验收、文档拆分；组合最终代码使用该验证，逻辑中间提交没有分别运行完整gate。现有ROOT其他Claude WIP保留在工作区，私有合并验证仅覆盖列出的44测试；不存在全工作区或四路发布通过结论。官方native testkit拒绝与跨turn.step超时的retained-next组合仍未实际双端覆盖。
