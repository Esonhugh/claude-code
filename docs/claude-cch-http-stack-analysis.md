# Claude cch HTTP Stack Analysis

本文记录对 `package/claude` 中 `cch` 生成与替换逻辑的静态/动态分析结论。分析对象为 Darwin arm64 Mach-O Bun 编译产物，版本 `2.1.186`。

## 结论

`cch` 不是普通 HTTP header，也不是在 JS `fetch` wrapper、SDK serializer、`send/write/writev` 层做的字符串替换。

实际流程是：

1. JS 侧 `umn()` 生成 attribution 文本块，其中包含 placeholder：

   ```text
   x-anthropic-billing-header: cc_version=...; cc_entrypoint=...; cch=00000;
   ```

2. 该文本块被放入 Messages API JSON body 的 `system[0].text`。
3. `globalThis.fetch` wrapper 和 raw body logger 看到的仍是 `cch=00000`。
4. 进入 native/Bun HTTP 发送路径后，主二进制内部函数 `0x101424bac` 在发送前处理 body buffer。
5. 该函数在 body 中定位 `cch=00000`，按自定义规则分段计算 `xxHash64`，取低 20 bit，写回 5 位小写 hex。
6. 后续 `0x10140dd50 -> memcpy -> send/sendto` 只发送已经替换好的 body。

## 触发条件

JS 入口在提取出的应用代码中：

```js
function umn(e,t){
  if (el(process.env.CLAUDE_CODE_ATTRIBUTION_HEADER)) return "";
  ...
  let s = o==="firstParty" && bu() || o==="vertex" ? " cch=00000;\n" : "";
  ...
}
```

其中：

- `CLAUDE_CODE_ATTRIBUTION_HEADER=0` 会关闭 attribution block。
- `Ar()==="firstParty" && bu()` 时 first-party 路径生成 `cch=00000`。
- 本地 fake API 复现时需要设置 `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`，否则 localhost 不被视作 first-party Anthropic host。

## 关键地址

以下地址为主二进制静态 VM 地址，模块偏移等于括号内值：

```text
0x101424bac  offset 0x1424bac  cch/body 处理函数
0x10140dd50  offset 0x140dd50  发送前 body copy/send 管线
0x1005feabc  offset 0x05feabc  xxHash64 init
0x1005feb20  offset 0x05feb20  xxHash64 update
0x1005fec9c  offset 0x05fec9c  xxHash64 final
0x10030f030  offset 0x030f030  memmem/substring 搜索分发入口
```

动态 trace 证明：

```text
enter 0x101424bac:
  [obj+0x120] body contains cch=00000;

leave 0x101424bac:
  same body buffer contains cch=2b511; / cch=a9ad8; / etc.
```

而进入 send 阶段时：

```text
0x1007622e0  send wrapper
0x10140df24
0x100c348a8
0x100f06620
...
```

body 已经是最终值。

## 算法

hash 算法为 `xxHash64`，不是 CommonCrypto、HMAC、CRC32/CRC32C、Adler32、Murmur、FNV、DJB2 等。

反汇编中出现的常量与 `xxHash64` 完全匹配：

```text
P1 = 0x9E3779B185EBCA87
P2 = 0xC2B2AE3D27D4EB4F
P3 = 0x165667B19E3779F9
P4 = 0x85EBCA77C2B2AE63
P5 = 0x27D4EB2F165667C5
```

固定 seed：

```text
0x4d659218e32a3268
```

最终：

```text
cch = format(xxh64(hash_input, seed) & 0xfffff, "05x")
```

写回逻辑位于 `0x101425b24 - 0x101425bc0`，逐 nibble 转小写 hex，并写回 `cch=` 后面的 5 个字节：

```asm
strb w8, [x10, #8]  ; 第 5 个 hex 字节
str  w9, [x10, #4]  ; 前 4 个 hex 字节
```

## Hash 输入规则

它不是直接 hash 完整 JSON body。动态 hook `xxHash64_update` 后确认，输入为原始 body bytes 按规则切分后的拼接结果：

1. 将 body 中首个 `cch=xxxxx;` 归一化为 `cch=00000;`。
2. 跳过顶层 `model` 字段的字符串值，但保留两侧结构，例如保留 `{"model":"` 和后续 `"`。
3. 整段跳过顶层 `max_tokens` 字段。
4. 整段跳过顶层 `fallbacks` 字段。
5. 其余原始 bytes 按原顺序拼接后送入 `xxHash64(seed=0x4d659218e32a3268)`。

示例 trace：

```text
body len=66196
wire cch=c44ba

xxHash64 update chunks:
  [0, 10)
  [24, 65975)
  [65994, 66106)
  [66148, end)

skipped:
  [10, 24)        "claude-fable-5"
  [65975, 65994)  "max_tokens":64000,
  [66106, 66148)  "fallbacks":[{"model":"claude-opus-4-8"}],

xxh64 = 0x3bfec15b9b1c44ba
low20 = c44ba
```

另一个 fallback body：

```text
wire cch=4205e
xxh64 = 0x5a82fce066a4205e
low20 = 4205e
```

## Python 复算脚本

已保存 standalone 复算脚本：

```text
scripts/claude_cch.py
```

用法：

```bash
python3 scripts/claude_cch.py BODY.bin
```

输出格式：

```text
computed=57b4f existing=57b4f match=True
```

脚本要求输入原始 HTTP JSON body bytes。不要 `json.loads()` 后再 `json.dumps()`，否则字段顺序、空格和字符串转义会改变 hash 输入。

## 动态验证记录

使用 re-signed `/tmp/claude-frida` 和临时配置 `/tmp/claude-frida-config/settings.json`：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8770",
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_API_KEY": "test",
    "ANTHROPIC_MODEL": "claude-fable-5",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_DISABLE_TELEMETRY": "1",
    "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL": "1"
  }
}
```

Frida native 侧：

```text
NATIVE_ENTER id=4 len=66203 before=+17466:cch=00000;
NATIVE_XXH64 low20=57b4f full=0xd61077d196157b4f
NATIVE_LEAVE id=4 after=+17466:cch=57b4f;
```

fake API 收到：

```text
len=66203
cch=57b4f
file=/tmp/cch-pytest-rec-1.bin
```

Python 复算：

```text
python3 scripts/claude_cch.py /tmp/cch-pytest-rec-1.bin
computed=57b4f existing=57b4f match=True
```

三者一致：native 计算结果、wire body、Python 复算均为 `57b4f`。

## 重要排除项

- CommonCrypto import 存在，但 hook `CCHmac*` / `CCCrypt*` 在 cch 路径无命中。
- `send` / `sendto` / `write` / `writev` 层看到的是已经替换后的 body。
- `globalThis.fetch` wrapper 和 SDK `JSON.stringify` 阶段看到的是 `cch=00000`。
- 将 binary 内 `cch=00000` patch 为 `cch=11111` 后，wire body 保持 `11111`，说明 native 逻辑依赖精确 placeholder。
- 用户 prompt 中额外出现 `cch=00000;` 不会被全局替换；替换目标限定在 attribution/system body 的处理路径中。
