# Claude Code 源码分析

## 范围

用于只读分析当前仓库或明确授权的 Claude Code 源码。优先回答实现位置、调用链、配置来源、状态迁移和源码与产物之间的关系；不把源码分支存在误报为运行时已验证。

## 工作流

1. 明确问题和目标版本，记录仓库根目录、当前 commit/工作树状态及相关入口。
2. 先按文件名、symbol、用户可见文案、setting key 或 debug marker 定位候选实现。
3. 阅读入口、直接调用者、被调用实现、状态存储和对应测试；不要只读单个匹配行。
4. 对条件分支记录触发前提、默认值、settings/env 优先级和失败路径。
5. 查找现有测试并区分：测试声明的预期、源码实现、当前 binary 的真实行为。
6. 需要确认构建产物时转到 `js-extraction.md` 或 `binary-debugging.md`；需要真实 CLI 行为时转到 `claude-runtime-debug` 或 `claude-agent-workflow-validation`。

## 证据标签

- `Source-confirmed`：当前已读源码直接支持。
- `Test-confirmed`：现有自动化测试明确覆盖，但本轮未必执行。
- `Binary-observed`：由提取、section 或 symbol 证据支持。
- `Runtime-observed`：由真实进程执行支持。
- `Inference / needs verification`：跨版本映射、优化后控制流或缺少入口证据。

## 常见检查

- CLI/flag：解析入口、默认值、冲突规则、帮助文本和 exit path。
- Setting/env：schema、读取位置、优先级、持久化位置和敏感值边界。
- Tool/Workflow：注册表、schema、dispatch、状态更新、终态和通知路径。
- UI：state 来源、render 条件、keyboard handler 和恢复路径。
- Build：源码入口、feature define、版本注入和 package target。

## 报告要求

引用具体 `path:line`，说明已读调用链和未读边界。不要根据函数名、注释或未执行测试单独宣称功能通过；需要动态证据时明确升级到对应 skill。
