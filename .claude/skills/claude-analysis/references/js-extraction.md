# JavaScript 提取与可读性分析

## 范围

用于检查授权范围内的 Claude Code Bun standalone 二进制和恢复出的 JavaScript。目标为理解官方运行行为、构建产物和源码/二进制一致性。

## 工具定位

- `webcrack`：格式化并结构化恢复打包、压缩或混淆后的 JavaScript。用于提升可读性、恢复近似模块边界、检查 import/export 和控制流。
- `restringer`：恢复常见 JavaScript 字符串数组、字符串解码器和包装调用。用于把隐藏在 decoder wrapper 后面的文本变得可搜索、可阅读。
- `../scripts/native-extra.mjs`：skill 内置的 Bun standalone executable 提取器。先用它提取入口 JS 和内嵌 N-API 模块，再做 JavaScript 分析。

## `../scripts/native-extra.mjs` 行为

从 skill 目录运行：

```bash
node scripts/native-extra.mjs <binary-path> <output-dir>
```

从 `{PROJECT_ROOT}` 运行：

```bash
node .claude/skills/claude-analysis/scripts/native-extra.mjs <binary-path> <output-dir>
```

这里保留 `node`，因为脚本头部说明已把 lazy `Bun.file` 读取替换为 `readFileSync`，以便兼容既有 Node 调用路径。

脚本读取目标二进制，并根据 file magic 识别可执行文件格式：

- ELF：定位 `.bun` section。
- Mach-O：定位 `__BUN,__bun` section。
- PE：定位 `.bun` section。

支持的目标是 64-bit little-endian 的 `x64` 或 `arm64` 二进制。脚本会把检测到的平台映射为输出目录，例如 `x64-linux`、`arm64-darwin` 或 `x64-win32`。

提取流程：

1. 将二进制读入内存。
2. 按 ELF、Mach-O 或 PE 定位 Bun section。
3. 根据 offset 和 size 截取 section 内容。
4. 将前 8 字节读取为 payload length。
5. 提取 payload，并校验 trailer `\n---- Bun! ----\n`。
6. 读取 trailer 前的 offset struct。
7. 解析 `modules_offset`、`modules_size` 和 `entry_point_id`。
8. 遍历 module records，每条记录 52 字节。
9. 解码模块名、content offset、content size 和 loader id。
10. 将 entry module 写入 `<output-dir>/cli.original.js`。
11. 将 `loader=napi` 的模块写入 `<output-dir>/vendor/<name>/<arch>-<os>/<name>.node`。
12. 丢弃其他模块。

脚本期望恰好存在一个 entry-point module。如果数量不符，会以错误退出。

## 推荐本地提取流程

1. 在本地构建或取得授权二进制。
2. 提取 Bun payload artifacts：

```bash
node .claude/skills/claude-analysis/scripts/native-extra.mjs ./official-claude /tmp/extracted-claude
```

3. 检查输出：

```text
/tmp/extracted-claude/
├── cli.original.js
└── vendor/<native-name>/<arch>-<os>/<native-name>.node
```

4. 只对本地提取出的 JavaScript 运行可读性工具。
5. 在官方源码仓库中搜索匹配的字符串、函数名、选项名、协议字段和错误信息。
6. 将结论标记为 source-confirmed、binary-observed 或 inference。

## `webcrack` 使用说明

在已生成 `cli.original.js` 后使用 `webcrack`。将输出视为可读性辅助，而不是权威源码。需要把恢复出的结构与源码文件和运行时行为交叉验证。

典型用法：

```bash
npx webcrack ./extracted-claude/cli.original.js --output /tmp/extracted-claude/webcrack
```

适合用途：

- Pretty-print bundled code。
- 恢复近似模块边界。
- 查找字符串和调用点。
- 与源码级实现对比行为。

限制：

- 名称可能是猜测结果。
- 控制流恢复可能不完整。
- 生成输出可能存在细微语义差异。

## `restringer` 使用说明

当提取出的 JavaScript 包含字符串数组间接访问、decoder function 或 wrapper call 时，使用 `restringer`。

典型用法：

```bash
npx restringer ./extracted-claude/cli.original.js > /tmp/extracted-claude/cli.restringer.js
```

适合用途：

- 在安全时把 decoder call 替换为 literal strings。
- 让协议字段、CLI 文案和错误文本变得可搜索。
- 在人工 review 前降低阅读成本。

限制：

- 它不能证明行为。
- 遇到自定义复杂 transform 可能失败。
- 不应被用于生成规避性或重新打包代码。

## 报告检查项

- 包含精确的二进制路径、输出目录和命令行。
- 包含 extractor 输出中的 format、architecture 和 module count。
- 说明结论来自 extracted JS、source files 还是 runtime verification。

