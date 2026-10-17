# Mods ui.copy 函数暴露与终端复制（2026-10-07）

独立提交候选以 b4186626eb2cff0b6e084d1f5ef06837a28e3c65 为基准，仅移入工作区已有的 ui.copy 加载、Worker 投影、host 分发与 REPL responder。当前工作区包含其他 WIP；两个本地侧单独测试、检查和构建。证据根 `/private/tmp/mods-declarations-292-tawjepgs`，不 push，整体对齐目标仍在进行。

## 官方实现与提交范围

本轮 [npm latest 元数据](https://registry.npmjs.org/@anthropic-ai/claude-code/latest) 核实官方 **2.1.292**；native SHA-256 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`，235017328 bytes。[Mods 参考文档](https://code.claude.com/docs/en/plugins/mods/reference) 当前标注 v2.1.290；较新实现以原生制品与实测为证。

本轮解包 `re-extract-292/all/chunk-pwkr374y.js`，SHA-256 `8b93f8413302c356042d9ae35eefb64605e2eb82432f0c3c24d4d0e29a8d078d`，字符偏移约 2304594/2304890 的 AUo/PUo：先使用首次附着 surface，检查目标是否绘制，非终端委托客户端，终端调用已有 clipboard 路径；仅非空且不超过 1048576 字节的 OSC 字符串写 stdout。源码窗口和模块身份见 copy-source-provenance.json；不执行解包代码。

新增 ui.copy 至 scanner/Worker/core host 支持集；公开参数仅投影 text/surface，保留同步 getter 求值，不转换 text。Hook 获得冻结事件及实际调用插件 origin，允许改写 text/surface、返回 value 回执或 deny。原有泛型 envelope 对 JavaScript 作者的 opaque value 行为保留；公开 TypeScript 仍约束 UiCopyResult。

真实交互 REPL 的 terminal responder 使用已有 getClipboardPath/setClipboard，默认首个 surface；无绘制目标返回 no-surface，缺 responder/超界返回 no-clipboard。终端 debug 记录插件、长度、路径、OSC 写入状态；未附着/远程无 responder 记录目标与长度，不记录复制正文。远程真实客户端 responder 尚未完成，不将测试 host 的 desktop responder 记为产品端到端支持。

## RED 与最终门禁

copy-red-test **4 pass / 9 fail**：clean HEAD 缺函数/事件，真实 Worker 调用拒绝；clipboard 及类型原有能力已可独立通过。首次迁入脚本在私有候选缺少 panes anchor 处失败，已写入的部分保留为 copy-green-test **11/2**，缺同步 getter 投影。补齐 wrapper 与 REPL responder 后 copy-green2-test **13/0**。这些失败与修复日志保留，未删除或放宽原断言；ROOT 的相关生产源码原为已有 WIP，本轮未改写。

正式只使用 copy-*-final-* 与 copy-*-isolated-*；独立无开发者凭据 HOME/config/cache/真实 TMPDIR，120s 硬截止、自有 process group 清理。完整命令、环境与逐文件源清单在各目录 start.json/before.json/result.json/log.txt。最终测试/检查/构建源 manifest 相同，均 sourceUnchanged=true、cleanup 完成；manifest 包含 CHANGELOG，随后 README/报告/台账追加不改变该清单。

- candidate source SHA-256 `461e586bd706d73c88743527fa2e8f0120fcf153c07fba61f944ec7e4f1517bf`。
- workspace source SHA-256 `6113b5a531ee6486491a64ff36f7d59fa0c7fe989361c96e6bea571d8822d48a`。

| 检查 | 独立候选 | 工作区 |
| --- | --- | --- |
| 10 文件相邻测试 | 412/0，14.788s | 430/0，15.289s |
| make release-check | exit 0，45.909s | exit 0，47.238s |
| make build | exit 0，5.785s | exit 0，5.714s |
| uiCopy 单独 | 9/0，1.516s | 9/0，1.158s |
| uiCopyTerminal 单独 | 2/0，0.238s | 2/0，0.236s |
| uiCopy.types 单独 | 2/0，2.779s | 2/0，2.638s |

十文件为 uiCopy、uiCopyTerminal、uiCopy.types、runtimeUi、uiRealm、ui、uiEnvironment、loader、diffTakeover、shippedDiffStartup。相邻 suite 有 **3 项既有 skip**（未启用官方助手插件夹具），本批未新增 skip；412/430 为实际通过数，不把 skip 算作通过。三个 copy 测试各自 9/2/2 项，无 skip。

## 三侧原生终端对照

`python3 native-copy.py <official|candidate|workspace> final1` 串行使用各自新 HOME/config/PTY/tmux/socket/fixture。driver SHA-256 `3ddcf90cfde3bc61439f175fd666c012bb568f44c77f6b5788c8b270136abff1`，100s 总 deadline、每个屏障最多15s；隔离沙箱禁网络、Keychain 和用户 ~/.claude，dummy key。只在自有 detached tmux 捕获 OSC 与 buffer，不读写系统剪贴板，不使用用户现有终端。

`python3 compare-copy.py` exit 0，copy-native-comparison.json：三侧同一 fixture/输入/driver，**8 个作者回执、6 个操作事件及 origin 完全相同**；原文和 Hook 改写后两个 OSC base64 解码结果与自有 tmux buffer 字节相同。包括基本复制、改写、未附着目标、refused、deny、五种非法输入、两个同步 getter 错误、JavaScript opaque value。三侧正常 /exit 0，二进制未变，自有服务器清理 exit 0，无 dropped ui.log 警告。

| 制品 | SHA-256 | bytes / mtime ns | native 秒 |
| --- | --- | --- | --- |
| official | `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f` | 235017328 / 1791315880497388108 | 3.702 |
| candidate | `c1472a3a22318dfa978848c6addcc68f7940ad76412d9c732a0b9a3b3e206b4b` | 102117218 / 1791349426481177668 | 4.067 |
| workspace | `ee7623a6a8c1b5ca93412a3cfe28f6d9aa4d28cd6bfa8b40c17f196058ec5e20` | 102018146 / 1791349426480274353 | 4.944 |

终端 unit 另核对 verbatim UTF-8、恰好 1 MiB OSC 接受与超过边界拒绝，独立四秒子进程。远程 1000000 字符边界由 host 用例覆盖，不等同于真实远程终端验收。系统 clipboard 的 pbcopy/win32、完整 remote responder、所有 UI 画面及全部 API/context/diff/G5、全部 WIP 门禁仍待完成；本批不声称完整 Mods 兼容。

## 保护与提交

候选只选 12 路径：五个生产路径、三个相关测试、README/CHANGELOG/mods-test 和本报告。根目录的生产 ui.copy 文件与三个测试全部保持任务开始时字节和 mtime；其他 WIP 不整体暂存。冻结 3141 路径、原 response.md/fix-instructions.md/improvment.md、旧 Mods 声明与共享 binaries 均核对保留；其他 Claude PID 94223/70780 只读确认，不发输入或信号。最新 2.1.292 声明同步仍为下一独立批次，类型专用候选此前的 ui.copy 加载失败完整保留，不能当作通过证据。
