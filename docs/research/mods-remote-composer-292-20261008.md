# 远程 prompt 编辑、补全与焦点：官方 2.1.292 对照

日期：2026-10-08。本批固定官方 **2.1.292**，本地 **2.1.280 未发布**。2026-10-08 再次查询 npm latest 已为 **2.1.293**，本报告没有把 292 的实测升级为 293。

## 实现与来源

补齐 `ui_prompt_edit`、`ui_prompt_autocomplete`、`ui_focus`，18 类远程控制全部有运行入口。它们通过真实模块扫描、Worker 事件、runtime 和 SDK 控制处理器执行；没有把 Unsupported 改为空成功回执。

- prompt 编辑：应用同步草稿不触发人工编辑 hook；按客户端串行执行并合并等待输入，选择更接近最后获建议草稿的 before，保留 UTF-16 splice 与 decorations，超时继续保留用户输入。
- prompt 补全：cursor clamp、从空白边界取得 token/start；四个输入事实只读，`next({})` 恢复缺失值。原始空 text 是非法行，整个 hook 回退；合法行再清理 Unicode、折叠 label 空白，清理后空候选移除。新的请求取消正在执行的补全，等待队列只保留最新请求，旧回执带 superseded。
- 远程焦点：渲染前采纳 isFocused，绘制后核对 Button/Input/Select 与 holder，移除失效 holder。Client 节点本身不是 terminal 控件。person/auto 与作者来源分别校验，只有持有键盘、当前实际绘制及正确归属的目标可移动；作者移动发送带会话身份的 system/ui_focus。
- `ui.focus` 输入 component/requestId/plugin/origin 只读；element 可以重写目标 key，但不能添加/删除。deny 必须为非空字符串，已经提交成功的 next 结果不能被迟到 deny 推翻。detach、close、session end 撤销等待与外部绘制身份。

官方模块固定提取根目录 `/private/tmp/mods-declarations-292-tawjepgs/re-extract-292/all`：`jjy8yg8v` 的 sw/iw/SI 为 render adoption、focusable 遍历与 stale holder；`Ls` 保留失焦渲染的 holder；c4e 只收集 Button/Input/Select；`r9hj3tk2` 的 Qe/rr/kr 为 deny、已提交 next 与原始候选约束。精确源码摘录、输入捕获及哈希见 `/private/tmp/mods-remote-controls-code-audit-292-20261008-r1/report.md`。作者参考：[Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)。官网摘要仍注明 2.1.290，应以安装版本生成声明和对应二进制为依据。

## 验收证据与失败历史

证据根目录 `/private/tmp/mods-remote-composer-292-20261008-rptx4ocs`。C 是干净父提交 45ebeb9 加本批增量，W 是完整工作区冻结快照加相同增量；二者不互相替代。使用独立 HOME/config/tmp、私有 tmux socket 与 localhost dummy provider；未使用真实凭据，未替换 ROOT 正在运行的 binary。

| 范围 | 结果 | 证据 |
|---|---|---|
| 空候选、render isFocused 回归前 | 14 pass / 2 fail | candidate-composer-red2 |
| 迟到 focus deny 回归前 | 9 pass / 1 fail | candidate-focus-deny-red1 |
| 本批 Worker 回归修复后 | 18 pass / 0 fail / 155 assertions | candidate-composer-green4 |
| 干净候选相邻 18 文件 | 736 pass / 7 skip / 0 fail / 3168 assertions | candidate-focused6 |
| 完整工作区相邻 21 文件 | 821 pass / 7 skip / 0 fail / 3671 assertions | workspace-focused4 |
| 两侧完整 release-check / build | exit 0；源码不漂移 | candidate-check3/build2，workspace-check3/build2 |
| 原历史八控制重跑，官方与候选 | 282/282 | native-comparison-pair.json |
| 新增真实正向编辑、补全与 focus，官方与候选 | 374/374 | native-composer-deep3-pair.json |
| 同输入官方 / 候选 / 完整工作区 | 562/562 | native-composer-deep3.json |

