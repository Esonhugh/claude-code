# Native 首封内容来源闭包

## 已确认的失败

`native-payload-first-seal-red1` source `c982c10e25bcb919b78dfcc44e491f03a394ef653d919b38e1a2d4b6e813c335`，基于 HEAD40b4e97和已新构建的8988 product bytes（仅增加测试）。实际 default prepare/install/launcher/CLI `/exit` 正常退出后，在隔离副本第一次seal前把单宽ASCII `EsonClaw` 等长改成 `DsonClaw`，同时改write payload、raw三alias、immutable snapshot及派生frames，保持packet长度、prepare身份、producer expectation、IO清单、两cleanup、header、registration、initial、journal及binary原件不变。独立xterm与被耦合改写的快照一致，旧首封给出 `boundedVerdict: passed`；最小回归1 FAIL。原件 `/private/tmp/cc-journal-n4337h4x/cli-0`、负例及classification-proof都保留，源原件SHA未变。这是验收器误通过，不能标为实际产品坏帧。

修复后的 `native-payload-first-seal-green1` source `15bfe755d4b3c4e20abae29442a76e66f0aa91392a43b2b350176c059b7b3d17` 新构建重跑同一入口与负例1/1通过；原件 `/private/tmp/cc-journal-gbd7m79v/cli-0`，负例1处write及6处snapshot变更、raw长度相同，原件SHA不变，bounded failed。结果文件均在 `/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/` 对应label目录。本记录不沿用旧报告的passed来覆盖新候选或完整发布。

只读静态报告 `/private/tmp/native-payload-closure-readonly-eztyka4w/REPORT.md` SHA256 `5907e0deced77f149e768f26fd679b86bda39a691780551902a575c16dfe7e8b` 先提出内容绑定缺失；它未执行测试，其推断由上述独立新RED确认，不修改旧seal。

## 修复与拒收

broker从持有的raw、完整framed records、final header、registration及initial内存值生成 `nativeClose`，method `owned-broker-closed-native-v1`。严格固定record count和七个文件的byte length/SHA256：raw.bin、native-pty.raw、outer pty.raw、records.bin、header.json、registration.json、native-initial.json。kind11快照和kind2模式记录包含在records摘要中；不需要另外相信派生frame文件。

expectation仍在producer正常退出后、首封前独占600权限发布；不从当前磁盘文件重新hash，normal frame derivation也直接使用持有的packet/raw。verifier检查required字段、原件file identity和摘要后，从同一份已验证bytes解码，避免“先hash后再读另一份”。outer sealer再次核对最终manifest的相同摘要。missing、schema缩水、等长同步改写、mode/header/initial改写和symlink均不能通过。保留现有IO close与实际PID/nonce/timebase/EOF/reap校验。

真实CLI负例额外在独立copy中验证：原始内容检查后移除文件，derive仍只消费已检查的bytes。实际运行原件不变，不改sleep、ACK、输入流或产品输出。负例和正向控制都必须在新capture完成；whole verdict原本为failed，不能代替bounded oracle。

## 使用与边界

macOS与已有clang/Bun/tmux，先 `make build`，再串行运行：

```sh
JOURNAL_TEST_BINARY=/absolute/path/to/fresh/built-claude python3 scripts/test-native-frame-journal.py NativeFrameJournalTest.test_actual_first_seal_rejects_equal_length_native_payload_rewrite
JOURNAL_TEST_BINARY=/absolute/path/to/fresh/built-claude python3 scripts/test-native-frame-journal.py
```

首封必须使用此次独立的producer expectation与prepare身份，不能重算、补写或借旧expected。仍没有加密认证；若prepare、producer expectation和所有原件一起被替换，需外层可信封存。完整termios/direct mode ioctl、child-side geometry、OS read/parser/owner、完整diff/Client生命周期、调度及默认完整矩阵仍未通过；`productTimingEquivalent=false`、`fullNativeGatePassed=false`、whole failed保持原义。

## Native34 与终态 IO 窗口

冻结5066 source `50662b31aa2196f194ae0bff9af1d4361310e1a418b97df9046ec750cbb02549` 新构建后 collector28/28、buffer4/4、真实CLI/frame10/10、Bun89/89及完整release-check通过；完整默认矩阵与追加项29/29执行，23 passed/6 failed，355.925秒。Manifest `/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/full-gate34-evidence/driver-final-manifest.json` SHA256 `407ca627db7cee54aac287c5c87ed5c93f45b5abee25206af4526ff3b4f289a7`，正常driver结束、源码不变、lease/auth/workflow及27个direct run资源清理完成。实际diff50帧/1resize、interaction82帧/4resize有限physical通过，正常EOF/reap且七项native摘要匹配；全native/Mods/四路发布依旧未通过。

只读复核仍发现F-IO-FINAL-1：重放已检查IO后，outer seal读取最终files时只比较七项nativeClose，未复核IO SHA。报告 `/private/tmp/native-validity-final-readonly-ix7b3ch8/REPORT.md` SHA256 `39439b1e4954891ef2bfce51a80962ad8c3f716b75bee0a0630da1b117083c64`，3123source/109引文零漂移，没有执行RED。

