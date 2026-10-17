# Scope 身份及验收封存复核（2026-10-08）

完整发布验收仍未通过。本批修复验收器的身份、收尾及最终证据复验；不宣称官方 Mods/UI/diff 已完全兼容。

## 实现与有效性

`code-review` 的空变更 Scope 验收必须把真实父会话的 WorkflowTool 调用和回执、Task/Run、CLI session、原生 child Agent、原始 prompt/schema、StructuredOutput 调用及回执、缓存结果和完成通知连成同一次运行。缺失或交叉 UUID、错误 sidechain/sourceToolAssistantUUID、不同 task/run/session、伪造 XML 通知、结果或 usage 均拒绝。普通 foreground Agent 或其他 worker 的日志不能替代该 child。

登记锚点来自实际 start 保存的完整 metadata 原字节和本案 provider 对象。provider 完全停机后，全量内存请求快照必须等于本案 wire 文件，并包含实际传输的父回执和通知。静态整套旧文件、不同 live receipt、未登记 provider、未完成清理、活动 handler 均不能通过；没有文件回退。

provider 停机保留相同5秒 handler 收尾预算：线程在启动前按本案所有权登记，关闭 listener 后等待实际请求处理退出，存在活动线程则失败。收尾后 wire 从本案登记对象读取，解决此前 close 删除活动表造成的空请求误判。父、child 各自保留正确时序与最终通知屏障，不强制没有产品契约的跨分支全序；快速 child 先完成也可以被正确验收。

输入在第一次读取时复制到本案专属 `workflow-identity-inputs`，使用独占创建、所属路径和 SHA-256；后续原始 transcript/debug 追加不改写已保存快照。Scope assertion 的 `evidence_sha256` 覆盖全部快照和证明 JSON；最终必验与追加目标汇总重新读取文件核对哈希，缺失或不完整映射、非原件、篡改或符号链接替换均失败。读取哈希前先确认本案路径归属；从已验哈希的 canonical proof 推导完整快照集合，不能联动删掉路径和哈希绕过。最终目标还要求身份、wire、生命周期三个原有断言各唯一并属于本案；删去或改名整条断言不能通过。权限0600只是权限限制，不称为不可修改存储。

## RED/GREEN 与原件

- 旧身份驱动接受缺 UUID/伪造通知、改变 metadata、旧 wire 或无登记 provider；相同负例修复后拒绝。快照哈希不再指向可能继续追加的原始日志。
- `scope-shutdown-red1` 在旧驱动真实复现三项失败：收尾后 wire 空表、合法快分支拒绝、handler 仍被持有时提前报告停机；`scope-shutdown-green2` 三项通过。
- `scope-final-seal-red2` 的正常输入通过，但七种篡改/缺失哈希全部被旧最终汇总放行；`scope-final-seal-green3` 全部拒绝。初始 `red1` 因测试 metadata 缺 evidence_dir 导致正向无效，作为夹具错误保留，不计根因 RED。
- `scope-final-contract-red1` 复现联动删减、缺 proof 与归属前外部读取，`green2` 拒绝；`scope-required-assertions-red3` 复现删除/改名/重复 Scope 或删除 wire/lifecycle 五项放行，`green4` 拒绝。
- 干净提交候选：33 项 retained 与原有 driver 断言通过；保留共享工作区 WIP 的提交后像：40 项；包含后续产品实现的完整私有工作区：41 项。各自 runner 记录 source 不变和自有 PGID 退出。这些是驱动逻辑/隔离 fixture 回归，不冒称三个环境都完成产品 native 验收。

## 新制品完整矩阵

最终封存修复后重新 `make release-check`、`make build`、capture baseline，并以前台完整串行 driver 跑默认必验范围和追加目标。第十轮 **28/28 项执行，26通过、2失败**；整体 `failed`，失败为 `builtin-mods, terminal-interaction`。source/binary 不漂移，矩阵正常结束，workflow/auth/lease 与自有进程清理完成。

- source SHA-256：`05120a76dd98f6e6f9147f161ec81ccf48cddea6659f23e68fdb788fdb26ef6b`。
- binary SHA-256：`aa93d4ea3496d13bdb89c4b21cf58a64369c4ce2f9bf0b28a1046bb069791892`。
- baseline SHA-256：`e6f0143ccb567da497f83bfe4f70b716c37e1c67b84193491a15912d4993c2fd`。
- final manifest SHA-256：`6acc8334ff7a98eeb1831f78bf5d530f540d3bfb3db5882027adeaf6c4d1bb7c`。
- Scope 实际 Task `wbeskwbk7` / Run `wf_b2edee57-038` / Agent `a1b6a518f17fcbaaa`；10份输入快照及 proof JSON 在最终汇总与独立复读均匹配哈希。

[完整原件](/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/full-gate10-evidence/driver-final-manifest.json)、[新构建身份](/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/full-gate10-build-proof.json)、[最终封存 RED](/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/scope-final-seal-red2/log.txt)、[提交候选回归](/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/scope-required-candidate-driver-green5/result.json)。这些绝对路径属于本机私有测试记录，不是公开发布产物。

历史第六轮26/2、第七轮25/3、第八轮26/2、第九轮26/2与最早失败原件保留；第八、九轮 Scope 通过不代替第十轮最终封存补丁的 native 验收。第十轮 binary 包含完整工作区尚未提交的产品实现，不能把 native 结果归属成此干净提交候选的全产品测试。

## 明确未闭合范围

这里只验空变更 Scope，不覆盖完整 code-review 的 Find/Verify/Sweep/Synthesize，也没有将默认 Fork 改为 foreground。session:window.pane 目标和 CLI 逻辑身份不等于实际 `%pane_id`/TTY、OS 请求进程所有权或逐帧 terminal proof。

terminal-interaction 旧夹具把 canonical Mod 当成 native diff：宿主外写 mtime 不触发官方 tool.call 的150ms刷新，canonical 批量 Git 参数也不匹配 native singleton latch。两条实际入口必须分别实现和验收，保留旧失败。stdout write 镜像只能证明逻辑帧与写入回放一致；完整原生 PTY、时序、输入归属、非 Ink 区域和 resize/lifecycle 仍须闭合。七个 builtin Ink root 的独立回放成功不能代替完整 feature；同步 ACK 的 productTimingEquivalent=false。

官方最新2.1.293的声明与实现差异已另外核对，本轮固定292证据不冒称293兼容。公开 API、浏览器 Client、await-result 生命周期及完整 UI/diff 的剩余实现继续处理。正式四 Agent release gate 未通过，不 push 或发布。

## 使用

```sh
validation_tmp="$(mktemp -d /tmp/claude-release-tests.XXXXXX)"
TMPDIR="$validation_tmp" PYTHONDONTWRITEBYTECODE=1 python3 .claude/skills/release-validation/scripts/test-release-driver.py
```

逻辑回归自动执行全部 retained 测试；原生验收仍须 fresh build/baseline 和完整 `run-binary-gate.py`。`--targets` 只追加目标。归档消费者也应重算文件哈希并检查同轮元数据，不能只信 `complete` 或报告中的成功文字。
