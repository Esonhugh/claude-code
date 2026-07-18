# 非交互式 Claude Code 调试

对于确定性的 output、exit-code 和 logging 检查，使用非交互式运行。实际 API request shape、proxy 或 wire transport 检查转交 `claude-network-debug`。

## 基础 print-mode 对比

用相同 prompt 和 environment 运行两个二进制：

```sh
env -i HOME="$HOME" PATH="$PATH" ./official-claude --print "hello" --dangerously-skip-permissions > /tmp/official.out 2> /tmp/official.err
env -i HOME="$HOME" PATH="$PATH" ./built-claude --print "hello" --dangerously-skip-permissions > /tmp/built.out 2> /tmp/built.err
```

只把完成该 runtime 检查所需的非网络变量逐个加回。若必须配置 proxy、base URL 或 OAuth transport，停止本流程并转交 `claude-network-debug`。

## JSON 与 stream output

当二进制支持时，优先使用显式 output/input format flags 做可复现 parser 检查：

```sh
./built-claude --print --output-format stream-json "hello" > /tmp/built-events.jsonl
./official-claude --print --output-format stream-json "hello" > /tmp/official-events.jsonl
```

验证 line-delimited JSON，但不要打印 private content：

```sh
bun -e 'for (const path of ["/tmp/built-events.jsonl", "/tmp/official-events.jsonl"]) { const lines = (await Bun.file(path).text()).split("\n").filter(line => line.trim()); for (const line of lines) JSON.parse(line); console.log(path, `json_lines=${lines.length}`) }'
```

## Exit-code 捕获

使用保留 stdout、stderr 和 exit code 的 shell wrappers：

```sh
set +e
./built-claude --print "hello" --dangerously-skip-permissions > /tmp/built.out 2> /tmp/built.err
code=$?
printf 'exit_code=%s\nstdout_bytes=%s\nstderr_bytes=%s\n' "$code" "$(wc -c < /tmp/built.out)" "$(wc -c < /tmp/built.err)"
set -e
```

## 配置一致性

比较 official/local 时保持配置一致：

- 相同 `HOME` 或 `CLAUDE_CONFIG_DIR`。
- 相同 OAuth/API key state。
- 相同 settings file。
- 相同非网络 runtime env；proxy/OAuth/base URL parity 转交 `claude-network-debug`。
- 相同 prompt 和 flags。

如果需要 config override，将其隔离到临时目录，并只复制必要文件。不要打印 config files 中的 secrets。
