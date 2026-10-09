# 原生 resize 请求关联的有效性处置

本批修正验收控制器的证据采集与关联，不改变产品渲染调度。完整 Mods、终端输入 owner、无观测时序和发布验收仍未通过。

## 保留原始失败

Native50 在同一冻结 source/build 上完成默认完整矩阵和原有追加目标，正常退出，共30项，27 passed / 3 failed。原始 final manifest、source reread、关闭回执及失败保留，不因本批修复改写。canonical Git 的 actual start/close、实际参数与完整读流摘要已经通过；builtin-mods、terminal-canonical-diff 和 terminal-interaction 尚未全部通过。

terminal-interaction 的 action3 ACK 为 io84，action4 send 当时读到已发布尾 io83。旧关联以 `ACK.ioId <= nextSend.lastObservedIoId` 拒收。该尾来自独立 publisher 的异步文件，不能证明下一命令何时执行；原请求记录没有实际 driver Mach clock，因而既不能补造成功时序，也不能据此判定产品绘制错误。该案维持 failed / 时序证据不足。

## 当前记录与核对

Green3真实完整15项CLI检查有14通过、1因运行期间registration.json尚未发布而失败，正常wrapper退出1，原件及失败保留；不称产品resize错误。broker改为在启动producer前独立保存其内存登记原件，关闭时核对同一原件而不重新生成；登记发布发生在producer启动前，不新增产品ACK。

Python 和 Bun 控制器在实际 resize 命令前后读取 `mach_absolute_time`、`mach_timebase_info` 与 `pthread_threadid_np`。实际pre/post采样之间不落盘请求日志；send/return暂存在控制器内存，post之后按原顺序发布，不等待ACK。各自保存真实 caller PID/thread；captureId、nonce 和 childPid 来自已准备 launch、registration 和 start 原件，不用 child PID 冒充调用者。launch 保存实际 driverPid；最终 replay 将其与原件核对。时钟与线程 ID 按精确十进制字符串跨 JSON，拒收浮点、非规范字符串、uint64 溢出、错案、错 PID/thread 或 timebase。

`native-driver-mach-frame-geometry-v2` 要求真实 send <= command return、send <= ACK.entry <= ACK.return，前一 ACK.return 不跨下一实际 send。SIGWINCH 为异步交付，ACK 可以晚于命令 return。多个请求在途而无法唯一关联时保持未闭合，不用尺寸或数组顺序放行，也不把关联不足写成产品 resize bug。

已发布 IO/frame/raw 尾保留为完整 prefix 和单调性证据。正输出 frame 仍必须在实际 ACK.return 之后、下一实际 ACK.entry 之前，绑定原 frame span、原始字节、相同 nonce/PID/timebase、物理尺寸和逐 cell 回放；zero-output observation 不能代替实际 paint。没有真实 driver clock 的历史 capture 不升级为 v2 通过。禁止新增每键 ACK、固定等待、全局 redraw 或放宽物理断言。

## 分层判定与剩余项

新增合成因果回归在未修复实现下 1 passed / 14 failed，分别揭示异步尾误拒收和实际 clock 缺失未校验。合成数据仅验证关联合同，不能充当真实 CLI/UI 证据。Green1/Green2/Green3的前置结果不作为最终验收；只读复核发现pre之后同步写send日志会扩大实际命令前的采样间隙。新增原caller发布顺序回归在未修复版本失败；red3保存Bun原始命令异常被post-clock异常覆盖；Python RED首先停在发送前已有两行的顺序断言，未独立执行后面的timeout返回字段断言，不能据此称这些字段已由该RED验证。修复后Green3的真实caller合同测试执行了null/commandError/clockError断言。原命令错误与观测错误分别记录，观测错误不覆盖原失败，没有exit回执的超时保留null而非编造退出码；修正后必须重新冻结并执行全部前置步骤。Green3只读复核又指出publication本身的ENOSPC/EPERM可能覆盖先前命令错误；red4保留该负例。控制器对clock与publication错误分别记录，优先重抛已发生的原命令异常；无法完整写出原件的capture仍失败，不以错误保留为采集成功。另以独立 libSystem Mach 采样核对 Python/Bun 实际 caller clock；最终 CLI 与完整矩阵必须由同一冻结源码的新 build 重新执行。

native capture 的 bounded identity/physical 与 full gate 必须分别报告。当前脚本仍有旧后端 file roster、full/input/timing 条件与收尾混用的问题，需独立修正和新回归；本批不把 `productTimingEquivalent=false` 或 `fullNativeGatePassed=false` 改为true。真实 child read/parser/owner、React/Yoga/resize生效 witness、完整 termios 和无观测对照尚未闭合。

## 执行入口

```sh
bun test --no-env-file ./scripts/native-driver-geometry-clock.test.mjs ./scripts/native-driver-clock.test.mjs ./scripts/native-frame-journal-replay.test.mjs ./scripts/builtin-terminal-evidence.test.mjs
python3 scripts/test-native-driver-clock.py
python3 scripts/test-native-report-consumers.py
make release-check
make build
JOURNAL_TEST_BINARY=/absolute/path/to/this-build/built-claude python3 scripts/test-native-frame-journal.py
```

完整矩阵仍使用 release-validation 的动态 baseline 和原 `run-binary-gate.py` 默认 targets，追加目标不能替代或缩减默认矩阵。任一失败、缺回执、source漂移或必需层未覆盖，完整 verdict 继续 failed。

## 官方样本

2026-10-09 捕获的官方公开包样本为2.1.295，[元数据入口](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)及包 integrity 在独立原件中保存。静态对照确认 process.run 核心及参数/五字段结果与固定2.1.293样本一致；新增 ui.notify、MCP requestMeta/meta、Button Text children 和 generic Worker op 退役/reload规则仍需独立实现与动态验收。本批不以静态一致推断完整官方兼容，也不把固定样本版本永久称为latest。
