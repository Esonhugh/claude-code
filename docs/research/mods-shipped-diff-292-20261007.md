# 官方 diff 2.1.292 的固定来源升级

本批只升级随包 diff 的官方来源、离线生产与构建链路。完整 API/类型/UI 对齐仍未完成。

## 来源与静态证据

2026-10-07 从官方 registry metadata 核实 latest 为 2.1.292：
[Anthropic package metadata](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)。

- darwin-arm64 binary：`/private/tmp/mods-fork-routing-20261007-2afwted_/official/official-claude-2.1.292`
- binary SHA-256：`97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`
- 完整模块：`chunk-01whafa0.js`，SHA-256 `6cd79b0d5118de9485b1268d64238019e3a41510c943eb17832b128fd976afd3`
- 身份模块：`chunk-cnv756hy.js`，SHA-256 `86406ab18044de34edba1f7247b591268b86b1cff7522aaf07f1d67725f915c7`
- 注册闭包：字节 `[12068,62473)`，导出原始 `ym as register`，SHA-256 `ccafc3393958bc6e428f8909030d06af0e50e6db73f7308ec26ac286f27e97a4`
- scan：字节 `[5666,6250)`，SHA-256 `41ada677ee5d534b88f953e89e0b8261a7cc567d538b21678f41f7d3e45319ca`
- 归档：`assets/builtin-diff-2.1.292.zip`，46070 bytes，SHA-256 `745c46dae5714492d5fe0351df623579f82000d132db8df365bf690031d1cc65`

`Source-confirmed`：加载器和离线 producer 使用同一完整模块、身份、闭包与 scan 校验值，ZIP 固定时间、拒绝覆盖；旧 2.1.291 归档保留，但最新 loader 拒绝它。保留 cc-plugin-diff@builtin 的存储与不透明运行时身份；清单或复制对象不能发行可信接管身份。

Babel 比较仅规范化词法绑定名并删除位置/注释，保留属性名、字面量、操作符；291/292 注册闭包的 AST 相同，SHA-256 均为 `2b13e1392ddf2ac59658652c43f6b9e8a87abd8407298c93af6ec5b7f4de0bae`。完整 8 hooks、23 calls、3 runCommands、1 env read 的 scan 逐项由真实启动测试核对。没有手写官方 register 替代实现。

官方作者声明整体并不相同：292 新增 prompt.autocomplete、AgentSpawnInput.workflow、ModelTextBlock 与 ModelCompleteInput 的块缓存契约，以及 HookFailure 的 re-entry/lent 描述。本批不修改仍固定为 2.1.290 的作者声明体，不把 diff 闭包相同推广成全部类型或行为相同。

## 独立候选与门禁

证据根：`/private/tmp/mods-diff-292-yah16a95`；基线 HEAD 为 `fa73aae210942edf9dd05e900bf0359c6b8d0cb7`。

独立升级树：`archive-owned/candidate`。其完整 source manifest 与 `candidate-build/before.json` 逐项相同，source SHA-256 为 `9eb83ab51c3af7eff52c15c763dd84f8b963d24af8d6345f0d6083f1ad34cd25`。它没有新增键盘路由实现，或其他工作区 WIP。

- RED `red-version`：真实 initializer 收到 2.1.291，期望 2.1.292，0 pass / 1 fail。
- `green-diff-tests` / `root-diff-tests`：相关 11 文件各 114 pass / 0 fail / 0 skip，含 archive producer round-trip、tamper/缺失拒绝、实际 runtime assets/embedded 构建控制、启动 Worker、接管/恢复、设置别名、静态发现及过期归档拒绝。
- `candidate-final-check` / `workspace-final-check`：make release-check exit 0，含 changelog、tsc、lint、missing audit 与 git diff --check。
- `candidate-build` / `workspace-build`：本轮 make build 通过，输出在私有目录，共享 ./built-claude 未替换。
- 单元测试与构建的 manifest 差别仅为新 CHANGELOG.md 条目；其余源码、测试、资产逐项相同，release-check 与 build manifest 相同。

初次候选 release-check 的最后 git diff --check 因 archive 目录缺少 Git 元数据退出 129；补齐私有只读对象来源及独立 index 后完整通过。未修改产品代码来规避门禁。

## 真实终端

`Runtime-observed`：官方 `native-official-o2`、独立升级候选 `native-candidate-c2`、工作区 `native-workspace-r2`，各保留 driver、exact inputs、PTY raw、ANSI/文本/capture 状态、debug 与 result.json。

同一 Git fixture、160×40 起始 viewport、dark/fullscreen 设置、占位 auth、无外网。流程为 /diff、160→140→160 缩放、mouse ask/取消、Esc 返回、/diff 关闭与重开、/exit 正常退出。按键输入一致；鼠标坐标根据真实控件位置计算并记录。面板稳定性以重复 ANSI cell 收敛判定，未以固定 sleep 或单张最终截图作为成功。

裸 Esc 紧接下一段文本的原驱动失败见 c1 和 keyboard-owned/a1、a2。私有诊断显示未收到 escape，而收到后续 return；CSI-u Esc 明确触发 escape，见 keyboard-owned/a3。修正驱动协议后官方与候选完整流程通过；原失败证据保留，deadline 仍为 90 秒。该假失败不能作为键盘修复必要性的证据；另批键盘修复由独立最小 Ink 回归证明。

## 验收边界

| Assertion | Verdict | Evidence |
| --- | --- | --- |
| 原始官方模块、闭包与身份来源可核对 | passed | provenance-292.json、producer round-trip、闭包 AST 比较 |
| 启动实际 Worker 并由插件接管 /diff | passed | shippedDiffStartup、diffTakeover、native package/ownership debug |
| 过期/损坏归档保持启动与原生 diff 可用 | passed | missing/tampered/outdated 启动回归 |
| 正常真实交互与退出 | passed | o2/c2/r2 的各阶段 capture、debug、正常退出状态 |
| 当前工作区四个稳定阶段右侧面板字符/样式/位置 | passed | workspace-native-comparison.json：含未提交 UI 变更，36 行及全部位置/样式相同，不能据此为独立升级候选背书 |
| 完整独立候选面板字符/样式/位置一致 | failed | archive-native-comparison.json：160 列 border start 80 vs 官方 88；140 列 70 vs 77；四阶段均不同 |
| 完整最新公共 API/类型/UI/G5 | not covered | 不在本批固定来源升级范围内，整体目标未完成 |

[Anthropic plugins 文档](https://code.claude.com/docs/en/plugins) 提供使用背景；本批精确内部契约取自固定官方制品并通过本地实际 Worker 与终端核对。
