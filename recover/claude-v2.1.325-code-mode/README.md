# 官方 2.1.325 Code Mode 相关模块

来自 `@anthropic-ai/claude-code-darwin-arm64@2.1.325` 原件（SHA-256 `84590fefe6338be9087f5814b61f9a54c5f21524163a4c127cb5a808e31009f2`）的 Bun module table，2026-11-15 提取。分析结论见 [`docs/research/code-mode-325-20261115.md`](../../docs/research/code-mode-325-20261115.md)。

- `origin/`：模块原样字节，校验值在 `SHA256SUMS`。
- `pretty/`：去掉前 4 行版权头和 `import ... from "/$bunfs/..."` 后，用 `node_modules/.bin/prettier --parser babel --print-width 140` 格式化。研究文档里的行号都指这里的文件。

只收了研究文档引用的模块。主 bundle `chunk-wqb2b4v0.js`（约 5.7 MB）没有收，需要时按研究文档的复现步骤从原件提取。chunk 名每个版本都会变，不能拿来对照其他版本。

| 模块 | 内容 |
| --- | --- |
| `chunk-g61t94xb.js` | `EvalTool`：工具定义、prompt、内层调用流程、vm 执行器、sealers |
| `chunk-xjqp3eha.js` | 开关函数、工具隐藏规则、上限常量 |
| `chunk-ap2d935y.js` | `chunk-xjqp3eha.js` 的具名重导出（`CODE_MODE_ONLY_TOOLS` 等） |
| `chunk-yb2dtjhc.js` | 工具名 `REPL` / `Eval` / `Code` |
| `chunk-gwh19369.js` | opt-in 接受状态 `le()` / `qc()` |
| `chunk-ev5tx9th.js` | opt-in 判定、模型条件、重启 |
| `chunk-qrk6v9qh.js` | `chunk-ev5tx9th.js` 的具名重导出 |
| `chunk-vpz3nf29.js` | 启动时调用 `settleCodeModeOptInAtStartup` |
| `chunk-1f850fa5.js` | `CodeModeOptIn` 确认对话框 |
| `chunk-8sstk0cs.js` | 显示名 `Code Mode (experimental)` |
| `chunk-yw5xfhrq.js` | 拒绝原因文案、settle 状态 |
| `chunk-av8gd5nc.js` | vm context 创建与内置对象冻结 |
| `chunk-2hbz1qvr.js` | engine check 实现 |
| `chunk-f8sqhjr1.js` | engine check 的重导出 |
| `chunk-8zhkjzrx.js` | `willListHiddenToolNames` |
| `chunk-gcw6cvys.js` | `ReplSessions` |
| `chunk-18z4c769.js` | `ReplSessions` 的重导出 |
| `chunk-pg2sb68f.js` | `Poll` 工具 |
| `chunk-qbfszyx1.js` | 后台脚本错误的虚拟 REPL 消息 |
| `chunk-vt245mgz.js` | 内层工具进度的暂存与释放 |
| `chunk-6fgj334j.js` | 工具池移除 `CODE_MODE_ONLY_TOOLS` |
| `chunk-3g112haw.js` | 被隐藏工具不进入 deferred/ToolSearch |
