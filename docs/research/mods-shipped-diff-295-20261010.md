# 官方 diff Mod 2.1.295 的固定来源与验证边界

本批将生产 diff 归档从 2.1.292 更新为 2.1.295。它使用官方作者 Mod 的原样注册闭包，保留真实 Worker、宿主 `/diff` 接管和生命周期；不另写一个外观近似的 diff viewer。完整 Mods/UI 与发布验收仍需独立闭合。

## 官方差异与来源

2026-10-10 台北时间核对 [官方包元数据](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)，最新为 2.1.295。darwin-arm64 原件 SHA-256：`0116ee2e0a513900b633d9951367f18747686478e2b462805b8c31609f047f70`。

从原件的 Bun module table 只读提取 `chunk-8mmnqsff.js` 及身份模块 `chunk-56g3eekf.js`；未执行解包后的 CLI JavaScript。注册闭包为 bytes 12121..62470，导出 `xm`；原始 scan 为 bytes 5744..6328。完整模块、身份、闭包、scan 与归档分别固定 SHA-256，运行加载与离线打包使用相同 provenance。

官方 295 比 292 移除 diff dock 顶部的一行留白，同时同步四处计算：可见正文行数不再减去这行；内容起点上移一行；传入正文的 viewport 保留原 rows；最外层 Box 不再有 `paddingTop:1`。Babel AST 仅用于静态比较绑定名及常量，实际打包的作者代码保持原样。

归档 `assets/builtin-diff-2.1.295.zip` 的 SHA-256 为 `67a4025549b14844f13e3d6a906b336306652f7cb62d61dcc32179acd5762340`。旧 291/292 归档保留为历史来源，生产启动只选择 295；缺失、过期、篡改或 provenance 不符时记录明确错误并恢复原生 diff。普通 manifest 不能获得官方接管身份。

## 使用与复现

在全屏 Git 工作区输入 `/diff`，打开或关闭官方 diff 面板。`cc-plugin-diff@builtin` 开关及 `diff@builtin` 别名保留；官方插件活跃时暂停原生 diff 的打开和后台刷新，卸载或拒绝后恢复。

`Ctrl+X B` 切换 base，`Ctrl+↑/↓` 滚动文件列表。真实官方/本地同脚本对照曾出现本地首次 base 操作未生效；仅加日志的独立轮次成功不计修复证明。最小提交阶段回归在旧宿主下为 0 pass/1 fail，证明 Pane 出现在 layout commit 时 action 尚未登记。改在 layout effect 登记与释放，重绘时同步替换 drawing；`[ModsPaneAction]` 仅记录动作及代次/准入布尔值，不记录 prompt 或 diff 正文。

```sh
bun scripts/package-official-diff.mjs /path/to/verified-2.1.295-modules /tmp/new-official-diff-295.zip
bun test --no-env-file ./scripts/shipped-diff-295.test.mjs ./scripts/shipped-diff-production.test.mjs ./scripts/shipped-diff-debug.test.mjs ./src/plugins/bundled/shippedDiffStartup.test.ts ./src/plugins/bundled/shippedDiffProductionVersion.test.ts ./src/services/mods/diffTakeover.test.ts
make release-check
make build
```

离线 producer 在写入前检查每份原始输入的摘要，使用固定 ZIP 时间，只创建新文件。`--debug --debug-file /tmp/claude-diff-debug.log` 可检查 `[ModsBuiltin]` 中的 package version、archive/module hash、storageId、加载失败阶段与原因。

## 回归与证据

证据根：`/tmp/claude-test/mods-diff295-20261010-v0ozm8cn/`。旧 producer/loader 对真实 295 输入为 0 pass/2 fail；旧 292 Worker 首次 Write 的无顶部留白回归为 13 pass/1 fail，实际 paddingTop=1。原件保留，不改判。

本批回归覆盖准确归档重现、原始闭包、篡改拒收、生产启动/只读发现、接管权限、首次编辑打开、原生轮询暂停、关闭、卸载及 Worker 恢复。准确命令、源码摘要、构建产物和真实 CLI 结果以该目录本轮回执为准，不能把源码测试当成 binary 或物理画面验收。

本轮真实 CLI 使用独立 HOME/config、虚构凭证、160×50 tmux、九文件 Git fixture 和关闭的 loopback 端口；没有 `--plugin-dir` 或归档覆盖。两侧脚本一致，验证 autocomplete、打开、base 切换、列表上下翻页、关闭、重开及正常退出。各轮驱动源码、输入字节、pane/ANSI、debug、EOF/reap、binary 和逐帧原件独立保存；最终轮次及有限范围结论见证据根的 `VALIDATION.md`，不能拼接探索轮次或据最终画面替代失败帧。

仍需对最新双方的文件/base/turn、ask 上下文、刷新、滚动、普通终端内联/全屏、resize、取消与丢弃、Client 生命周期、输入归属及逐帧画面结算。同轮完整发布矩阵和四路只读审查未通过前，整体 goal 及 full release 保持未完成。

## 本轮结论（2026-10-10）

冻结的生产代码通过 284 项相关测试、release-check、构建；双方真实 CLI 各完成同脚本 10 个检查点，本地 74 帧严格回放通过。这些有限范围结果不能升级为完整 UI 或发布通过。

五阶段逐格比较每阶段 3195 个 dock 单元格：初始空面板完全一致；首次正文快照有 1093 个单元格差异，其中 227 个为文字/宽度差异；后续三个阶段各有 1077 个样式差异，文字一致。官方使用 256 色，本地正文使用 RGB。独立诊断确认本地运行时选择 truecolor，但其来源及首次快照文字差异的原因尚未确证；不得归因后忽略原失败。UI 验收为 failed，完整发布未通过。

这段结论与 mods-test.md 的最终记录是在 binary 验证后补写的文档；生产源码、测试、README、CHANGELOG 和打包输入未改动。新的文档检查、原件哈希及结论核对记录见证据根 VALIDATION.md 和 document-verification.json。
