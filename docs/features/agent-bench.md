# Agent 基准测试套件（bench/）

> 英文名：`agent-bench` · 领域：上下文与记忆 · [返回功能索引](README.md)

`bench/` 是仓库里的一套独立工具：让本 fork、官方 Claude Code、Codex CLI、opencode、pi、oh-my-pi、dsh 在 Claude 账号和 ChatGPT 账号两侧跑同一批真实任务，记录每个模型请求的用量，算出缓存命中率、每任务 token、每任务 API 等价花费，并画成散点图。[缓存命中与用户体验基准](cache-benchmark.md) 里的数据就是用这套方法采集的；以后重跑、加 CLI、加任务都在这里做。

它不进 `claude` 二进制，也不改本 fork 的系统提示或运行时行为。

## 什么时候用

- 发版前确认缓存命中、token 用量没有退步。
- 新出一个 CLI 版本（或新增一个 CLI），想放到同一张图上比较。
- 想用公开基准（Terminal-Bench 2.0 等）的难题测任务完成率，又要防止模型背过答案。

## 快速开始

```bash
make build                                   # 产出 ./built-claude
bun bench/cli.ts list                        # 任务与 CLI 格
bun bench/cli.ts run --cells fork-claude-key,official-key --tasks type:coding \
  --reps 3 --raw ~/bench-raw/2026-11-08      # 每格 3 次，交错执行
bun bench/cli.ts analyze --raw ~/bench-raw/2026-11-08
bun bench/cli.ts chart --raw ~/bench-raw/2026-11-08 --out ~/bench-charts --png
```

`analyze` 的输出（节选，2026-11-07 用 `--smoke` 跑的 4 次 run，仅演示格式）：

```text
| cell | group | model / effort | runs | pass | hit | tokens/task (min–max) | $/task |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fork-claude | all | claude-sonnet-5-5 / medium | 2 (<3/task) | 100.0% | 71.6% | 40.9k (32.3–49.6k) | $0.062 |
| fork-claude-key | all | claude-sonnet-5-5 / medium | 2 (<3/task) | 100.0% | 87.0% | 48.8k (47.9–49.6k) | $0.035 |
```

`(<3/task)` 表示该格有任务不足 3 次，结论不可用。

## 组成

| 目录 / 文件 | 作用 |
| --- | --- |
| `bench/tasks/<id>/` | 任务：`task.json`（类型、长短、依赖、评分步骤）、`prompt.md`、`workspace/`（初始文件） |
| `bench/labs/ssh`、`bench/labs/k8s` | 排障任务的真实环境：sshd 容器、本机 k3s 命名空间；`*_up.sh` 建环境并埋故障，`*_check.py` 验收，`*_down.sh` 清理 |
| `bench/public/` | 公开基准：`perturb/<seed>/<suite>/<task>/` 是扰动后的变体，`perturb/mkperturb.py` 生成它们；`prelude.sh`、`gitscrub.sh` 在任务容器里运行 |
| `bench/lib/clis.ts` | 每个 CLI 格怎么启动、怎么在全新 HOME 里放登录信息、怎么关掉联网搜索 |
| `bench/lib/proxy.mjs` | 记录模型请求的本地 MITM 代理（node 运行） |
| `bench/lib/run.ts` | 跑一次：复制工作区、建 HOME、起代理、跑 CLI、评分、写原始记录、清理 |
| `bench/lib/metrics.ts` | 用量归一、命中率、cache break、花费、按格汇总 |
| `bench/lib/chart.ts` | 散点图 |
| `bench/lib/harbor.ts` | 公开基准（harbor / Terminal-Bench 2 格式）的 docker 运行器 |

### 任务

15 题，6 类，每类至少一短一长：

| 类型 | 任务 | 评分 |
| --- | --- | --- |
| 办公 office | `doc`、`doc-l` | 文件内容与可运行的示例 |
| 研究 research | `research-s`、`research-l` | 关键结论行与中位数 |
| 编码 coding | `coding-s`、`coding`、`longcode` | doctest / 单元测试 / ≥30 个测试通过 |
| 运维 ops | `ops-s`、`ops` | 修复说明、配置检查脚本、`sh -n` |
| 排障 troubleshoot | `ssh-s`、`ssh-l`、`k8s-s`、`k8s-l` | 环境验收脚本；agent 走 docker exec 等旁路进入目标机即判失败 |
| Lean | `lean-s`、`lean-l` | `lean` 编译通过、无 warning，原有陈述一字不改，禁用 `sorry` 等 |

`--tasks` 接任务 id、`type:<类型>` 或 `all`。

### CLI 格

