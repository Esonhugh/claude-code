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

## Official runtime 激活说明

`official-claude` 可能包含 attribution 和 CCH 代码路径，但在抓包中仍然不输出对应内容。下结论前先验证 effective runtime settings。

`official-claude` 2.1.195 的已观察行为：

- `x-anthropic-billing-header` 是 JSON request body 的 `system` text 里的 pseudo-header，不是 wire HTTP header。
- effective settings env 中必须有 `CLAUDE_CODE_ATTRIBUTION_HEADER=1`，才能强制开启 attribution。
- 全局 settings 文件可能在 shell env 设置之后重新注入 `CLAUDE_CODE_ATTRIBUTION_HEADER=0`；这种情况下仅用 shell 层 `env -u` 不够。
- 使用 `--settings '{"env":{...}}'` 做本地一次性 override，避免修改全局 settings。
- 在 `ANTHROPIC_BASE_URL=https://ai-gw.mjclouds.com` 这类 proxied first-party base-url 场景下，需要 `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` 才能激活 CCH placeholder 分支。
- `CLAUDE_CODE_RECOVER_FEATURES=NATIVE_CLIENT_ATTESTATION` 不能开启已经编译好的 official binary 中的 build-time feature 分支。

成功激活时，official debug log 可以显示 `cch=00000`；成功的 MITM body summary 应显示 native replacement 之后的结果，例如 `contains_cch_placeholder=false`、`contains_cch_param=true`，并在 `cch_values` 中出现真实 5-character hex 值。

将 `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` 限定为授权本地调试用途，不要推荐为持久默认配置。

## 报告检查项

- 记录 body 是否已有 `cch`。
- 报告 computed value、existing value 和 match status。
- 区分 debug log 中的 placeholder `cch=00000` 与 MITM request body 中 native patch 后的真实 5-hex value。
- 检查 settings env 是否覆盖了 shell env，尤其是 `CLAUDE_CODE_ATTRIBUTION_HEADER=0`。
- 除非明确授权，不要打印完整私有 request body。
- 将 patched files 保持在本地，并标记为 derived debugging artifacts。
