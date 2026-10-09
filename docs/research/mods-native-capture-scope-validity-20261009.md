# 原生终端证据结算与后端选择

本批修正验收消费端，不改变产品输入、绘制或 resize 调度。完整 Mods、真实输入 owner、完整生命周期与时序等效仍未闭合，不称发布通过。

Native52 同一冻结源码与新构建的默认完整矩阵正常结束，30 项中27 passed / 3 failed。两条终端路径的实际身份、物理帧、resize关联、业务状态检查通过，剩余 cleanup=false 来自 seal_exit=1；builtin-mods 仍失败。原 manifest、源码复读与实际进程关闭证据保留，不用后续修改升级旧轮。此前环境 Native51 在 readiness 前因 PermissionError 退出、0项执行，也保持 failed / incomplete。

真实 CLI 最小 RED 在新构建上复现：实际原生登记、关闭回执及独立物理回放合法，bounded=passed、full/timing=false，旧 seal 却返回1。失败位于当前消费者同时要求 native flags=true 和旧 FIFO validator 的判断，不能称像素或产品收尾故障。RED1 实际1案失败，正常 wrapper 退出1、源码无漂移、所属进程组已不存在；原件保持。

Green1源回归102通过/1失败：旧legacy合成classifier夹具缺启动协议原件；结果保留，不称产品故障。Green2显式登记该unit夹具并以bounded范围测试物理消费，另断言默认full拒收；不放宽缺登记或完整验收判断。

Green2源回归与时钟/合同通过，driver的原29项archive回归出现15个ERROR：新增登记读取直接索引缺失side，使不完整业务报告抛KeyError。结果保留，不能称产品失败；Green3在所属归档目录读取严格regular启动原件，缺side/文件或读取错误留为未闭合登记，继续保留业务失败并拒收最终验收。

Green3原同源12项前置均通过（真实CLI 15项正常结束），但只读审查仍发现malformed pair/side与非字符串run会在失败结算前抛异常。独立shape RED2保留错误类型7案失败，不继承该轮通过；Green4增加报告结构检查，先保存原报告和remapped文件，再把错误结构明确记为failed证据，缺失文件与旧负例继续拒收；新增12种错误结构与4种启动描述缺失/坏JSON/directory/symlink负例，只验证消费者失败结算和原件保留。

## 当前合同

`terminal-capture-driver.mjs seal` 负责闭合原件与独立物理回放；原生协议选择自 prepare 的 `nativeJournal`，不能由最终报告 backend 自选。native 的正确 bounded 声明继续要求 full/timing=false，不用修改旗标获取未覆盖能力。独立 recheck 读取拥有者的启动描述，核对 run、captureId、binary、target、pane 和明确的布尔协议，再选择对应 validator；缺描述、协议不明、报告降级或身份不一致直接失败。

`verify DESCRIPTOR --bounded` 只验证闭合身份与独立物理回放，前后原件与 saved/current 结果必须一致。默认 `verify DESCRIPTOR` 仍执行完整验收：没有完整 input、lifecycle、product timing 的证据时输出 fullCoverageVerdict=not covered、退出1；bounded 正例不能使它通过。default/planned targets 保持完整，不能以 --bounded 替代发布门禁。

Python final consumer 从已登记 launch 确定固定 required file roster：legacy保留原15份，native强制原26份，包含journal、登记、producer expectation、observer及全部核心记录；同时检查所有实际声明文件和输入/business原件。不能为native制造legacy别名，不能耦合删除文件与哈希清单来降低必需集合。terminal registry比较完整capture协议/初始尺寸/placement及driver身份；builtin归档的启动描述单独加入proof并固定在父层metadata，不能只信最终report的backend标签。七侧 builtin 仍为legacy；本批没有声称它们已迁入native或证明父层在七侧启动前完成登记。

资源关闭检查只核对所属进程、server、socket及目录，证据 seal 成败另列 `bounded_terminal_evidence`。两条终端目标还必须执行默认完整 verify 并保存其stdout/stderr，以 `full_terminal_coverage` 明确记录真实结果。完整证明不成立时目标和发布仍失败，不再把它误报成遗留资源。

## 回归和执行

现有真实15项CLI矩阵保留所有业务、故障及文件类型检查；实际正例另外执行 bounded verify成功、默认full verify拒收，并对actual held native side测试报告backend删改仍拒收。source driver回归保留原完整集合，补充原生必需文件、严格bool意图、资源与证据分别结算、必需full coverage遗漏拒收。合成聚合夹具仅验证消费合同，不是产品native/UI证据。

```sh
python3 .claude/skills/release-validation/scripts/test-release-driver.py
bun test --no-env-file ./scripts/builtin-terminal-evidence.test.mjs ./scripts/mods-test-lab.test.mjs
make release-check
make build
JOURNAL_TEST_BINARY=/absolute/path/to/this-build/built-claude python3 scripts/test-native-frame-journal.py
bun scripts/terminal-capture-driver.mjs verify /absolute/path/to/capture-launch.json --bounded
bun scripts/terminal-capture-driver.mjs verify /absolute/path/to/capture-launch.json
```

最后一条在当前 bounded native 协议下预期退出1，不是测试已覆盖完整时序。新轮需同源全部前置检查、新build及原默认完整串行矩阵；任一失败、漂移或必需层未覆盖，整体验收保持failed。登记关闭篡改的专门动态负例、真实child read/parser/owner、React/Yoga/resize生效、完整termios与无观测时序，以及官方Mods/UI全部兼容仍需要继续实现和验收。

Green4文档计数审查更正：新增错误结构实际12种，启动描述4种，原有空侧负例另保留。Green5只改此计数字样；源码、矩阵与验收条件相同，但前轮结果仍不继承给新冻结源。

Native53在Green5新build上原完整30项正常结束、27通过/3失败。两终端仅full_terminal_coverage=false，资源/身份/物理/resize均通过；builtin独立回放退为failed，首次分歧为归档后side.run映射新目录而capture-launch原件仍记原producer目录。独立archive RED1在七个实际侧全部复现，不改Native53原verdict。Green6依据父级已固定source/archive的完整归档回执和原launch摘要映射路径，保持原launch字节；原target/pane/captureId/binary/protocol及固定roster继续核对，默认full仍拒收。合成归档分类回归不代表actual UI/full证明；新同源前置与原矩阵仍须重跑。

Native53 原件用 Green6 修复后的读取器重验时，六侧恢复通过，securityOrdinary 在原 `frame-physical-report.json` 已是 failed：首个分歧 frame121 为 `physical viewport differs from measured native PTY geometry`，startGeometryId=0、endGeometryId=1、resizeIoIds=[386]。原始启动路径拒收与实际物理帧失败分别保留；历史原件不能因读取器修复升级为七侧通过，Green6 七侧全通过假设的诊断测试实际 exit1。

独立审计发现 archive sourceManifest 的当前摘要与当前启动文件同时改写，可绕过只核对已解析 identity 的聚合检查。实际最小 synthetic RED 已返回 passed 并使测试 exit1（physical fresh recheck 明确 stub，只证明最终聚合契约）。修复在 parent 刚完成归档时固定整个收据 SHA，并由 held registered_runs 传递到最终校验；这样 argv/原始字节与收据的耦合修改仍被拒收。此证明不提升任何完整终端或历史物理帧结论。