| 格 | CLI | 账号 |
| --- | --- | --- |
| `fork-claude` / `fork-claude-key` / `fork-openai` | 本仓库 | Claude 订阅 / Claude API key / ChatGPT 订阅 |
| `official` / `official-key` | 官方 Claude Code | Claude 订阅 / Claude API key |
| `codex` | Codex CLI | ChatGPT 订阅 |
| `opencode-openai` / `opencode-claude` | opencode | ChatGPT 订阅 / Claude API key |
| `pi-openai` / `pi-claude` | pi | ChatGPT 订阅 / Claude API key |
| `omp-openai` / `omp-claude` | oh-my-pi | ChatGPT 订阅 / Claude API key |
| `dsh-openai` / `dsh-claude` | dsh | ChatGPT 订阅 / Claude API key |

模型默认 Claude 侧 `claude-sonnet-5-5`、ChatGPT 侧 `gpt-6.1-sol`（`BENCH_MODEL_CLAUDE`、`BENCH_MODEL_CHATGPT` 可改）。effort 用各 CLI 默认值，实际值从请求里读出，写进每次 run 的结果和图上。

二进制位置：`BENCH_BIN_FORK`（默认 `./built-claude`）、`BENCH_BIN_OFFICIAL`（默认 `./official-claude`，可用 `make download-claude` 获取），其余 `BENCH_BIN_CODEX`、`BENCH_BIN_OPENCODE`、`BENCH_BIN_PI`、`BENCH_BIN_OMP`、`BENCH_BIN_DSH`，默认从 PATH 找。

## 凭证

只从环境变量读，不写进仓库、报告或原始记录：

| 变量 | 用于 |
| --- | --- |
| `CLAUDE_CODE_ORG_KEY` | `*-key` 和第三方 CLI 的 Claude 侧；只注入那一次 run 的子进程环境 |
| `BENCH_CLAUDE_CREDENTIALS` | Claude 订阅登录文件路径（默认 `~/.claude/.credentials.json`） |
| `BENCH_CODEX_AUTH` | ChatGPT 登录文件路径（Codex 的 `auth.json`，默认 `~/.codex/auth.json`） |

每次 run 在临时目录建全新 HOME，按 CLI 的格式放入登录信息（权限 600），run 结束整个临时目录删除。ChatGPT 登录写入时把过期时间设为 access token 自身的过期时间，CLI 不会去刷新——刷新会轮换共享的 refresh token，让其他 run 全部失效。子进程用干净环境启动，不继承本机的其他变量。原始记录写完后再扫描一遍：含任一凭证值或形如 API key / JWT 的文件会被替换成占位说明，并记在 `meta.json` 的 `scrubbed` 里。

## 方法规则

- **每格每题至少 3 次。** `run`、`plan` 在 `--reps` 小于 3 时拒绝执行；`--smoke` 可以跑 1 次检查环境，这些 run 标记为 smoke，不进汇总。
- **交错执行。** 第 r 轮把每个（任务, 格）各跑一次；轮内任务顺序和每题的 CLI 顺序都按 `--seed` 打乱，避免某个 CLI 总是第一个（冷缓存）或最后一个。
- **全新 HOME、同 prompt、同模型。** 工作区每次从 `workspace/` 复制。
- **不联网搜索。** 本仓库与官方 `--disallowedTools WebSearch,WebFetch`；Codex `web_search="disabled"`；opencode 权限拒绝 websearch / webfetch；oh-my-pi 的工具列表去掉 web_search；dsh 关闭 tool-web；pi 没有联网工具。
- **原始记录只追加。** 同一格同一题同一轮已有记录时 `run` 跳过它，从不覆盖；中途出错的 run 移到 `_infra-failed/`，重跑不受影响。

## 指标

每个模型请求经过本地代理时记一行到 `requests.jsonl`：时间、模型、effort、请求字节数、消息数、工具数、系统提示长度、用量、首字节与首 token 时间。不记请求头和请求体。

| 指标 | 算法 |
| --- | --- |
| 命中率 | 缓存读 ÷（未缓存输入 + 缓存读 + 缓存写），按 token 加权；Anthropic 与 OpenAI 的用量先归一（OpenAI 的 `input_tokens` 已含缓存部分） |
| 每任务 token | 输入三项 + 输出；汇总给出平均、最小、最大和次数 |
| cache break | 主模型请求的缓存读少于上一请求提示的一半（上一请求提示超过 2000 token） |
| API 等价花费 | 按公开 API 价换算（见下表）；用量里分了 5 分钟 / 1 小时缓存写就按实际，否则本仓库与官方按 1 小时、其他 CLI 按 5 分钟 |
| 通过率 | 评分步骤全部通过的 run 占比 |

Codex 预热 WebSocket 的极小请求（提示不足 10 token）不计。

价格（美元 / 百万 token，2026-11-07 公开价；订阅按月计费，这里只用同一张价目表比较）：

| 模型 | 输入 | 缓存读 | 5 分钟缓存写 | 1 小时缓存写 | 输出 |
| --- | --- | --- | --- | --- | --- |
| `claude-sonnet-5-5` | 2 | 0.20 | 2.50 | 4 | 10 |
| `gpt-6.1-sol` | 2 | 0.10 | — | — | 10 |

## 图表

