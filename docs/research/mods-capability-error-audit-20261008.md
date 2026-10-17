# Mods 能力异常边界：Proxy 回归及验收范围

日期：2026-10-08。固定父提交 `45ebeb94fb852a18eed6d67df21e5e2063cc2bed`，本地未发布版本 `2.1.280`。

## 问题和修复

宿主能力抛出的对象已经通过安全消息提取，但随后判断 `error instanceof Error` 会调用 Proxy 的 `getPrototypeOf`，读取 `error.name` 也可能执行任意 getter。这样会让宿主 catch 自身抛错，破坏待返回的能力错误与 activeCall 清理。

本批只修改 `src/services/mods/environment.ts` 的 `HooksError` 标签提取：先排除 Proxy，仅读取普通对象自身的 name 数据属性；不执行 accessor，也不沿 prototype 查找。原生错误消息、原始错误身份及原有 fallback 不变。

## 保存的失败和修复后证据

证据根目录 `/private/tmp/mods-remote-composer-292-20261008-rptx4ocs`，所有执行使用私有 HOME/config/tmp，未复制账号凭据，未改写 ROOT binary 或其他 Claude 进程。

- `proxy-candidate-red1`：父实现真实 Worker 测试 **2 pass / 1 fail**，Proxy `getPrototypeOf` 在 environment.ts catch 中抛出 `must not execute`。该失败记录保留。
- `proxy-candidate-green1`：同一测试修复后 **3 pass / 0 fail / 10 assertions**。ordinary、accessor、Proxy、原生 DOMException、伪造原型与 primitive；accessor/Proxy traps 调用次数为 0，原始异常身份保留。
- `proxy-candidate-check2`：完整 `make release-check` exit 0，含版本、changelog、TypeScript、控制类型、lint、imports/assets 与 `git diff --check`。
- `proxy-candidate-build1`：本轮 `make build` exit 0。干净候选源码集合 SHA256 `f0b32863928fab9e370f411365217d4d1100ccda66199b6f8de48bfdc28e7a95`。
- `proxy-harness-build1` / `proxy-harness-native1`：同一 build/compile/embedded Worker 流程编译实际 environment.ts 和 worker.ts，仅用临时 bootstrap 注入宿主能力错误。六种错误结果、零 trap、原始身份及 Worker dispose 共 **8 项**通过，normal exit 0，own process group gone，输入源码未漂移。编译制品 SHA256 `212efb346f5c455150974dc1e6bb4ecf50c8c84c39562327e83472f6721bee5f`。

## 验收结论的边界

这是实际 Worker 边界的源码回归和编译故障注入。最后一项使用替换 bootstrap，**不属于正常 CLI/PTY 入口验收**，不将其宣称为官方完整 API/UI/diff parity 或全量 release gate。首轮检查 archive 缺 Git 元数据而失败，已保留为 `proxy-candidate-check1`，未算通过。

规格和单测：covered。编译 Worker 故障注入：covered。正常 CLI 的全部相关生命周期、逐帧/physical、浏览器 Client 与完整发布矩阵：继续验收，未据此放行。
