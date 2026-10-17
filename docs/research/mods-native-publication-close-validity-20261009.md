# 原生发布积压与两阶段关闭（2026-10-09）

Native41真实terminal-interaction的原件有89组完整帧标记，但live frames只有54帧；producer实际exit0/EOF/reap，采集器另有close-live-publication的2秒TimeoutError。Native42新文档产物的完整30项仍为27通过、3失败。它们保持原失败，不把缺失帧解释成cell mismatch，也不把子进程exit0当作采集完整。

## 实现与不变量

writer按FIFO消费当前已排队的immutable prefix为一批，只在该批之后解码；snapshot尚缺物理raw时保留pending，完整prefix发布后，额外raw不重复重建旧帧。后续snapshot仍须完整关联，未完成尾帧不会补造。关闭预算保持2秒，内存上限保持64MiB；旧帧prefix相等、最终全量frames/IO逐字比较及regular0600/fd/inode/owner检查继续保留。批处理不等于增量decoder或产品时序等价。

退出按真实资源顺序检查：发送/exit后先观察producer的exit0/EOF/reap和内容关闭收据；关闭tmux采集管道后，再要求实际capture-eof=0及完整退出谓词。前一阶段的观察单独记录，不替代collector EOF。publisher超时、缺EOF、强制信号、错误JSON类型、缺binary digest或描述符均不能取得完整退出通过。关闭前保存与本案run及expected binary绑定的primitive身份副本；close清空成员后继续用该副本读取原件。缺采集描述符或manifest的失败场景记录false，不中断driver的后续记录和收尾。

## 修复前证据与验证边界

真实Native41原件：`/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/full-gate41-evidence/runs/20261009T034135-terminal-interaction-13585-25`。完整manifest的SHA256为`f4618d01d8f98e6e1b95f402c3b08d748b21ad9e1d450be08ef24bdcbe2e612e`。

独立积压probe重读原生packet/raw及producer内容摘要，原件保持不变。旧writer在明确标注的“完整held raw先于排队packet可用”调度下，89帧积压在2秒预算内失败；publisher-only批处理候选同序列在约0.4秒关闭且输出逐字相同。它使用失败原件实际保存的IO前缀：原完整IO bytes已缺失，不能伪造producer的119项完整IO。因此probe只证明受控packet/raw积压处理，不作为完整IO、真实UI调度或时序oracle。

`native-live-close-backlog-red1`因错误要求缺失的完整IO摘要而提前失败，是probe管理错误；`red2`把raw放在所有snapshot之后，未复现超时；`red3`保留真实2秒关闭失败。对应before/start/result/log和原件SHA均保存。publisher-only正例不能替代最终构建与默认完整矩阵。

协议回归另覆盖跨批snapshot-before-raw、多个snapshot同批、下一帧半包和无snapshot尾raw；既有overflow、阻塞writer超时、改写prefix/终态文件及外来身份拒收继续执行。协议fixture不作为原生/物理UI oracle。退出contract独立检查producer与collector阶段、publisher错误、缺摘要和错误类型。最终变更必须冻结source，重新release-check/build，以新产物执行完整CLI/frame文件和原默认矩阵；结果以独立manifest和原件为准，不继承旧GREEN。

## 本批真实收尾与未通过项

- 冻结feature source：`fe757ac73ec94aa96248e304897aa8f195b9d9e78beef28a64c91a4eaf8807f5`；新产物SHA256：`fd9fc7f362eb506315cba4a44d7a596f079a91a7f5e1c7c8d4f70644af1d48ed`。
- 同源码10项退出contract、12项prefix、4项native broker、13项legacy broker、45项终端证据回归、28项native journal，以及完整release-driver、release-check与fresh build通过。fixture仅证明所断言的协议和拒收。
- 新产物完整`test-native-frame-journal.py`执行15项：14通过、1失败。失败原件`/private/tmp/cc-journal-8ae0ev5c/cli-6`的真实ioctl返回后约14.5ms，frame3仍记录200×60/rootEpoch2且没有output syscall；frame4转为110×34/rootEpoch3并通过物理回放。resize应在frame3前由Mach时钟推导，不能移到frame4、跳过零输出帧或通过重跑覆盖该RED。它确认跨层geometry不一致；没有证据证明该零输出帧写坏ANSI/像素。实际SIGWINCH/handleResize到Yoga commit的epoch handoff尚未采集闭合，kind10标记位于onRender，并非Yoga commit。
- Native43执行原默认动态矩阵与原七项追加目标，共30项：27通过、3失败；driver正常完成，matrix_complete=true，源/Git/binary不变，owned group已退出。前置CLI的resize RED另行绑定，因此整体和feature均不通过。
- 两个终端场景的正常退出子检查均为true。canonical保存52组原生snapshot和52帧、完整54项IO；interaction保存90组snapshot和90帧、完整122项IO，publisher没有cleanupErrors，producer exit0/EOF/reap，实际collector EOF通过。独立capture identity和bounded recheck通过，但它们不提升为完整terminal/产品时序通过。
- 仍失败的是builtin-mods、terminal-canonical-diff、terminal-interaction。canonical首次阻断为canonical_alpha_dock（旧broker字段、native关联和live revision均需严格处理）；interaction仍缺原geometryProof/frame semantics的backend-specific完整检查。不能伪造旧FIFO字段或删减矩阵。

完整manifest：`/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/full-gate43-evidence/driver-final-manifest.json`，SHA256 `a3c4020882117696134f7adb380d1f4a032b4ccaa949aca83269a7560fd04802`；`full-gate43-prerequisites.json`明确保存CLI失败，CLI和资源处置分别为`native-live-close-cli1-disposition.json`、`native-live-close-native43-resource-disposition.json`，总处置为`full-gate43-disposition.json`。before/start/result/log、原件摘要和source reread同目录保存；首次resize只读报告另在`/private/tmp/native-resize-first-difference-readonly-0101psru/report.md`。它们是历史feature冻结epoch证据，不能冒充本次文档编入后的产物。本次文档仍须fresh build/CLI和完整默认矩阵，不继承旧通过。

## 使用方法

使用macOS已有Bun/clang/tmux，私有配置和dummy key；串行运行：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-native-live-prefix.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-native-acceptance-contracts.py
make release-check
make build
JOURNAL_TEST_BINARY="$PWD/built-claude" PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-native-frame-journal.py
```

脚本会打印实际证据目录。release-validation仍要求默认完整矩阵及独立发布门禁。native canonical frame/action/resize匹配还须使用真实原生span和Mach bracket，不能删除几何检查或补造旧FIFO字段；OS input owner、完整termios/geometry lifetime、无观测对照、官方diff/browser/Client和其余公开功能继续实施。`productTimingEquivalent=false`、`fullNativeGatePassed=false`继续保留。
