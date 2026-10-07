# 外部 Client 交互与消息：2.1.292 对齐

日期：2026-10-07。官方 npm latest 为 2.1.292（https://registry.npmjs.org/@anthropic-ai/claude-code/latest）；只读解包的官方二进制 SHA-256 为 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`。

## 依据与实现

解包 `chunk-8jczcb92.js` 的 bP / r5 / t5 表明：desktop Client 以 component、requestId、plugin、key、module 定位；1024 实例 LRU 独立于绘制缓存。新绘制 begin 保留旧 keys；record 只接受当前 generation，空树删除地址。woo 只收集 Client 节点，不遍历其子树。

ui_client_press 的 core 只保存最终输入并返回 element/value。交互结果不决定是否调用外部 Client；reached 才表示到达 core。press 可以独立并发，input/select 分别按插件串行。ui_message 先检查地址，再检查数据预算，再按插件串行，只派给 owner 的钩子；next.origin 是 client，地址只读，data 可重写，结果 props 可替换。消息用保守序列化字符计数、20000 值及根为零的 32 层深度校验。

本批为 remoteUiControl / remoteUiRender 增加这两类控制和独立 registry，runtime 增加受信任的 SDK 分发入口。ui.message 对受信任 host 钩子也执行 owner 过滤；运行时结果 props 校验采用同一远程数据预算。模块包仍是准入快照数据，服务端不运行 Client surface 源码。

## 原生验证与限制

本批证据根：`/private/tmp/mods-client-events-292-20261007-ma7w0g3z`。native-control.py 每次使用新的私有 HOME/config/TMP/XDG、工作目录、tmux socket 和 localhost dummy API，实际 stdin 发送控制请求。沙箱拒绝真实 ~/.claude、Keychain/securityd、外部网络和私有运行目录外写入；正常 EOF 与进程/HTTP/fixture/binary 清理分别检查。不操作用户原有 Claude 进程或系统剪贴板，不改原始官方及共享 built-claude。

初次 oracle1 错用了作者的 `./surface.ts` 拼写，所有 Client 地址未命中；保留此证据，未据此声称正向交互通过。oracle2 检查了无效 `{}` 拦截结果，官方回退 core；oracle3 改为合法 element/value 拦截。最终 final1 同一 fixture 使用实际渲染回包的地址，增加深度和并发消息，取得 70 控制回包、66 插件事件并正常退出。候选 trial1 同样取得 70/66，回包比较未发现非 opaque handle 差异。

## 最终结果

- 候选 27 文件组：1169 pass / 1 fail / 6 skip / 5263 expect；完整工作区：1215 pass / 1 fail / 6 skip / 5445 expect。唯一失败为 trusted stream callback nested work pauses budget and inherits abort；干净原 HEAD 2cd6cb4 复现 25 pass / 1 fail / 164 expect，原断言保留。
- 候选广回归后只补上测试夹具的必填 hasCatch:false 字段；SHA 比对证明只有此处发生变化。最终 4 文件专项 103 pass / 0 fail / 601 expect，严格类型门禁和构建使用最终源码。完整工作区广回归、严格类型门禁、构建使用同一最终源码快照。
- 两侧 make release-check / make build exit0，无超时，源码在检查中未变更，所启动进程组均清理。候选源码 SHA-256：561aba36d247ee79089dd713228172b4d87d1ff1780a1a3674c563c4b22baa44；完整工作区：fc5dd80a876584d39784bbf7bb3d06931639548d71d5d74fb7fb590d2aec209e。此 manifest 记录 CHANGELOG/Makefile/src/types/vendor/scripts/assets/tests，README 与研究报告另行校验。
- 最终新制品 SHA-256：候选 65ce7062f5e32a8489ec7083c4c2fc0a3d0d081a028d54279b672a1760af1eca；完整工作区 df3154a68919b57229ec4d703e953a21771c44014f3cfdaa2f7d20f55febec34。运行的是私有输出目录中的制品，未覆盖共享 built-claude。
- native-official-final1 / native-candidate-final2 / native-workspace-final1 的 driver、fixture 和实际 stdin 输入一致（只对实际使用的 opaque callback handles 做按插件/节点/type 的 alpha 对齐）；各 70 回包、66 事件，281 检查全部通过。所有字段逐个比较；initialize 的生成元信息排除；session 的 cwd/sessionId/resume 排除；独立观察事件只排序，message 串行顺序、绘制回包顺序、取消进入/退出与无回包分别严格检查。
- 三方正常 EOF exit0；fixture/binary 未变、私有 pane/server/HTTP/request threads 全部清理、无模型 POST。只比较本批覆盖的控制路径，未执行浏览器 Client 源码。

原始记录在证据根的各 label/result.json 和 log.txt；native 原始 stdin、响应和事件在各 native-*/evidence/result.json；比较脚本与结果为 compare.py / native-comparison.json。commit-proof.json 记录实际签名提交、精确 blobs 和并行改动保留检查。完整工作区冻结 3214 个文件，保留已有 Mods WIP 及并发 Channels 改动；提交从干净 HEAD 候选提取，仅暂存本批增量。


ui_client_fault 在当前控制器中尚未接通；这是单独的下一批，涉及作者事件定义、失败代次与重绘。其余 9 类客户端控制（含 fault）、5 类 responder、system 推送、浏览器 Client 生命周期和完整官方 diff viewer、终端所有帧、API/上下文/G5 及旧 response 的全量 WIP 验收继续开放。这批不表示完整 Mods 兼容。27 文件回归仍有之前已复现的 trusted stream callback nested work pauses budget and inherits abort 失败；不删除或降低该测试要求。

冻结验收之后，其他进程在原工作区 runtime.ts 增加 agent.spawn effort 验证。该改动与本批 UI 控制无交叠，保留在工作区并排除本批暂存；冻结快照的检查不声称覆盖这段后续变更。concurrent-owned-allowed.json 保存逐字 diff 和 SHA 归属证明。