`chart` 从原始记录重算，输出四个 SVG（token / 花费 × 浅色 / 深色）和 `scatter-data.json`；`--png` 用 Playwright 渲染 @2x PNG。横轴对数，纵轴命中率；颜色 = CLI，形状 = 账号（实心圆 Claude 订阅、菱形 ChatGPT 订阅、空心圆 Claude API key）；虚线是 Pareto 前沿，浅色区域是「横轴不高于中位数且命中率不低于中位数」。大点是全部任务的平均，小点是各任务类型的平均；图例带上 run 时记录的 CLI 版本，图下列出每格的模型和 effort。

把 2026-11-07 的 11 题 × 12 格数据交给 `bench/lib/metrics.ts` 重算，每格命中率、每任务 token 和花费与 [缓存命中与用户体验基准](cache-benchmark.md) 的表格一致（例如本仓库 Claude 账号 87.1% / 72.7k / $0.078，Codex 88.8% / 80.3k / $0.047）。

## 排障任务的环境

- ssh：需要运行中的 dockerd 和 `sshlab:1` 镜像（`docker build -t sshlab:1 bench/labs/ssh`），本机有 `ssh` 客户端。每次 run 一个新容器，端口 = 代理端口 − 7000。
- k8s：需要本机 k3s（`/etc/rancher/k3s/k3s.yaml`，`/opt/k3s/bin/kubectl`）；每次 run 一个新命名空间，agent 拿到只限该命名空间的 kubeconfig。容器里 runc 不能调 `oom_score_adj` 时，把 `bench/labs/k8s/runc-wrapper.sh` 放到 k3s 的 PATH 最前。
- Lean：需要 Lean 4.19.0 的 `lean` 在 PATH 上（或 `BENCH_LEAN_BIN`）。

`run` 开始前检查所选任务和格需要的东西，缺什么一次列出来再退出，不会跑到一半才失败。

## 公开基准与防污染

```bash
export BENCH_TB2_ROOT=~/src/terminal-bench-2      # 上游任务源码，不进仓库
bun bench/cli.ts public --suite tb2 --task regex-log --cells oracle --reps 1 --variant seed1107 --raw ~/bench-raw/public --smoke
bun bench/cli.ts public --suite tb2 --task regex-log --cells fork-claude-key --reps 3 --variant seed1107 --raw ~/bench-raw/public
```

- 任务在自己的镜像里运行（`--network host`），本 fork 二进制复制进容器，模型请求同样经过主机上的记录代理。容器内可用的格：`fork-claude`、`fork-claude-key`、`fork-openai`、`oracle`（参考解）。
- 镜像拉取 / 构建带退避（Docker Hub 每 IP 每小时约 100 次）；镜像设了 ENTRYPOINT 时用 `--entrypoint sleep` 启动；`prelude.sh` 把系统 CA 换成代理 CA，并让 apt / apk 走 https；SWE-bench Pro 先跑 `gitscrub.sh` 删除全部 ref 和不可达对象，让 agent 无法从 git 历史里读到上游修复。
- 指令通过 stdin 传给 `claude -p`：`--disallowedTools` 是可变参数，会把后面的 prompt 吞掉。
- **防污染**：每个导入的公开题都有带种子的扰动变体——改写措辞与格式，改名称、路径、端口、输出格式，重新生成输入和答案并同步改评分脚本，难度不变；每题的改动写在 `PERTURB.md`。变体必须先让参考解（`--cells oracle`）通过才能使用。`bun bench/cli.ts perturb --seed N --out DIR` 从上游源码重新生成。
- 目前收录 Terminal-Bench 2.0 的 4 题（`regex-log`、`sqlite-db-truncate`、`cancel-async-tasks`、`custom-memory-heap-crash`，种子 `seed1107`）。`custom-memory-heap-crash` 的路径和库都烧在镜像里，只改了措辞。

## 原始记录的布局

```text
<raw>/
  plan.log                                   每次 run 命令的参数
  <cell>/<task>/rep-<n>/
    requests.jsonl                           每个模型请求一行
    out.jsonl  err.txt                       CLI 的输出
    workspace/                               结束时的工作区（不含 keys/）
    grade.json  lab-check.json               评分明细
    meta.json  result.json                   本次 run 的元数据与指标
  _infra-failed/                             环境故障的 run，不计入
  results.json  summary.json                 analyze 的输出
```

公开基准在 `<raw>/<suite>/<task>/<cell>[-<seed>]/rep-<n>/`，另有 `verifier.log`、`agent.jsonl`。

## 已知问题

- 本机的 Claude 登录由平台托管时（云端容器），凭证文件里没有 OAuth token，`fork-claude` / `official` 的请求由平台在直连 `api.anthropic.com` 时鉴权；`BENCH_DIRECT_HOSTS` 控制代理对哪些主机直连（默认 `api.anthropic.com`）。
- dsh 走 ChatGPT 时输出最终结果后进程还要挂约 5 分钟；runner 看到最终事件 3 秒后结束它，用时按最终事件计。
- 公开基准的完整任务清单仍在校准，选定后放进 `bench/public/perturb/`。
