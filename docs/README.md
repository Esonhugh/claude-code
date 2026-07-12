# 文档中心

本目录收录 Claude Code 恢复工程的使用指南、架构说明、研究记录、设计规范和历史实施材料。

项目概览、快速开始和常用命令见根目录 [`README.md`](../README.md)；本页负责说明文档的分类、阅读顺序和维护规则。

## 推荐阅读顺序

1. [`guides/build.md`](guides/build.md)：构建、运行、验证和常见问题。
2. [`guides/secondary-development.md`](guides/secondary-development.md)：恢复源码的二次开发流程与约束。
3. [`architecture/runtime-internals.md`](architecture/runtime-internals.md)：CLI、REPL、查询循环、工具和 Agent 的入口索引。
4. 根据目标继续阅读对应的架构、研究或设计文档。

## 目录说明

| 目录 | 内容 | 维护方式 |
| --- | --- | --- |
| [`guides/`](guides/) | 面向使用者和开发者的操作指南 | 随当前实现持续更新 |
| [`architecture/`](architecture/) | 已实现系统的结构、调用链和源码索引 | 代码结构变化时同步更新 |
| [`research/`](research/) | 二进制分析、兼容性对比和实验结论 | 保留证据边界与分析日期 |
| [`design/`](design/) | 仍有参考价值的设计规范和方案 | 明确区分现状与目标状态 |
| [`workflows/`](workflows/) | Workflow 示例、兼容性说明和测试 fixture | 路径可能被脚本引用，不作为普通文档归档 |
| [`archive/`](archive/) | 已完成计划、交接记录、测试计划和历史实施材料 | 原则上只做链接修复，不再作为现行规范维护 |

## 指南

| 文档 | 说明 |
| --- | --- |
| [`guides/build.md`](guides/build.md) | 环境要求、依赖安装、构建、运行、验证和故障排查。 |
| [`guides/secondary-development.md`](guides/secondary-development.md) | 修改恢复源码时的工作流、类型恢复原则和验证要求。 |
| [`guides/recovery-workspace.md`](guides/recovery-workspace.md) | `2.1.88` 恢复工程背景、目录结构和恢复方法说明。 |
| [`guides/agent-development.md`](guides/agent-development.md) | Agent、工具、Hook、Plugin 等概念的入门学习路径。 |

## 架构

| 文档 | 说明 |
| --- | --- |
| [`architecture/runtime-internals.md`](architecture/runtime-internals.md) | 运行时主链路及关键源码入口。 |
| [`architecture/agent.md`](architecture/agent.md) | `AgentTool`、`runAgent`、前后台 Agent 和恢复机制。 |
| [`architecture/agent-team.md`](architecture/agent-team.md) | Team、共享任务、消息投递和协调者生命周期。 |
| [`architecture/workflow-orchestration.md`](architecture/workflow-orchestration.md) | Workflow、Agent、Skill、Hook、权限和隔离原语。 |
| [`architecture/plugin-marketplace.md`](architecture/plugin-marketplace.md) | Plugin 与 Marketplace 的加载、安装、缓存和策略模型。 |
| [`architecture/agent-sdk-exports.md`](architecture/agent-sdk-exports.md) | Claude Agent SDK 的导出面和扩展 API。 |

## 研究与设计

- [`research/`](research/) 保存 CCH 请求链、官方 Workflow 二进制、兼容性实验和 Codex 对比材料。
- [`design/private-plugin-marketplace.md`](design/private-plugin-marketplace.md) 是企业私有插件市场设计提案。
- [`design/workflow-runtime-parity.md`](design/workflow-runtime-parity.md) 定义 Workflow runtime parity 的证据基线和行为边界。

研究文档描述特定时间点的观察结果，不应直接视为当前实现保证；使用结论前应检查文档中的版本、日期和证据来源。

## 归档规则

`archive/` 中的材料用于追溯决策和实施过程：

- `archive/plans/`：已完成、已替代或暂停的实施计划。
- `archive/test-plans/`：阶段性验收方案。
- `archive/notes/`：研究过程、交接和临时记录。
- `archive/implementation-records/`：历史设计稿与逐任务实施记录。

新工作不应默认复制历史计划；应先以当前源码、测试和项目指令为准。

## 文档编写约定

新增或重写文档时，优先包含以下信息：

1. 目的和目标读者。
2. 当前状态：现行实现、设计提案、研究记录或历史归档。
3. 适用版本、日期和证据边界。
4. 关键文件、模块或操作步骤。
5. 验证方式和已知限制。

文件名使用小写 kebab-case；按主题放入对应分类，避免继续堆积在 `docs/` 根目录。

## 变更记录

[`../CHANGELOG.md`](../CHANGELOG.md) 是 `2.1.88` 基线之后功能和行为变化的权威记录。架构与设计文档可以解释背景，但不能替代 changelog。
