# Mods SDK UI 协议定义 — 2026-10-07

## 范围与依据

将官方 2.1.292 的远程 UI 协议作为一个独立提交：18 类 client→loop 控制、5 类 loop→client responder 的请求/回执，有限组件枚举、wire tree、client-module 数据和 system pane/scroll/focus 消息。生产修复为 ui_attach.answers 的 5 项上限；没有把 schema 注册当作控制器安装。

官方制品 SHA-256 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`，235017328 字节。读取 `chunk-v41zkwb9.js` 的 ui_render/press/input/select、prompt、pane、client 与 responder schema，`chunk-jjy8yg8v.js` 的实际控制入口；解包代码未执行。当前版本来源：[Anthropic package metadata](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)，作者接口另见 [Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)。

证据根 `/private/tmp/mods-remote-render-292-20261007-8vwd_tpf`，官方 schema 源文件 hash 及只读截取范围在 official-sdk-schema-source.json。每次原生运行用本任务的 tmux、私有 HOME/config/XDG/TMP/cwd、dummy key、localhost 假 API，沙箱拒绝真实配置、Keychain 和外网。串行运行并严格检查正常 EOF 及进程、HTTP/线程清理；没有读取或输入其他 Claude 终端。

## 类型与校验

- wire tree 仅含远程元素与 engine ref、handler `{plugin,handle}`、Client 模块路径；不把 terminal-only Raster/Image 或作者闭包放入控制协议。
- render 回执必须包含 tree/props/rewritten/hooked；client_modules 是插件到 hash 的映射，client-module 回执另含 modules/runtime/limits/files。
- client ID 可含点且禁止冒号；pane ID 不允许点；render instance_id 是字符串，没有套用输入/客户端地址的 256 上限。
- on_screen 是 null 或满足 `0 <= first <= last < of` 的整数范围；rows/offset 非负整数，scroll by 与 pointer 可以带符号。keyed 最多 512 项。
- surface、by 的默认值只用于官方有默认值的请求；prompt 修饰键仅允许 true，长度按 UTF-16；响应 nullable 字段仍必填。
- ui_message 的 data 必须存在，null 合法。本地 Zod unknown() 在运行时接纳省略，而官方原生拒绝，故增加 own-property refine，保持 unknown 类型和官方 wire 行为。不会仅从 describe 文本推断接受规则。
- system UUID 的官方 schema 仅要求字符串；没有自行增加 UUID 格式限制。pane/scroll/focus 消息在独立 SDKUISystemMessage/schema 中定义，尚未纳入生产推送或声明 SDKMessage 全部接通。

恢复项目关闭 strictNullChecks，Zod 会把 nullable 字段推导为可选。独立 `make check-mods-control-types` 使用本地 TypeScript、strict 和有限的 protocol fixture 检查请求双向兼容、回执双向兼容和请求/回执键完整对应；通过 expect-error 保留缺少必填 nullable 字段的负例。此检查加入 release-check，未放宽协议字段或修改全仓库 strict 配置。

## 保留的失败及原生结果

- `native-official-protocolred1`：8 条请求；5 项合法（含重复），6 项非法，拒绝前不变更 roster。三端有限对照不比较 initialize 元数据或 system/ui_panes 推送。
- `native-candidate-protocolred1`：上轮已验证制品错误接受 6 项 answers 与 6 项重复 answers，mobile 随之进入 roster；原失败回执和清理记录保留。
- `native-official-oracle1`：18 条请求（含 initialize），17 条 UI 回执；绘制、无效 callback、空 pane roster、prompt、client admission 与缺少 data。17 条请求/回执固化到 src/entrypoints/sdk/fixtures/mods-ui-official-292.json；这是协议回执夹具，未宣称本地其余控制器已实现。
- candidate-protocol-red1：44 pass / 1 fail；发现本地 unknown() 的缺字段接受差异。red1-check 的全仓库类型检查发现 permissive 编译下 nullable 字段推导差异。最初不正确的 UUID 格式限制也依据只读源移除。所有日志保留，后续以官方原生 data 回执和独立 strict 编译修复，而非删除负例。
- candidate-protocol-red2：修复前调整阶段 45 pass / 0 fail；之后增加官方 native golden fixture，并恢复/严格检查必填 data，不能作为最终源码验收。

## 验收边界

当前控制器仅处理 ui_attach/ui_detach。其余 ui_render、ui_press/input/select、prompt、pane、client module/press/message/fault 与五类 responder 尚需接通；system 通知、surface admission、连接与绘制资源的统一、官方完整 diff viewer/终端帧、完整 Mods/API/上下文/G5 和全量 WIP 门禁继续开放。最新 response.md 中旧 155 文件结果不等于本批最终验证。

最终验证与源/制品身份在本报告末尾追加。所有中间失败保持在证据根，不用最终结果覆盖它们。


## 最终结果（final2）
- 16 文件聚焦回归：candidate 572 pass / 0 fail / 3 skip / 2810 expect；workspace 600 pass / 0 fail / 3 skip / 2905 expect。原有 skip 保留；这不是旧 response 的全量 155 文件结论。
- 两侧 release-check（含 strict 协议门禁、完整 tsc、lint、changelog、import audit 与 diff check）及 build 均 exit 0；每侧 test/check/build 使用相同源码身份，过程无源码变动，自有进程组全部清理。
- candidate source SHA-256 `ddb484e724368d26927a92fdc9e3a204721afe44fb94adc3135ddb2d78188a3d`；新制品 SHA-256 `4baaf8813712eca10605fcc9252e697abdbe8678f4a23660352828d0e217d0c5`，102216290 字节，保留在 candidate-final2-build-output/built-claude。
- workspace source SHA-256 `c5fa9ad5198905d509a2c8bba711a12b9a8d65ed821a1fe4e20c3bc02c62993c`；新制品 SHA-256 `f492bce14fa9717936c81724fa1e2aa76f88752331e147c926750ab5fccd3233`，102084194 字节，保留在 workspace-final2-build-output/built-claude。
- native-official/candidate/workspace-final2 同一 driver/fixture/input：各 8 个控制回执、10 条 owner 事件，无模型 POST；70 项有限边界比较全部通过。5 项合法（含重复），6 项错误回执相同，拒绝的客户端不进入 roster；attach 回执早于 observation 完成且 next 回执身份规范。三端 EOF exit 0，自有 pane/server/process group、HTTP 与请求线程全部清理，原制品/fixture未变。
- 中间失败完整保留：red2-check 发现验证脚本缺少 URL import；final1-check 发现格式化后 expect-error 注释与错误所在行错位。保留所有负例，修正导入与注释位置后重跑最终源码的三项门禁和新制品；未使用失败检查对应的 final1 制品作最终对照。
- 只将这一批 13 路径的候选增量三方合入 ROOT；3189 个其他文件的 SHA/size/mtime 保持原快照，其他 Claude 进程身份与签名由 commit-proof.json 单独核对。没有 push；完整目标仍开放。
