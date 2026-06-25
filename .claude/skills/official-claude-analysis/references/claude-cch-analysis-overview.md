# Claude CCH 本地兼容性分析总览



## 范围

当分析本地 Claude CCH / `claude_cch.py` 类兼容性问题时使用本 reference，尤其是用户询问 official Claude CLI 如何计算或注入本地 attribution、billing、cache 或 CCH 相关字段时。

目标是判断本地 artifacts 中存在什么，以及哪些结论能被证据证明。

## 典型目标

- 理解本地 wrapper、helper、bundle 或 cache 行为。
- 识别 JS bundle 中构造 attribution 或 billing 文本的位置。
- 判断某个值是在 JS 中计算、作为 placeholder 嵌入，还是委托给 native code。
- 对比 official Claude CLI 与本 TypeScript repo 的行为。
- 产出带置信度的可复现 case study。

## 输入

- 本地脚本，例如 `claude_cch.py`。
- 官方或本地 CLI bundle artifacts，例如 `package/claude`。
- 解出的 JS，例如 `/tmp/claude-package-extract/cli.original.js`。
- 解出的 native modules，例如 `/tmp/claude-package-extract/vendor/**/*.node`。
- 本地 runtime logs、tmux captures 和 command output。

## 推荐流程

1. 写清楚具体分析问题。
2. 盘点 artifacts，记录 path、size、hash、version 和来源。
3. 在可行时解出可读 JS 或 native modules。
4. 先搜索静态 anchors，再使用重型 deobfuscation。
5. 从 entrypoint 追踪到待分析行为的 call flow。
6. 将 deobfuscation 作为佐证，而不是唯一事实来源。
7. 使用 native strings / symbol inspection 确认或排除可能的 native 实现路径。
8. 只在本地、已授权进程上使用动态 instrumentation，并且只做观察。
9. 分开记录事实、假设、已排除路径和置信度。
10. 总结 case，避免未来 Agent 重复同样搜索。

## 证据规则

- 记录支撑每个 claim 的精确路径、命令、工具版本和输出。
- 优先使用有界 snippet 和 line/offset reference，不要 dump 大段 bundle。
- 脱敏 token、cookie、account ID 和用户数据。
- 除非搜索范围完整，否则说“在已搜索 artifacts 中未找到”，不要说“绝对不存在”。
- 区分 JS-layer behavior、native-layer behavior 和 service-side behavior。

## 历史 CCH case 边界

历史 Claude CCH 调查为 JS-layer placeholder 提供了强证据，但没有恢复 CCH 算法：

- `cli.original.js` 在生成的 `x-anthropic-billing-header` text block 中包含 `cch=00000;`。
- 静态搜索没有发现 JS 中的 CCH seed/hash/HMAC/signature 计算。
- 解出的 vendor `.node` modules 没有显示明确 CCH 或 billing-header 字符串。
- Docker `webcrack` / `restringer` 尝试没有恢复隐藏的 CCH 计算。
- 深搜没有在 CCH 主 transcript 中确认完整 Frida `Interceptor.attach(...)` 实操。

准确结论：JS 层显示 `cch=00000` placeholder。若真实 token 存在，可能在 recovered JS 之外产生，例如 native HTTP stack 或外部 build/runtime layer；历史 transcript 没有恢复出可复现算法。
