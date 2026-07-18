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

只记录变量名和是否存在，不把值写入 `/tmp`。网络相关变量仅记录 presence；若问题涉及其实际路由行为，转交 `claude-network-debug`：

```sh
bun -e 'const prefixes = /^(ANTHROPIC_|CLAUDE_|HTTP_PROXY$|HTTPS_PROXY$|NO_PROXY$|USE_|NODE_|BUN_)/; for (const name of Object.keys(process.env).filter(name => prefixes.test(name)).sort()) console.log(`${name}=<present>`)' > /tmp/claude-debug-env-presence.txt
```

即使文件只包含 presence，分享前仍应审阅；不要记录 token、key、cookie、account identifier 或 private path 的原值。

网络代理、OAuth transport 或 `NO_PROXY` 行为由 `claude-network-debug` 负责，本 reference 不指导抓流或代理配置。

## Debug artifact naming

文件名应编码 binary 和 mode：

```text
/tmp/claude-debug-built-print.log
/tmp/claude-debug-official-print.log
/tmp/claude-debug-built-stream-json.log
/tmp/claude-debug-official-stream-json.log
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
