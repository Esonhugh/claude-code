# JS Bundle 提取与反混淆参考


## 范围

当本地 Claude CLI bundle 或 packaged JavaScript artifact 可能包含待分析行为时使用。目标是恢复足够的结构来理解本地兼容性行为，而不是重建专有源代码。

## 提取本地 bundle artifacts

对于本仓库中的 Bun standalone 风格 `official-cluade` artifact，在适用时使用已有解包脚本：

```bash
bun scripts/native-extra.mjs official-cluade /tmp/claude-package-extract
```

历史 CCH case 中的预期输出：

- `/tmp/claude-package-extract/cli.original.js`
- `/tmp/claude-package-extract/vendor/**/*.node`

分析前记录 artifact path、size、hash 和 extraction command。

## 先做静态 triage

运行重型 deobfuscator 前，先在解出的 JS 中搜索有界上下文。CCH case 中有用的 anchors：

- `cch`
- `CCH`
- `x-anthropic-billing-header`
- `cc_version`
- `cc_entrypoint`
- `cc_workload`
- `cc_is_subagent`
- `checksum`
- `seed`
- `sha`
- `hmac`
- `signature`
- `adaptive_thinking`
- `ANTHROPIC_BETAS`

不要 dump 巨大的 minified 行。使用脚本打印 line number 或 byte offset，并只截取小范围上下文。

## 历史 CCH anchors

历史 case 中关键 JS-layer anchor 是 `/tmp/claude-package-extract/cli.original.js:258` 附近一个类似 `umn(e,t)` 的函数。它构造了包含以下内容的 system text block：

```text
x-anthropic-billing-header: cc_version=...; cc_entrypoint=...; cch=00000; ...
```

关键解释不只是 literal string 本身。调用点把生成结果放进 system content，而不是普通 HTTP header。报告中必须保留这个区别。

该分析中其它有用概念：

- 类似 `Ar()` 的 provider detection function。
- 类似 `bu()` 的 first-party base URL check。
- 类似 `JOo(e,t)` 的 system prompt/cache block construction。

Bundle 输出中的函数名可能变化。把它们当作历史 anchors，不要当成稳定 API。

## 使用 webcrack

当 bundle 看起来像 webpack/browserify/esbuild-like，或存在 symbol mangling / module packing 时，可考虑 `webcrack`。如果本地 Node ABI 不兼容，优先考虑 Docker。

下面是历史调查中的命令模式，不是默认可盲目执行的命令。本仓库要求优先使用 `bun` 并避免 `npm`；只有在用户批准该环境特定分析命令后，才运行 `npx`/Docker 变体。

```bash
docker run --rm \
  -v "/tmp/claude-package-extract:/work:ro" \
  -v "/tmp:/out" \
  -w /work \
  node:22-bookworm \
  sh -lc 'npm_config_yes=true NODE_OPTIONS=--max-old-space-size=8192 npx webcrack cli.original.js --output /out/claude-webcrack-out'
```

历史观察：

- `webcrack` 在大 bundle 上完成了 prepare/unminify 阶段。
- 它报告 `String Array: no`，且 `deobfuscate` 产生 `0 changes`。
- 后续 post-processing 可能 hang 或耗时过长。

把 webcrack output 当成另一个辅助视图。不要在没有交叉检查 original bundle 和 runtime behavior 的情况下，把 reconstructed modules 当成官方源代码事实。

## 使用 restringer

当 string array decoding、constant folding 或 function-to-array replacement cleanup 可能有帮助时，可考虑 `restringer`。

下面同样是历史命令模式。新任务中运行前，需要确认工具可用性、package-manager 约束、Docker access 和用户授权。

```bash
docker run --rm \
  -v "/tmp/claude-package-extract:/work:ro" \
  -v "/tmp:/out" \
  -w /work \
  node:22-bookworm \
  sh -lc 'npm_config_yes=true NODE_OPTIONS=--max-old-space-size=8192 npx restringer cli.original.js > /out/claude-restringer-out.js'
```

历史 failure modes：

- 本地 `restringer` 因 Node ABI / `isolated-vm` 加载问题失败。
- Docker `restringer` 检测到 `function_to_array_replacements`，但在大 bundle 上遇到 sandbox timeout 和 OOM (`137`)。
- partial output 没有显示 CCH seed/hash/HMAC/attestation logic。

如果记录精确，失败本身也是证据。结合静态搜索和 native 搜索时，它可以支持“deobfuscation 没有恢复隐藏逻辑”的结论。

## Native module strings 佐证

JS triage 后，搜索解出的 native modules 和原始 binary 中的相关 strings：

- `official-cluade`
- `/tmp/claude-package-extract/vendor/**/*.node`

有用 anchors：

- `cch`
- `attestation`
- `x-anthropic-billing-header`
- `seed`
- `hmac`
- `sha`

要把普通依赖命中与候选实现证据分开。例如 crypto libraries 中泛化的 `sha` 或 `seed` 字符串，不是 CCH calculation 的证据。

## 报告格式

每个 claim 包含：

- Artifact and path。
- 使用的 tool/view。
- Observation。
- Evidence location 或 command output。
- Confidence。
- Follow-up 或 ruled-out interpretation。
