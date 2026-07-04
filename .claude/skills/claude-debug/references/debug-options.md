# Claude Code debug options

添加代码 instrumentation 前，优先使用内置 debug options。

## 发现当前 flags

Flags 可能在 official/local 版本之间变化。直接检查每个二进制：

```sh
./official-claude --help > /tmp/official-help.txt
./built-claude --help > /tmp/built-help.txt
```

在本地比较 help output，只引用相关 flag lines。

## Debug logs

可用时使用 `--debug` 和 `--debug-file`：

```sh
./built-claude --debug --debug-file /tmp/claude-built-debug.log --print "hello" --dangerously-skip-permissions
./official-claude --debug --debug-file /tmp/claude-official-debug.log --print "hello" --dangerously-skip-permissions
```

official 和 local 使用不同文件。不要在多次运行之间复用同一个 debug file，除非你明确希望 append。

## 有用的环境检查

记录会影响路由和行为的非敏感环境值：

```sh
env | sort | grep -E '^(ANTHROPIC_|CLAUDE_|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|USE_|NODE_|BUN_)' > /tmp/claude-debug-env.txt
```

分享前先审阅输出。脱敏 tokens、keys、cookies 和 account identifiers。

## Debug artifact naming

文件名应编码 binary 和 mode：

```text
/tmp/claude-debug-built-print.log
/tmp/claude-debug-official-print.log
/tmp/claude-debug-built-proxy.jsonl
/tmp/claude-debug-official-proxy.jsonl
```

## 安全报告实践

可以报告：

- flag names；
- exit codes；
- 不敏感的 request IDs；
- 已脱敏 header names 和 value presence；
- checksum computed/existing/match facts；
- byte counts 和 event counts。

避免报告：

- OAuth access/refresh tokens；
- API keys；
- cookies；
- 完整 private prompts；
- 完整 request/response bodies，除非用户明确授权。
