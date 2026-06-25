# cch checksum 分析

## 目的

使用 skill 内置的 `../scripts/claude_cch.py` 分析、计算、比较或本地更新授权 Claude Code request-body fixture / debugging sample 中的 `cch=xxxxx;` 字段。该脚本适合在协议分析和兼容性调试时复现 checksum 行为。

## 命令行行为

`--patch` 可用于本地授权的 synthetic debugging。

从 `{PROJECT_ROOT}` 运行：

```bash
python3 .claude/skills/claude-analysis/scripts/claude_cch.py BODY.bin
python3 .claude/skills/claude-analysis/scripts/claude_cch.py BODY.bin --patch OUT.bin
```

从 skill 目录运行：

```bash
python3 scripts/claude_cch.py BODY.bin
python3 scripts/claude_cch.py BODY.bin --patch OUT.bin
```

脚本按 bytes 读取 `BODY.bin`。不带 `--patch` 时，如果 body 中已经包含 `cch=xxxxx;`，输出 `computed=<value> existing=<value> match=<bool>`；否则只输出 computed checksum。带 `--patch` 时，写出一个本地副本，并将第一个匹配到的 `cch` 字段替换为计算值。

## Hash 算法

脚本实现了 XXH64 风格的 64-bit byte hash，并使用固定 seed：

```text
SEED = 0x4D659218E32A3268
P1 = 0x9E3779B185EBCA87
P2 = 0xC2B2AE3D27D4EB4F
P3 = 0x165667B19E3779F9
P4 = 0x85EBCA77C2B2AE63
P5 = 0x27D4EB2F165667C5
```

所有算术运算都 mask 到 64 bit。实现按 32-byte stripes 处理输入，然后处理 8-byte、4-byte 和 1-byte tail，最后执行 XXH64 avalanche steps。

最终 `cch` 值：

```text
cch = xxh64(cch_hash_input(body), SEED) & 0xfffff
```

格式化为恰好 5 个小写 hex 字符。

## `cch_hash_input` 的输入规范化

`cch_hash_input(body)` 生成实际参与 hash 的 byte sequence：

1. 将第一个 `cch=[0-9a-fA-F]{5};` 替换为 `cch=00000;`。
2. 用轻量 byte scanning 将 body 解析为 top-level JSON object。
3. 对 top-level `model`，只移除引号之间的字符串值内容，保留 key、colon、quotes、whitespace 和周围结构。
4. 对 top-level `max_tokens`，移除整个 top-level field segment。
5. 对 top-level `fallbacks`，移除整个 top-level field segment。
6. 拼接剩余 byte ranges 并进行 hash。

因此 checksum 不依赖已有 checksum 值、具体 model 字符串内容，以及 top-level `max_tokens` / `fallbacks` 字段。

## 重要函数

- `xxh64(data, seed=SEED)`：计算 64-bit hash。
- `cch_hash_input(body)`：hash 前规范化 bytes。
- `compute_cch(body)`：返回最终 5-hex checksum。
- `current_cch(body)`：返回已有 checksum；没有则返回 `None`。
- `patch_cch(body)`：将第一个已有 checksum 替换为计算出的 checksum。
- `main(argv)`：compute 和 patch 模式的 CLI 入口。

## Parser 行为与限制

该脚本不是通用 JSON parser。它通过 byte scanning 识别 top-level fields、quoted strings、arrays、objects 和 primitive values。

重要限制：

- body 必须是 top-level JSON object。
- 只规范化 top-level `model`、`max_tokens` 和 `fallbacks`。
- 不规范化嵌套同名字段。
- 只替换第一个匹配的 `cch=xxxxx;`。
- 非法字符串或括号不匹配会抛出错误。

## 报告检查项

- 记录 body 是否已有 `cch`。
- 报告 computed value、existing value 和 match status。
- 除非明确授权，不要打印完整私有 request body。
- 将 patched files 保持在本地，并标记为 derived debugging artifacts。
