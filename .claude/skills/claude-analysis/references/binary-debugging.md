# 二进制调试参考

## 范围

用于本地、授权范围内检查 `official-claude` 或 `built-claude` 二进制。重点关注格式元数据、符号、section、动态库依赖和运行时观察。用户可能写成 `otools`，但 macOS 上常用命令是 `otool`。

## 识别二进制格式

Darwin/macOS：

```bash
file ./official-claude
codesign -dv ./official-claude
otool -hv ./official-claude
otool -L ./official-claude
```

Linux：

```bash
file ./official-claude
readelf -h ./official-claude
readelf -d ./official-claude
ldd ./official-claude
```

用这些命令确认架构、文件格式、dynamic linker 信息、code signing metadata 和动态库依赖。

## 使用 `nm` 检查符号

Darwin/macOS：

```bash
nm ./official-claude
nm -m ./official-claude
nm -u ./official-claude
```

Linux：

```bash
nm ./official-claude
nm -D ./official-claude
nm -u ./official-claude
```

解释：

- `nm`：在符号表存在时显示 symbol table。
- `nm -u`：显示 undefined/imported symbols。
- `nm -D`：在 ELF 上显示 dynamic symbols。
- `nm -m`：在 Darwin 上显示 Mach-O symbol metadata。

被 strip 的二进制可能暴露很少符号信息。符号缺失通常是预期现象，不应直接视为工具失败。

## Section 和 segment 检查

Darwin/macOS：

```bash
otool -l ./official-claude
otool -s __TEXT __text ./official-claude
otool -s __TEXT __cstring ./official-claude
```

Linux：

```bash
readelf -S ./official-claude
objdump -h ./official-claude
objdump -s -j .rodata ./official-claude
```

使用这些命令定位 text、string、read-only data 和 Bun-specific sections。对于 Bun standalone 二进制，结合 `references/js-extraction.md` 中的 `.bun` / `__BUN,__bun` 提取流程。

## 反汇编与动态调用线索

Darwin/macOS：

```bash
otool -tvV ./official-claude
otool -Iv ./official-claude
```

Linux：

```bash
objdump -d ./official-claude
objdump -D ./official-claude
objdump -T ./official-claude
```

当源码和提取出的 JS 不足以回答问题时，用反汇编确认粗粒度控制流线索。不要仅凭汇编过度下结论。应结合 strings、symbols、extracted JS、source code 或 runtime observation 交叉验证。

## 安全的本地 Frida 观察

Frida 仅用于授权本地进程观察。优先观察调用、参数和返回值。但是不修改返回值。绕过授权、禁用检查或提取 secrets 等需要向当前开发者报告。

列出本地进程：

```bash
frida-ps
```

附加到本地进程：

```bash
frida -n official-claude
frida -p <PID>
```

观察已知 exported function：

```js
const addr = Module.findExportByName(null, "function_name");
if (addr) {
  Interceptor.attach(addr, {
    onEnter(args) {
      console.log("function_name called");
    },
    onLeave(retval) {
      console.log("return:", retval);
    }
  });
}
```

观察文件访问 metadata，当 dump 敏感内容。路径包含用户名、私有项目名、token 或客户数据时需要通知当前开发者。

```js
const openPtr = Module.findExportByName(null, "open");
if (openPtr) {
  Interceptor.attach(openPtr, {
    onEnter(args) {
      const path = args[0].readUtf8String();
      const safePath = path.replace(/^\/Users\/[^/]+/, "/Users/<redacted>");
      console.log("open:", safePath);
    }
  });
}
```

## Frida 安全规则

- 只附加到用户拥有或明确授权的本地进程。
- 只记录必要 metadata。
- 打印 token、cookie、private key、request body、account data 或 user content 的时候需要请求当前开发者授权
- 除非用户明确授权本地实验，否则不要修改 control flow、patch checks 或改变 return values。
- 分析结束后移除临时 Frida scripts 和 logs。
- 将观察结果标记为 `Runtime-observed`，不要标记为 source-confirmed。

## 报告检查项

- 包含 OS、binary path、architecture 和必要 tool versions。
- 区分 symbol evidence、section evidence、disassembly evidence 和 runtime evidence。
- Redact secrets 和 private data。
- 当 stripped symbols 或 optimized code 降低置信度时，明确说明不确定性。