另冻结测试候选 `6869b8d9f359c36f1aa3632e3fd572c4354c98cab489acd015de493382376748`（仅新增窗口负例，production bytes同5066新构建）。`native-final-io-first-seal-red1` 实际default CLI原件 `/private/tmp/cc-journal-fmu7se1n/cli-0`，copy中的真实独立replay确实passed后，受控child-process包装只删除一条input并重编号IO；原函数执行一次、producer/两cleanup/native七项及源原件固定，最终IO SHA与expected不同，旧outer却仍bounded passed，最小测试1 FAIL。wrapper没有伪造replay结果，不是产品坏帧或provider模拟。

本批修复outer终态另要求 `files['pty-io.jsonl'].sha256 === expected.ioClose.sha256`，结果明确输出nativeIOMatched；与nativeContentMatched和真实physical verdict共同决定bounded。重放后删除IO、最终摘要不匹配必须failed，即使physical旧结果passed。新增单项使用 `NativeFrameJournalTest.test_actual_first_seal_rejects_io_rewrite_after_independent_replay`，完整脚本现含11项。Native34不会被重新标为闭包完成或发布通过；新的冻结候选及完整driver另行验证结算。

## Native35 最终处置
冻结source `40a533e3cb6f8f7cad35ff4f44904c72f77332b9ffd29c1e49ce4c2f75ca66b5`，基于HEAD40b4e97加本批owned修复，新构建SHA `c220a1322566871c5d8a7a948b49344116387b8404b0e466fd180b30ba346b58`。终端模式记录与首封闭包分为签名提交652cd2274003a2ab37c58d7b8dd384edcfa5b19c、5b9e7cbcfbb7a265087fb42385a9dd2070ce1024；后者3123项committed source逐blob核对与冻结source完全相同，proof `/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/native-validity-two-commit-source-proof.json`。第一逻辑提交未单独完整门禁；本轮验证针对两批合并后的准确source。其他Claude工作区WIP保持，不能把ROOT混合工作树称干净候选。
同一40a5冻结source：新make build 3.559秒；collector28/28、buffer4/4、真实CLI/frame/order11/11（36.738秒）、Bun89/89/525expect及make release-check全部阶段（42.674秒）通过。各项source前后不变、owned组均确认退出。CLI原件 `/private/tmp/cc-journal-x_ivoxv5`；其cli-5/final-io-first-seal-1_4ktbu0/final-io-fault-proof.json显示真实physical passed、nativeContentMatched true、IO不同/nativeIOMatched false、bounded failed、注入仅一次，源原件固定。等长内容篡改、同checked bytes解码及实际resize正向控制也属于本新capture，不借旧GREEN。
默认完整driver及追加项正常执行29/29，23 passed/6 failed，360.644秒；最终manifest `/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/full-gate35-evidence/driver-final-manifest.json` SHA256 `34e04a77545f901f93ce8a34cd4c1eeb390bbb876160fed101232b9c4fdf29b2`，处置 `/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/full-gate35-disposition.json`。失败仍为builtin-mods、code-review、terminal-canonical-diff、terminal-interaction、workflow、workflow-retry-partial-failure。整体 failed，不是正式四路发布 passed。
实际两terminal场景共129帧/5次owned resize，逐帧physical与closure通过、bad frame0；nativeContentMatched/nativeIOMatched均true，正常0退出/EOF/reap、signals[]、cleanupErrors[]、child已退出。完整termios/direct ioctl、child-side geometry、OS input/parser/唯一owner、调度与open-close-reopen仍缺，故两个目标的whole capture以及fullNativeGatePassed/productTimingEquivalent仍failed/false。不能把这些有限帧/摘要计为全部UI或diff/BrowserClient生命周期通过。
- `terminal-canonical-diff`：48帧/1resize，原件 `/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/full-gate35-evidence/runs/20261008T223203-terminal-canonical-diff-92521-24`。
- `terminal-interaction`：81帧/4resize，原件 `/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/full-gate35-evidence/runs/20261008T223203-terminal-interaction-92521-25`。

27个direct run的process/tmux/mock资源均清理；driver owned PG、lease、dummy-auth与workflow-owned归档/清理完成，source/原件保持。未触其他Claude进程，没有push/tag/release。
新只读报告 `/private/tmp/native-final-io-readonly-qndpcan6/REPORT.md` SHA256 `846e163858247ff79254606ec68c3589d9a22b7b3ab0b6004a2d0c303dca4b1e`，3123source/57引文零漂移、ownedJobs=[]；它只审源码及已完成RED，没有把在途GREEN计为passed。此处主线程新增完成的结果独立记录，不修改旧报告/seal。
本文最终补录仅三份文档变化，代码/test/类型/binary与40a5一致；不冒充在doc commit后重跑新binary或四路门禁。功能实现、默认workflow completion与完整native有效性继续，所有缺口未改为通过。
