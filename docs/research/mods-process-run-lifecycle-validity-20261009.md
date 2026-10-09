# process.run 生命周期与取消契约

本批是完整Mods验收中的宿主进程修复，不宣称完整release、终端输入owner或无观测时序等价已经通过。

## 官方合同与层次

对照固定官方2.1.293解包的Kw、gjt、eHo、E1e、hpe、aw/G_r/z_r及嵌入声明；不把这个固定样本称为当前latest。process.run是公开author API，builtin diff调用同一入口。signal不是公开ProcessRunInit字段；由实际调度operation及activation两个宿主来源交付。

组合signal保留首个reason，包括false/null/0/空字符串及宿主Error身份；状态用aborted/stopped布尔值判断。跨Worker本身不保证Error对象身份。内部host run保留原取消值，公开run则按官方包装为`HooksError(<plugin>: $.process.run(<executable>) aborted)`，超时为`aborted: still running after <budget>ms`。外层dispatch取消返回原宿主原因是另一个合同。内部带预算的TimeoutError与实际终止失败有各自类型，避免迟到的父取消覆盖已发生的timeout或隐藏清理错误。

stdout/stderr分别限4MiB并持续排空；结果五字段全部返回。真实超出上限才使用stream解码丢弃被截断UTF-8尾，正好上限且未溢出仍按Buffer解码。

## 真实生命周期与边界

从实际ChildProcess的spawn/error/close回调记录`[ModsProcess]`；每次run的operationId在宿主生成，绑定owner、真实PID、实际注入Git参数的SHA256、预算与单调耗时。实际data流维护各自完整读取字节与SHA256，另计保留字节和截断标志，不用截断后输出长度冒充完整字节。没有spawn的启动失败不生成成功start；错误/超时/取消不改为普通exitCode。

POSIX正常取消先TERM，最多2000ms宽限后对原PID+lstart仍匹配的成员KILL；原父已退出、但同组后代仍持有pipe时仍纳入真实组成员。ps非零/超时不能阻止对仍存活的ChildProcess handle发TERM及必要KILL；此handle回退单独记录，不能冒称已验证未知后代。group TERM错误不能跳过独立PID TERM；TERM失败仍经过宽限并尝试经身份复验的KILL。KILL实际失败、已捕获身份冲突或未知后代身份不能闭合时，有界拒绝为包含原原因与实际错误的AggregateError，公开错误明确failed to terminate，不把未close的进程写成已清理。Windows保持现有tree-kill路径，本批无新Windows动态证明。

日志只写摘要/数量/身份，不写原argv、env、stdin或输出。open/close debug receipts仅补进程因果，不能代替terminal frame、input owner、termios lifetime或timing证明。

## 首次失败与有效性

`mods-process-red1-test1`的37项诊断有35失败：reason、真实日志、正好cap的UTF-8及Worker公开错误合同；`mods-process-green1-test1`同一37项通过。它们是各自冻结epoch的诊断，不跨源码或文档修改复用为最终binary验收。

Green1的相邻完整文件327通过、1失败、3已有skip；唯一失败是旧Worker精确结果漏了两个官方必需截断标志，本批补全断言，不删除测试或改宽松匹配。三个既有skip保持未覆盖，不记为通过。

Green1只读审查又发现空owned Map和终止异常分支会无界等待close。red2/red3/red4的PATH故障夹具未取得预期helper marker，属于夹具失败，不能说已验证ps真实非零。red5改为向既有helper边界注入实际owned executable的非零exit回执，preflight先核对实际marker，再复现等待失败；red6在真实owned child的group TERM调用注入EPERM，复现异常路径挂起；其“group失败即不可恢复”的旧预期与官方PID fallback相反，保留原记录但不作为正确终止合同。两者首次log、source identity与监督清理记录保留；这些是有界故障注入回归，不是正常production ps或完整native证明。

Green2冻结文档后的39项及原相邻文件通过；release-check的版本、文档与类型阶段通过，但lint因三处测试回收空catch失败，整轮check仍failed，未开始build或CLI。修正这三处回收注释后必须重新冻结源码并重跑所有前置步骤；不借已失效epoch的通过补齐最终门禁。

Green3的39项、原相邻文件、全部release-check及build正常通过；只读文档审查指出README的终止表述遗漏权限失败可能未close的例外。仅停止经PID/父链核实的本轮父编排，当前独立build正常结束并保留结果，未启动nativeunit/CLI；编排143不是产品失败。修正README后新建Green4，最终门禁不得复用Green3二进制或跨epoch通过。