7 skip 是可选外部官方夹具缺失，不算通过。检查与构建时 C 源码集合 SHA256 `90bc20b021c1909bc5d4bd35d882cdc695233723372e2d0678ea71d5adf03fcd`；W 为 `8d6bd20bc9bd96c99e11cc046e32a3cfba5c390363e2cdff72f437864566fd13`。随后更新说明文件和验收脚本会产生新集合；旧轮次身份不改写，最终提交前另作检查和构建。

deep3 每侧实际 **146 控制回执、127 事件观察**，normal EOF exit 0，0 model POST，私有 pane/server/process group/socket/provider/线程均回收，binary 和 fixture 哈希不变。既有 Client 消息、故障与恢复、旧绘制回调失效等相邻断言保留。`deep1` 的空候选差异是本轮真实失败，保留原文件；没有用归一化隐藏功能差异。

归一化仅用于按归属/首个绘制代次定位的 opaque handle、生成的 session ID/cwd，以及独立事件观察顺序。官方结构日志将 token 字段遮蔽，fixture 的 word 别名逐侧独立核对等于 UTF-16 slice(text,start,cursor)，再用于同 token 的比较；原始请求和观察均保留。比较层明确排除 start/end 的 cwd、sessionId、resume，以及 system 推送的 uuid/session_id；initialize 元数据整项不进入回执等价比较。排除项在结果中单独列出，不能据有限比较推断它们已匹配。实际 opaque handle 用于 stdin 请求。

## 验收有效性和未完成范围

上述是有源码、真实 Worker、新编译 CLI 与完整输入/回执证据的有限控制对照，**不是全部 Mods/UI/diff 发布验收通过**。

- 全矩阵第二轮计划 readiness + 27 目标共 28 场景，实际只完成 readiness、agent-fg-bg、builtin-mods 三项后 fail-fast。前两项通过；builtin 行为八项通过，diff 的禁用侧 native ownership 提取缺口使该目标失败。未启动的 25 项不是通过。原件 `full-gate2-evidence/driver-final-manifest.json` 保留。
- 前台 fixture 必须显式声明同步模式；四个目标可分别使用自定义 Agent 和逐案 legacy opt-out。Workflow、code-review、team、retention 仍按产品默认模式验收，不用关闭 Fork 遮盖真实 caller 问题。
- 初始 render 失败时的 test cleanup 修复只涉及测试卫生。历史几何 9/7 失败没有在无强制修改的重跑中稳定复现；人为 chalk undefined 同指纹不等于生产根因已修复。
- builtin 七侧目前缺启动起原始 PTY / input chunks / 独立逐帧 physical replay；最终 capture-pane 或产品自身 stdout 回放不能据此判 full-covered。完整 terminal/diff/G5、五类 responder、外部浏览器 Client 与其他 WIP 继续闭合；未实现项不是豁免。
- 1538ee0 修复宿主 capability Proxy catch，证据另见[异常边界专项](mods-capability-error-audit-20261008.md)。故障注入明确区别于公共 CLI。

每轮追加失败、证据身份和新的 verdict，不覆盖历史记录；提交不代表 push、tag、release 或整体放行。

## 提交前最终冻结轮次

文档与夹具更新后的同轮 source SHA：C `2217831de051f9630b848746665638d8cec72e725a1d9a7f503bb241dacdac3b`；W `bdb191b032d87fc0d383eb77319136ecdad8f3592d84f80704897588dd89ec9c`。`candidate-focused7` 736 pass / 7 skip / 0 fail，`workspace-focused5` 821 pass / 7 skip / 0 fail。两侧 `check4` 完整检查与 `build3` 均 exit0，输入源码未漂移，所属进程组已回收。

- candidate build3 binary SHA256 `311011bb2b670c88d951b4342b6ae9ad02ac75c69bef55435c1fe74e99e0d792`。
- workspace build3 binary SHA256 `693e6b8c800b5c155cc2347390847f3aa8a1699553502f555eab84bf6902f898`。

重新从头串行运行官方、C、W 的 `deep4`，每侧146回执、127事件、normal EOF exit0与全部私有资源清理。`native-composer-deep4-pair.json` **374/374**，`native-composer-deep4.json` **562/562**；与 deep3 分别封存，不拼接通过率。完整发布矩阵仍未通过，未据此放行 UI/diff/浏览器。
