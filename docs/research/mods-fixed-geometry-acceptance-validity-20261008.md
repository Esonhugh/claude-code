# 固定几何验收的有效性

默认 backend 的 immutable native frames 绑定初始200×60，旧回放不读取 broker 的 `pty-io.jsonl` resize ACK。完整 verdict 始终 failed，但 resize 后又恢复初始尺寸、没有新增输出时，局部 `boundedVerdict` 仍有误判风险。

`native-fixed-geometry-guard-red-cli1` 在真实默认 prepare/install→launcher→新 binary→/exit→seal 后，复制原件为 adversarial classification fixture，插入 resize→恢复收据。旧 `derive_frames` 未拒收，四个 CLI 测试中该分类断言失败；正常原件、native packets/raw 与其有限六帧结论没有改写。这是 classifier RED，不代表产品实际发生同一错误。

修复将 native backend 写入独立 expected identity，重新验证 broker backend、IO capture/PID/连续 identity、唯一初始尺寸和无 observed resize。任一 resize ACK 或非零 geometry identity 都拒绝固定几何回放，错误打印 IO/geometry identity 和尺寸；不会凭 raw read offset 猜测与 native write 的顺序。缺失 IO 或初始尺寸不符也不能通过。

Native31 的真实默认 driver roster29条（含readiness）完整结束，23通过/6失败。重新构建 binary SHA256 `74eb46a184368c2251a4ea7fcd24cc2bef0072dd86e23e2eacf88cc998244643`；最终 manifest SHA256 `87ddd928cc127bb8158a29c30bb22b92432f6e9c619eea00394e0a71cbfb9028`。两条 native terminal run 正常exit0/EOF/reap，无信号和丢失；分别47/67帧。canonical有一次110×34 resize，interaction有四次109/110×34 resize；旧固定几何回放各在第8/39帧拒收。这说明固定几何方法不覆盖该场景，不能用该错误断言产品坏帧。

Native31 外层内容集合另记录到 `scripts/__pycache__/native-terminal-journal.cpython-314.pyc`，3119个原始源码保持相同。完整 driver 清理及failed verdict保留；不删除原件或回写sourceUnchanged。`native-bytecode-guard-red1` 最小初始化测试复现入口在私有复制源码中创建pyc，修复在broker/verifier加载本地模块前设置 `sys.dont_write_bytecode`，不依赖launcher继承环境变量或排除文件来掩盖副作用。

本批不提供 native resize 与 Mach clock 的关联、不把输入转发当作实际OS read/唯一owner，也不关闭产品时序或全生命周期门禁。新代码使旧门禁结果不能继承；同一新epoch需要重新执行完整driver，整体发布四路与官方完整兼容仍未通过。命令及使用范围见README。

首轮 `native-fixed-geometry-guard-green-cli1` 已实际拒收 resize，但夹具将另一 module instance 的同名 JournalError 当作异常类，产生分类夹具错误；原失败与收据保留。后续只修正夹具引用到 verifier 自己的异常类，保持同一拒收条件/消息，另以旧实现重新执行修正后的RED，不将夹具问题当作产品RED。

只读f6b审计进一步发现“现存行连续”不等同于完整IO：initial-only裁剪或删除ACK再重新编号仍能绕过旧有限guard；该轮未提交。`native-io-close-guard-red-cli1` 用正常真实CLI原件的私有复制fixture复现initial-only截断被接受，保存原件和失败。

新owned broker在关闭时固定IO原始JSONL摘要、记录数量、最终geometry identity及观测raw字节数。正常cleanup与broker-close原件必须相同；sealer/实际入口提供的独立expected绑定关闭收据，verifier不会从当前被校验的IO重新生成expected摘要。每个output区间必须从0连续覆盖全部raw，其他事件offset不变，末尾和实际raw长度一致。新增截断、删除output重编号、同时改IO/普通或双份cleanup的拒收；人工摘要仅用于单独测试output覆盖/offset分类，不用于native报告。

关闭收据来自owned broker，仍不等同于child侧的kernel resize ledger、OS read/parser owner或时序等效。若关闭收据、独立expected与全部原件一并被替换，需要更外层可信封存才能判断；这批完整性绑定的前提是独立expected和已封存原件不随fixture改写。完整native/发布门禁继续failed，不通过hash匹配补造未实现的native时序。

后续只读审查发现f393的sealer在首次seal才从磁盘broker-cleanup建立expected；这不是提前固定的producer证明。native-first-seal-red-cli1 在真实默认CLI正常关闭后复制原件，保留全部output/raw，删一条input并重编号、同时更新两份cleanup，首次实际seal仍bounded passed，故f393未提交。

最小修复让owned broker关闭时从内存IO、已绑定launch/PID及实际初始几何独占发布producer-expected-native.json，然后发布cleanup；sealer只读该producer原件、核对prepare身份，不能重算或在缺失时fallback。发布失败使normalCompletion=false，启动前预存文件也拒收。真实first-seal复制负例保持producer原件不变，删input/重编号/改两份cleanup仍失败；没有将classifier负例当作实际产品input或native resize错误。若prepare、producer expectation及所有原件全部可同步替换，仍需外层可信封存，此有限证明不提供加密认证。