Green4的39项、原相邻文件、全部release-check、新build、28项native unit与完整15项native CLI均正常通过，但只读复核确证两项覆盖遗漏：首次lstart失败、后次恢复会跳过KILL；group TERM异常会跳过PID fallback。因此Green4未迁移或提交，不将测试全绿解释为生命周期完整。先前文档“空ps已处理”仅涵盖稳定空查询，不能涵盖瞬时恢复。

red7保持真实child与实际helper退出回执，首次lstart故障后调用原生产helper，实测恢复结果包含真实child PID；同时将group-only错误与所有自有目标TERM/KILL均失败拆开。四案有一通过、三失败，首次log与监督回收记录保留。新的故障oracle要求group-only错误后真实PID TERM、child TERM marker、实际close/exit42及原false原因；所有目标失败则要求完整尝试、bounded AggregateError、child仍活且没有伪造close。故障仍是受控注入，不称实际OS权限配置实测。

Green5修复两项控制流：逐目标信号异常记录errno并继续其他可控制目标，TERM失败仍尝试KILL；初次缺身份允许自有live handle回退，已捕获身份冲突则明确失败并避免误杀。不能验证身份的独立后代保持未闭合并拒绝，不伪装清理完成。Green5的41项与原相邻完整文件通过，但release-check因监督测试finally内throw触发no-unsafe-finally失败，未开始build/nativeunit/CLI。尝试停止父编排时实际ps表明父PID已退出，没有发送信号；保留failed check和无信号处置记录。

只读复核再发现首次已捕获后代身份、后次ps失败返回空Map会把后代未知状态误当退出。red8首次复现错误原false结算；red9在同未修复实现补充结算瞬间真实PID探测，记录descendantStillPresent=true且rawFalse=true，仍2通过/1失败，原red8不改。Green6保留实际identity helper exitCode，并对缺失/冲突后代逐一核对；只有真实ESRCH可确认缺失PID已不存在，仍在而无法复验身份则有界拒绝、记录queryExitCode和unresolved PID，不向身份未知的PID发KILL。监督夹具单独清理真实自有后代并保存gone回执。finally中的退出检查改为记录状态并在finally之后断言，修正lint而不删除回收或弱化验收。

最终验证必须重新冻结Green6，不复用Green4/Green5结果。

Green6的42项、原相邻文件、完整check、新build与28项native unit正常通过；监督验收复核指出两个finally probe把任意错误当gone。只停止经精确命令及父链核实的本轮编排父PID，原始CLI日志最终显示15项OK，但外层wrapper最终result缺失；实测已登记PID/group不存在也不能补造wait/exitCode，旧CLI门禁保持incomplete。外层143为行政停止，不算产品失败。旧epoch所有实际完成记录保留，不迁移为最终验收。Green7将监督与正常取消的消失断言收紧为实际ESRCH；EPERM/EACCES或其他errno保持gone=false并保存原errno，不能将无法探测等同不存在。Green7只读预审暂未发现新问题，未启动validators；确认旧CLI缺失监督回执后，Green8补正文档再冻结。生产终止代码与Green6相同，最终只能使用Green8完整原始回执，不以旧日志或进程已消失补齐缺失退出证据。

## 验证入口

```sh
bun test --no-env-file ./src/utils/combinedAbortSignal.reason.test.ts ./src/services/mods/processRunLifecycle.test.ts ./src/services/mods/processRunPublic.test.ts ./src/services/mods/processRunPsFailure.test.ts ./src/services/mods/processRunTerminationFailure.test.ts
bun test --no-env-file ./src/services/mods/hostOperations.test.ts ./src/services/mods/runtimeHost.test.ts ./src/services/mods/processSpawn.test.ts ./src/services/mods/modelAbort.test.ts ./src/services/mods/dispatch.test.ts ./src/services/mods/environment.test.ts
make release-check
make build
```

最终文档冻结后必须重新执行上述回归/check/build，再以本轮binary的动态baseline和原完整交互矩阵验证canonical真实Git回执。不能以新增unit、历史闭合capture重算或最终pane文字替代新binary验收。Native49原30项27/3保持原verdict；旧Native43 resize错误、缺真实Yoga/resize witness、child read/parser/owner、完整termios与无观测对照仍独立开放。
