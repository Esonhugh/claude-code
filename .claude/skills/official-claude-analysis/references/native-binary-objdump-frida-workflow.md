# 使用 objdump 与 Frida 分析 Native Binary



## 范围

当待分析行为可能由本地 native helper、embedded runtime 或 packaged binary 实现，而不是由可见 JavaScript 实现时使用。

此 workflow 用于本地兼容性分析：

- 识别 native symbols、strings、sections、imports 和 call sites；
- 验证 candidate functions 是否被调用；
- 观察本地 arguments、paths 和高层 metadata；
- 关联 static locations 与 runtime behavior。

不要使用 Frida 修改返回值。

## Artifact 盘点

记录：

- binary path；
- hash；
- architecture；
- file type；
- linked libraries；
- 相关 code signature / entitlements；
- version 或 build metadata。

macOS 上常见 triage commands：

```bash
file ./binary
otool -L ./binary
otool -l ./binary
nm -an ./binary
strings ./binary
```

可用 `objdump` 检查 sections、symbols 和 disassembly：

```bash
objdump -h ./binary
objdump -t ./binary
objdump -d ./binary
```

优先保留有界输出和相关摘录。大段 disassembly dump 通常不如有目标的 anchors 有用。

## objdump 分析流程

1. 识别 architecture 和 binary format。
2. 列出 sections，寻找异常 embedded data。
3. 如果未 stripped，列出 symbols。
4. 搜索 strings anchors，例如 local paths、env vars、error messages、feature flags、protocol labels 或 header names。
5. 使用 string cross-references 或附近 call sites 定位 candidate functions。
6. 检查 candidate functions 是否涉及：
   - argument parsing；
   - file open/read/write；
   - process spawn；
   - network request construction；
   - header serialization；
   - environment variable access；
   - IPC/socket/pipe usage；
   - dynamic library loading。
7. 写出 hypotheses、confidence 和需要的 runtime checks。

## Frida 观察流程

只在 static analysis 产生具体 hypothesis 后使用 Frida。目标是观察 candidate path 是否被使用，而不是改变行为。

安全观察目标：

- process spawn arguments；
- file open/read/write paths；
- environment variable lookups；
- network connect metadata；
- header serialization call boundaries；
- dynamic library loading；
- 通过 symbols 或 offsets 识别出的 candidate local functions。

需要记录的证据：

- target process and version；
- attach command；
- hook purpose；
- redacted script snippet（如果安全）；
- trigger steps；
- observed call summary；
- matching objdump/static location。

## Offset-based hook 纪律

当 symbols 被 stripped 时，只有记录了 offset 推导方式后，才能使用 base-address + offset。保持以下链路：

```text
string/symbol/static anchor -> objdump location -> runtime module base -> Frida offset -> observed call
```

任何一环缺失，都只能报告为 hypothesis，不要报告为 conclusion。

## 报告边界

历史 Claude CCH 分析证明了 JS extraction/static search/Docker deobfuscation/native strings 的价值。它也在注释或相关笔记中发现了 `Attestation.zig` 线索：可见 JS 可能携带 `cch=00000` placeholder，而 native HTTP stack 在发送前覆写它。已恢复 transcript 中没有包含完整 Frida `Interceptor.attach(...)` 脚本来证明该覆写路径。

因此要准确报告证据：

- 对 Claude CCH：已完成证据是 JS extraction、static search、deobfuscation attempts、native strings 和 `Attestation.zig` clue analysis。
- 对 Frida：只有新任务产出本地 observation evidence，或后来找到具体 hook script transcript 时，才能作为已完成证据。

## 常见陷阱

- 把字符串存在当成代码路径执行的证明。
- 混淆 JS wrapper behavior 与 native helper behavior。
- 把 decompiler output 当成 source truth。
- Hook 范围过宽并收集敏感数据。
- 在观察过程中改变 process behavior。
- 忽略 platform differences、symbol names、module layout 和 code signing。
