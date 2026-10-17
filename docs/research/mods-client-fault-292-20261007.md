# 外部 Client 故障与恢复：官方 2.1.292 对齐

本批接通 stream-json 的 `ui_client_fault`、所属插件 `ui.fault` 观察及 `system/ui_invalidate` 恢复链。提交仅包含此功能增量；保留并发进程提交的 Channels / subagent effort 和其他 WIP，不 push。完整 Mods、UI 和 diff viewer 目标仍在进行中。

## 官方依据与实现差异

基准为 [Anthropic npm 元数据](https://registry.npmjs.org/@anthropic-ai/claude-code/latest) 核实的 2.1.292，包 shasum `ecf88deee4c6b1b099d14a8571f1d5cad2ff1897`；官方二进制为 235017328 bytes，SHA-256 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`。使用现有私有官方制品和只读解包源码，没有修改原二进制，也没有向外部服务上传源码。

- `chunk-jjy8yg8v.js` 的 `Tb/Rb/bb`（字符偏移 365040 起）验证故障请求，以首个 Zod issue 生成错误，映射规范地址与报告。控制循环（551040 附近）异步运行故障；与 ui_render 不同，没有把它登记到 `Io` 取消表，592328 附近的 control_cancel_request 只取消已登记的任务。
- `chunk-8jczcb92.js` 的 `bP/es`（451260 起）用 1024 实例 LRU 保存当前 Client、键的出生版本和失败版本；迟到绘制不能发布新代次。`toldFailed/kP/EP/vP/TP` 保留首次失败的出生版本、判断所属插件是否监听，并在观察完成后检查节点仍存在；恢复次数以失效后的版本记录，最多保存 4096 项。props 变化或重新绘制不等于新的依赖失效。
- 同一模块的 `OP/Brr/PP` 清理控制字符、孤立代理项和内部占位符，剥离插件与 Client 模块前缀；空白原因使用 `the module failed without a message`，保留有效代理对并限制 UTF-16 长度。
- `chunk-r9hj3tk2.js` 的 ui.fault 合同（33805 附近）恢复并固定 surface/component/requestId/element/module/phase/reason，core 返回 `{}`，运行时观察结果不参与替换或阻止；作者声明仍严格限定 UiFaultResult 为 Record<string,never>，phase 为 load/render/run，没有公开 $.ui.fault。
- `chunk-jjy8yg8v.js` 的 onInvalidate（490843 附近）发送 system/ui_invalidate/event:ui.render，可省略 instances 表示全局失效，也可提供精确 remote instance。故障恢复不立即再次运行服务端 render hook，客户端收到通知后重新请求绘制。

此前宿主未接通 ui_client_fault。此次加入规范地址校验、插件隔离和串行队列、故障文本格式化、出生/失败/失效版本、恢复循环抑制、远程消费者失效通知与 SDK 输出。打印关键归属、模块、实例、surface、phase、规范 reason、engine/core 来源和完成耗时。UIInvalidate 的有限 schema 和 SDKMessage 联合已同步，独立严格类型夹具做双向匹配；原注释引用的 SDK 类型生成脚本在 recovered 工程内缺失，本批更新精确类型别名并用可执行类型门禁验证。

## 验证

证据目录：`/private/tmp/mods-client-fault-292-20261007-a5ydathk`。独立候选以 `b69c58db1d698368aecedb56204552c9c3148618` 为基准，完整工作区冻结 3218 个非忽略文件；三方使用同一个驱动和相同插件夹具。每次运行采用私有 HOME/config/TMP/XDG/cwd、自己的 tmux socket 与 sandbox，只有 localhost 假 API 可访问；没有模型请求，也没有真实 API key、系统剪贴板或其他 Claude 会话输入。每次均正常 EOF 退出0，HTTP 线程和自有 pane/server 全部清理。

| 门禁 | 结果 | 核心源码 SHA-256 |
| --- | --- | --- |
| candidate-focused2：6 文件专项 | 78 pass / 0 fail / 519 expect | `9ef265ac7b3c01bc3eb861d8f43556979f403400ea35922dfbb773e518df439c` |
| candidate-check5 / candidate-build1 | release-check 与构建退出0 | 同上 |
| candidate-regressions2：29 文件 | 1176 pass / 1 fail / 6 skip / 5310 expect | 同上 |
| workspace-check1 / workspace-build1 | release-check 与构建退出0 | `4f88c3dd2babd5644618bac00e2e782d672622f27cb395d1bc1db463139d130d` |
| workspace-regressions1：29 文件 | 1222 pass / 1 fail / 6 skip / 5492 expect | 同上 |
| baseline/host-hooks：当前 HEAD | 25 pass / 1 fail / 164 expect | `be7d1ac9daef03a6ca2d0b98952ba631db33182673a456c00176eb55a804b990` |

唯一失败为 `trusted stream callback nested work pauses budget and inherits abort`：预期专用取消原因，实际为通用 AbortError。当前 HEAD 单独运行也失败，未删除测试、弱化断言或把非零退出记为成功。6 个条件跳过保留原记录。release-check 包含 changelog、全工程 TypeScript、严格 Mods SDK 控制类型和 lint。

原生证据使用 `native-official-final2`、`native-candidate-final1`、`native-workspace-final1` 的 evidence/result.json、逐字 stdin、PTY/pane、debug/stdout 与夹具前后 hash。每侧保存 103 条控制回执、91 条事件，另校验取消后的故障成功回包；400 项比较全部通过。只规范化 opaque callback handle、生成的 uuid/session_id/resume 与隔离 cwd，分别比较独立事件 payload，额外保留绘制回包、消息/故障串行、取消 enter/exit 和通知顺序；没有把整个 stdout 泛化为相同。

每侧恢复通知精确为 fault-site、fault-serial、fault-cancel 各一次；重复 load/render/run、相同重绘及 props 变化没有继续推送。空 ID、地址错误、所属插件没有匹配故障监听、观察期间节点移除都不恢复。七个字段伪造被拒绝，next({}) 恢复原输入；engine/core 来源、前缀/换行/Unicode/空白原因、undefined 结果、首个 schema 错误、取消仍回包和故障串行顺序一致。原生运行保持 Client 源码外部执行，故意会抛出的模块没有在宿主挂载。

- official 制品 SHA-256：`97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`；驱动 SHA-256：`064037d0afbc7d831f2a34ece98b9e684f70821691305f2511ba50caf1be95e0`。
- candidate 制品 SHA-256：`60e723f44146fb8b8c33b82a77cde84a9bdebfca1964347b20330d35c1debe2c`；驱动 SHA-256：`064037d0afbc7d831f2a34ece98b9e684f70821691305f2511ba50caf1be95e0`。
- workspace 制品 SHA-256：`cf9efea6228a2c74fcc70036fe34cedfd16968ab5666e174c3dd883bfe3283ad`；驱动 SHA-256：`064037d0afbc7d831f2a34ece98b9e684f70821691305f2511ba50caf1be95e0`。

原始失败也保留：候选早期 TS 联合多余分隔符、变量遮蔽、负类型断言位置和故意控制字符清理所需的局部 lint 注释已修复。早期官方驱动变量误覆盖 tmux target 导致退出1，自有进程按记录的 PID/PGID/start/command 核验后清理；没有向无关进程发送信号。最初取消探针结果保留，追踪官方取消表后明确故障不接受取消，最终三方用 400ms hold 和实际 control_cancel_request 验证，没有把返回 handled:true 当作取消成功。

## 使用与范围

使用方法和原始请求/通知示例见 README 的“外部 Client 故障与恢复”。专项命令：

```bash
bun test --no-env-file ./src/services/mods/remoteUiFault.test.ts ./src/services/mods/remoteUiFaultTypes.test.ts ./src/services/mods/remoteUiClient.test.ts ./src/services/mods/remoteUiRender.test.ts ./src/services/mods/remoteUiControl.test.ts ./src/entrypoints/sdk/controlSchemas.mods.test.ts
make release-check
make build CLAUDE_CODE_BUILD_DIR=/private/tmp/your-private-build
```

完整原生命令和私有环境位于每次 result.json 的 argv/environment；构建和测试命令、源码 hash、超时与清理状态位于各门禁 result.json。官方实现属于固定版本本地分析，公共 [Mods 概览](https://code.claude.com/docs/en/plugins/mods/overview) 和 [Mods 接口参考](https://code.claude.com/docs/en/plugins/mods/reference) 已提供作者说明；接口参考列出 ui.fault 的三类阶段。本文用固定版本声明、源码和相同制品的原生运行验证具体传输与恢复细节。

当前接通 10/18 类客户端控制及 ui_invalidate。剩余 8 类控制、5 类 responder、pane/scroll/focus 推送、终端内部 Client 故障流程、浏览器执行生命周期、完整官方 diff viewer、G5 和旧 response 的全量 WIP 门禁仍需继续；本批没有重新运行全部旧 155 个文件，也不表示完整兼容目标完成。
