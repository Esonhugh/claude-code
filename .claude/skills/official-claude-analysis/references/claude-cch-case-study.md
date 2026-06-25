# Claude CCH Placeholder 调查案例总结

本 case study 总结了针对 official Claude Code bundle 中 CCH 相关行为的历史分析。它仅用于本地、已授权的兼容性分析，不提供破坏 CCH 的方法。

## 来源 transcript

主要历史 transcript：

- `CLAUDE_PROJECTS_ROOT/PROJECT_SESSION/74647e53-5d09-4171-b350-fc882e9503a2.jsonl`

相关 compact/subagent transcript：

- `CLAUDE_PROJECTS_ROOT/PROJECT_SESSION/74647e53-5d09-4171-b350-fc882e9503a2/subagents/agent-acompact-c26d2a5310f1dbb3.jsonl`

后续搜索没有发现历史 `claude_cch.py` 实现文件；大多数 `claude_cch.py` 命中来自后续要求搜索它的请求。

## 分析目标

判断 official `official-cluade` 是否包含可见的 client-side CCH calculation algorithm，并理解 CCH 相关文本如何生成。

同一历史分析中的次要目标包括 adaptive thinking 和 beta header 行为。

## 分析 artifacts

- `official-cluade`
- `/tmp/claude-package-extract/cli.original.js`
- `/tmp/claude-package-extract/vendor/**/*.node`

解包后的 JS bundle 约 17 MB，约 32k 行。

## 方法摘要

1. 使用 `scripts/native-extra.mjs` 解包 Bun standalone 风格 official bundle。
2. 在解出的 JS 中搜索 CCH 和 cryptographic anchors。
3. 定位 billing/attribution text construction function。
4. 在初始 fixed-placeholder 结论被质疑后，用 deobfuscation tools 重新佐证。
5. 因本地 `restringer` 遇到 Node ABI 问题，改用 Docker 跑 `webcrack` / `restringer`。
6. 搜索原始 binary 和解出的 native `.node` modules 中的 CCH / attestation 相关 strings。

## 关键发现

### Finding 1: JS 层包含 CCH placeholder

Claim: recovered JS layer 显示 `cch=00000;` 是生成的 billing/attribution text block 中的 literal。

Evidence:

- 历史 anchor 在 `/tmp/claude-package-extract/cli.original.js:258` 附近。
- 该 bundle 中函数名类似 `umn(e,t)`。
- literal text 包含 `x-anthropic-billing-header:`、`cc_version=`、`cc_entrypoint=`、`cc_workload=`、`cc_is_subagent=true;` 和 `cch=00000;`。

Confidence: 对 recovered JS bundle 为 high。

Impact: 不要仅根据 JS bundle 在 TypeScript 中实现 dynamic CCH algorithm；可见 JS 证据支持的是 placeholder。

### Finding 2: 静态 JS 搜索没有发现 CCH hash/HMAC 算法

Claim: 对 `checksum`、`seed`、`sha`、`hmac`、`signature` 等 anchors 的搜索，没有定位到 CCH-specific calculation path。

Caveat: 存在 generic dependency hits，尤其是 `sha` / `seed`；这些不是 CCH 证据。

Confidence: 在已搜索 JS artifact 范围内为 medium-high。

### Finding 3: Deobfuscation 没有恢复隐藏 CCH 逻辑

历史 `webcrack` 结果：

- prepare/unminify phases 运行过；
- `String Array: no`；
- deobfuscation 显示 `0 changes`；
- 后续 post-processing 可能 hang。

历史 `restringer` 结果：

- 本地运行因 Node ABI / `isolated-vm` 问题失败；
- Docker 运行检测到 `function_to_array_replacements`；
- 大 bundle 运行遇到 sandbox timeout / OOM (`137`)；
- partial output 没有显示 CCH seed/hash/HMAC/attestation logic。

Confidence: medium。工具失败限制了证明强度，但它们没有推翻静态搜索结论，反而形成佐证。

### Finding 4: Native module strings 搜索没有暴露 CCH 实现证据

Claim: 搜索 `official-cluade` 和解出的 vendor `.node` files，没有发现明确 CCH / billing-header / attestation implementation strings。

Confidence: medium。strings absence 不是 absence proof，但有助于排除明显 native string anchors。

### Finding 5: Native attestation 仍是线索，不是已恢复算法

Transcript 中包含一个线索：当 native client attestation 启用时，JS request body 可以包含 `cch=00000`，Bun native HTTP stack 可能在发送请求前覆写该 placeholder。被引用的实现名是 `bun-anthropic/src/http/Attestation.zig`。

分析没有从本地 extracted JS 或 `.node` artifacts 中恢复该 Zig 实现，也没有在 CCH transcript 中用 concrete Frida hook 证明该覆写。

Confidence: 对架构线索为 medium；对 exact native algorithm 的任何 claim 都是 low。

## 最终结论

历史证据支持以下谨慎表述：

> 在 recovered official Claude Code JS bundle 中，CCH 字段以 literal placeholder `cch=00000` 的形式出现在 `x-anthropic-billing-header` system text block 中。Transcript 没有恢复 JS-level seed/hash/HMAC/signature algorithm，也没有恢复明确 native-module implementation。相关 note 指向 `bun-anthropic/src/http/Attestation.zig`，提示 native HTTP stack 可能在发送前覆写 placeholder，但 available artifacts 没有恢复 exact native algorithm。

## 经验教训

- 用户质疑第一个 literal 结论时，不要停在第一处 literal；要用 deobfuscation 和 native artifact searches 佐证。
- 不要夸大 failed deobfuscators 的 negative results。
- 区分“JS layer shows placeholder”和“entire product never computes CCH”。
- Bundle function names 不稳定，只能作为历史 anchors。
- 保存 case summary，避免未来 Agent 重复昂贵搜索。

## 后续跟进模式

如果需要继续此 case：

1. 做新结论前，先重新检查 `74647e53-5d09-4171-b350-fc882e9503a2.jsonl` 中 CCH-specific evidence。
3. 如果运行新的 native analysis，使用 `native-binary-objdump-frida-workflow.md`，并保持 observation-only。
4. 如果后来找到具体的 CCH Frida `Interceptor.attach(...)` transcript，把 exact path、target function/offset、trigger 和 observed result 添加到这里。
