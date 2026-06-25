# 分析笔记与证据模板

使用此模板保持 official Claude / Claude CCH 分析可复现。分开记录事实和假设，避免未来 Agent 重复相同搜索或夸大部分证据。

## 分析问题

- 我们要判断什么？
- 它为什么影响本地兼容性、parity、debugging 或防御性分析？
- 什么证据才算足够？

## 范围与安全边界

- Included artifacts:
- Excluded artifacts:
- Authorization basis:
- Sensitive data handling:
- Non-goals:

## 环境

- Date:
- OS / architecture:
- Shell:
- Node / Bun / Python versions:
- CLI version:
- Relevant environment variables, redacted:

## Artifact 盘点

| Artifact | Path | Hash/size | Type | Notes |
| --- | --- | --- | --- | --- |

## 已知信息 / 不要重复

- Previous transcript or case summary:
- Searches already performed:
- Ruled-out hypotheses:
- Known caveats:

## 静态分析记录

| Observation | Evidence | Confidence | Follow-up |
| --- | --- | --- | --- |

## JS bundle 分析

- Extraction command:
- Extracted JS path:
- Important anchors searched:
- Entrypoints:
- Important functions/modules:
- Recovered strings:
- Config/path/env behavior:
- Deobfuscation tools and results:
- Failed tools and failure reasons:

## Native binary 分析

- Binary paths:
- `file` / architecture:
- Linked libraries:
- Symbols/imports:
- Important strings:
- `objdump` / `otool` observations:
- Candidate functions or offsets:

## 动态分析记录

| Trigger | Observation | Evidence | Confidence | Follow-up |
| --- | --- | --- | --- | --- |

针对 Frida 或类似工具：

- Target process:
- Hook purpose:
- Static anchor:
- Attach command:
- Redacted observation:
- Did the hook observe or modify behavior?

## 行为映射

| Input/trigger | Code path | Side effect | Output | Evidence |
| --- | --- | --- | --- | --- |

## 与官方行为的差异

- Matching behavior:
- Divergent behavior:
- Unknown / untested behavior:
- Confidence:

## 风险与脱敏

- Sensitive data encountered:
- Redactions applied:
- Areas intentionally not analyzed:

## 结论

### Confirmed

- 

### Likely

- 

### Unknown

- 

### Recommended next checks

- 
