# 发布验收有效性复核（2026-10-08）

整体验收仍未通过。此批修复收紧验收器的准入条件，不宣称官方 Mods、UI 或 diff 已完成兼容。

## 此批实现

- 所有计划目标（包括 `--targets` 追加项）必须校验断言、所属运行和证据，不能只沿用目标行的成功 verdict。
- `required_evidence` 与实际观察路径必须一致；缺失文件保留为失败原因，不伪装成已观察证据。只有空文件或目录不能独立证明断言，空 stderr 可作为已有非空证明的附属文件。
- `--targets builtin-mods` 只能追加测试，不能缩减变更推导的必验范围或跳过独立 readiness。
- builtin 必须包含终端物理证据断言；九项业务成功不能替代它。失败保留在矩阵中，后续目标继续执行。
- readiness、goal 和 SSH 本地生命周期使用私有 dummy 认证，不读取账户认证。
- `test-release-driver.py` 执行所有已定义的 `test_retained_*` 测试；旧入口未执行已提交旧入口的 19 个函数。正向 fixture 实际落盘其声明的输入与 provider 记录。

基准是本地提交 `160734a`，修复前后使用相同的最小回归。原始提交在缺失证据、追加目标、空证明、builtin 缩减范围、本地认证边界及业务成功替代终端证明六项上失败。干净候选的原有 driver 断言和 25 个 retained 测试通过。源码及进程清理由隔离 runner 记录；这属于验收器逻辑回归，不能替代产品的真实交互。

## 新构建的完整工作区矩阵

使用包含未提交产品实现的独立工作区、修复后的完整验收器和新构建，执行默认变更矩阵及额外目标，结果为 **28 项完成、25 通过、3 失败**。readiness 通过，矩阵正常退出，源码及二进制未漂移，本轮资源完成清理。`planned_target_coverage` 和 `required_target_coverage` 都正确保留失败，整体 verdict 为 `failed`。

制品 SHA-256：`69c76694286b34a6311dbb07386dff00ce115c4474d51b791618b5fedeb16c2c`。

失败项为 `builtin-mods`、`terminal-interaction`、`code-review`。它们没有被删去、改名或用其他成功案例替代；具体实现和 fixture 缺口继续处理。本记录不把独立工作区的 native 结果归属为此干净候选的产品验收结果。

## 帧证据的边界

诊断采集增加原始 PTY、实际 TIOCSWINSZ 回执、输入读取、生产进程及 capture 身份、EOF、逐帧逻辑状态和独立 xterm 回放。归档后重新核验原件哈希并独立回放，不能仅信旧报告的 `passed`。最小回归包含删除坏的中间帧、相同字节偏移上的 resize 排序、错误 viewport、自洽伪造 verdict 以及 termios 初始化失败。

七个 builtin 场景均真实运行并正常清理，其中六个完成声明 Ink root 的物理回放；native diff fallback 的正常缓冲区锚点仍未闭合。同步 ACK 采集会影响事件循环时序，尾部语义与非 Ink 区域也需独立断言，因此 `productTimingEquivalent=false`，不能关闭完整终端验收。字节已采集、root 帧正确与完整 feature 通过是分别记录的结论。

## 执行方法

```sh
validation_tmp="$(mktemp -d /tmp/claude-release-tests.XXXXXX)"
TMPDIR="$validation_tmp" python3 .claude/skills/release-validation/scripts/test-release-driver.py
```

这条命令运行驱动逻辑及隔离 fixture，保留其必要临时证据。真实发布门禁仍须本轮 `make build`、动态 baseline、`run-binary-gate.py` 的完整串行矩阵和 release-check；任何相关修复后必须重新验证，不得沿用旧 binary 的成功结果。
