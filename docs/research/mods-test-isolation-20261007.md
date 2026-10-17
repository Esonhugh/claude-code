# Mods 测试环境隔离：2026-10-07

本批以提交 `69400258febad145802cb25cc3ac3611269ba89e` 为基线，仅包含 `query.promptCompose.test.ts`、`modelFork292.test.ts` 的环境夹具及 README、CHANGELOG、mods-test 与本记录，共六个路径。不修改生产认证、模型请求或 Mods 行为。

## 根因与修复

1. 准确 HEAD 的 prompt.compose 无凭据单文件运行是 **3 pass / 3 fail / 20 expect**，exit 1；三项失败在 `getAnthropicApiKeyWithSource` 的凭据检查处抛错。新增测试 setup 自行分配 realpath 临时 HOME/config/XDG，使用占位 key 并移除 OAuth 与凭据文件描述符，teardown 恢复原环境。
2. fork 的错误格式化同样会读取认证和设置。原夹具只替换 API key，本批补齐同样的九项环境隔离；配置清理失败时也通过 finally 恢复原环境。
3. 初次绿色结果仍留下一个空临时 HOME，因此未直接提交。自有 preload 包装实际 fs 操作的诊断显示，`getAutoMemPath` 按 project root 缓存，之后的 prompt 渲染重新创建已删除的旧 HOME。测试 setup/teardown 清空已有 memory 路径缓存；不修改生产解析器、不禁用 memory、不增加固定 sleep。最终八场测试运行中，夹具目录残留均为零。

使用 TypeScript AST 对比准确 HEAD 与候选、工作区的全部顶层 test 注册：两文件各五个注册，其中 query 参数化注册生成六个用例；所有测试正文和断言逐字一致，无删除、skip、放宽断言或生产凭据逻辑修改。证明保存在 `test-body-proof.json`。

## 最终验证

所有命令使用 `bun test --no-env-file`，子进程环境由显式白名单建立，HOME/config/TMP/XDG 独立且没有真实凭据。各场独立运行、exit 0、无 timeout、源码哈希不变、自有进程组已退出。

| 场景 | 准确提交候选 | 用户工作区 | 额外观察 |
| --- | --- | --- | --- |
| prompt.compose 单文件 | 6 pass / 0 fail / 57 expect | 6 / 0 / 57 | 临时配置目录无残留 |
| fork 单文件 | 5 / 0 / 18 | 5 / 0 / 18 | 临时配置目录无残留 |
| 无凭据组合 | 11 / 0 / 75 | 11 / 0 / 75 | preload 验证九项环境恢复 |
| 继承占位 key、OAuth、FD 的组合 | 11 / 0 / 75 | 11 / 0 / 75 | 九项继承环境恢复；未使用真实凭据 |
| make release-check | exit 0，39.383 秒 | exit 0，40.827 秒 | CHANGELOG 格式/5 个原有测试、完整 TypeScript、lint |

组合结果重复执行同一组 11 个用例，不计算为额外业务覆盖。最终源码清单 SHA-256：候选 `8dd7f85e344a28c3c5025421ca4b656c47461def69f67a20fef8b8c20a6e3f69`；工作区 `0c4fff5a2693f0e71617d287505e9d615c9a6213586b52983b2b4ac08b169156`。工作区含其他未提交实现，不能把两个清单或结果拼接为同一制品。

## 证据与边界

证据根目录：`/private/tmp/mods-test-isolation-20261007-srrva81g`。

- `candidate-red-query/`：原始凭据失败与完整 argv/env/exit/PID/PGID。
- `candidate-green-*`、`workspace-green-*`、`*-restore-*`：首次绿色但发现空目录残留的结果，未升级为最终清理通过。
- `candidate-cleanup-trace/`、`trace-preload.ts`：受控真实 fs 委托诊断，不计作原生 CLI 证据。
- `candidate-final-*`、`workspace-final-*`、`final-tests.json`：最终八场测试、两场 release-check、九项恢复回执及零夹具残留。
- `run.py`、`run-with-restore.py`、`restore-preload.ts`：精确验证命令与有界自有进程管理。
- `before.json`、`before-source/`、`preservation-final.json`：工作区原件、并发 Claude 及两个原 binary 的保护核对。
- `commit-plan.json`、`candidate.patch`、`commit-verification.json`：仅此六路径的准确候选、暂存树与签名提交核对。

本批为测试/文档修改，未运行新的 build、tmux 或官方 binary 对照，也不借用上一批原生结果声明本批覆盖。固定官方 model.fork 2.1.292 行为基线继续使用已提交的模型父取消专项记录；本批仅保留其断言。

完整上下文差异、其他 API/UI/官方 diff、G5 以及全工作区逐文件和全量/HEAD 回归门禁继续开放；旧 response.md/fix-instructions.md 的九项失败列表不能由本批两份测试的结果替代。
