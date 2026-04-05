# 企业私有插件市场（Private Plugin Marketplace）完整设计提案

> **文档性质：设计提案 [PROPOSAL]** — 本文为架构设计方案，非当前仓库已实现功能。  
> 文中会明确标注 **[已实现]** 表示当前代码库中已有的能力，**[提案]** 表示本方案新增的设计。  
> 版本：v2.0 | 最后更新：2025-01

---

## 目录

1. [概述与设计目标](#1-概述与设计目标)
2. [现有代码锚点总览 [已实现]](#2-现有代码锚点总览-已实现)
3. [总体架构 [提案]](#3-总体架构-提案)
4. [Git 协作模型 [提案]](#4-git-协作模型-提案)
5. [用户级可见性与 ACL 模型 [提案]](#5-用户级可见性与-acl-模型-提案)
6. [ZIP 下载机制（插件与 Skill）[提案]](#6-zip-下载机制插件与-skill提案)
7. [客户端注册与鉴权流程 [提案]](#7-客户端注册与鉴权流程-提案)
8. [发布流水线与供应链安全 [提案]](#8-发布流水线与供应链安全-提案)
9. [详细 API 设计 [提案]](#9-详细-api-设计-提案)
10. [数据库 Schema 设计 [提案]](#10-数据库-schema-设计-提案)
11. [数据模型 ER 图 [提案]](#11-数据模型-er-图-提案)
12. [部署架构 [提案]](#12-部署架构-提案)
13. [Claude Code CLI 集成示例 [提案]](#13-claude-code-cli-集成示例-提案)
14. [企业治理：审计、合规、多租户、灾备 [提案]](#14-企业治理审计合规多租户灾备-提案)
15. [具体实现计划 [提案]](#15-具体实现计划-提案)
16. [附录](#16-附录)

---

## 1. 概述与设计目标

### 1.1 背景

企业内部需要一个私有的插件市场（Private Plugin Marketplace），用于安全分发、管理和治理 Claude Code 的插件（Plugins）和技能（Skills）。不同于公开市场，企业私有市场需要：

- **Git 驱动的协作**：插件开发者通过 Git 仓库进行版本控制、分支管理、PR 审查
- **细粒度访问控制**：每个用户只能看到和使用被授权的插件
- **安全的分发链路**：签名、扫描、溯源、可回滚
- **无缝集成现有 CLI**：复用 `source:url` + `headers` 认证模式

### 1.2 核心设计原则

| 原则 | 说明 |
|------|------|
| **Settings-First** | 安装先写声明（enabledPlugins），再物化，再激活，与现有架构一致 |
| **Fail-Closed** | 未知来源 + 策略存在时一律阻断，保持现有安全语义 |
| **Git-Native** | 插件源码管理、版本控制、协作审查全部通过 Git 完成 |
| **Per-User Visibility** | ACL 驱动的市场视图，每个用户看到不同的插件列表 |
| **ZIP-First Distribution** | 插件和 Skill 均以 ZIP 包形式分发，复用现有 ZIP 缓存机制 |
| **Zero Trust** | 每次请求都带短期令牌，无长期静态凭据 |

### 1.3 约束条件

1. 私有市场可按企业/部门/环境隔离（Tenant + Environment）
2. CLI 侧必须基于企业 SSO（OIDC/OAuth2），禁止长期静态凭据
3. 插件发布链路具备签名、溯源、漏洞扫描、可回滚
4. 管理策略可中心下发并在客户端 fail-closed 执行
5. 方案最大限度复用现有插件加载与策略机制，减少侵入改造
6. 支持插件（Plugin）和技能（Skill）两种产物的分别下载

---

## 2. 现有代码锚点总览 [已实现]

本节列出当前代码库中已经实现的能力，私有市场方案将在此基础上增量扩展。

### 2.1 MarketplaceSourceSchema [已实现]

**位置**: `src/utils/plugins/schemas.ts:906-1043`

```typescript
// 四种 marketplace source 类型 [已实现]
z.object({
    source: z.literal('url'),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(), // <-- 私有市场鉴权入口
})
z.object({
    source: z.literal('github'),
    repo: z.string(),
    ref: z.string().optional(),
    path: z.string().optional(),
    sparsePaths: z.array(z.string()).optional(),
})
z.object({
    source: z.literal('git'),
    url: z.string(),
    ref: z.string().optional(),
    path: z.string().optional(),
    sparsePaths: z.array(z.string()).optional(),
})
z.object({
    source: z.literal('settings'),
    plugins: z.array(PluginSchema),
})
```

**关键点**：`source: 'url'` + `headers` 是私有市场的**主要集成入口**，可携带 Bearer Token 进行认证。

### 2.2 Plugin ZIP Cache [已实现]

**位置**: `src/utils/plugins/zipCache.ts`

| 函数 | 功能 |
|------|------|
| `isPluginZipCacheEnabled()` | 通过 `CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE` 环境变量控制 |
| `createZipFromDirectory()` | 从目录创建 ZIP，保留 Unix mode bits |
| `extractZipToDirectory()` | 从 ZIP 解压到目录，恢复执行权限位 |
| `convertDirectoryToZipInPlace()` | 原子转换目录为 ZIP |

**目录结构**: `/mnt/plugins-cache/` 下分 `marketplaces/` 和 `plugins/` 两个子目录。

### 2.3 Plugin Loader ZIP 处理 [已实现]

**位置**: `src/utils/plugins/pluginLoader.ts:2142-2164`

```typescript
// 已实现的 ZIP 解压逻辑
if (isPluginZipCacheEnabled() && pluginPath.endsWith('.zip')) {
    extractZipToDirectory(pluginPath, extractDir)
}
```

### 2.4 Policy 系统 [已实现]

**位置**: `src/utils/plugins/marketplaceHelpers.ts:480-505`

- Blocklist-first → Allowlist 语义
- `hostPattern` 和 `pathPattern` 支持灵活的 URL 匹配
- Fail-closed：未知来源 + 存在策略 → 阻断

### 2.5 Skills/Commands 架构 [已实现]

**位置**: `src/utils/plugins/loadPluginCommands.ts`

- Skills 位于 `skills/` 目录，包含 `SKILL.md` 文件
- Commands 位于 `commands/` 目录
- 两者共享同一加载管线，通过 `isSkillMode` 标志区分
- 插件 manifest 可声明额外的 skill 目录

### 2.6 Settings-First Pattern [已实现]

- Install 先写入 settings（`enabledPlugins`），再物化
- Reconciler 处理声明态与物化态的差异
- Refresh 激活运行时组件

### 2.7 完整锚点映射表

| 能力 | 代码位置 | 复用方式 |
|------|----------|----------|
| URL + Headers 鉴权 | `schemas.ts:906-915` | 私有市场直接走 `source:url` + `headers` |
| Allow/Block 策略 | `marketplaceHelpers.ts:480-505` | 企业侧策略执行器 |
| Fail-closed 语义 | `pluginLoader.ts:1922-2000` | 不可验证即拒绝 |
| 三层分离架构 | `reconciler.ts:114-234`, `refresh.ts:72-191` | Intent→Materialization→Activation |
| Managed Plugin 锁定 | `pluginPolicy.ts:12-20`, `managedPlugins.ts:9-27` | 管理员强制启停 |
| 跨市场依赖拒绝 | `dependencyResolver.ts:95-132`, `schemas.ts:1319-1324` | 最小信任原则 |
| ZIP 缓存 | `zipCache.ts` | 插件/Skill ZIP 分发 |
| Skill 加载 | `loadPluginCommands.ts` | Skills 目录与 SKILL.md |

---

## 3. 总体架构 [提案]

### 3.1 架构总览图

```mermaid
flowchart TB
    subgraph Publishers["插件发布者 (Plugin Publishers)"]
        GitRepo["Git 仓库\n(GitHub/GitLab/Gitea)"]
        DevA["开发者 A"]
        DevB["开发者 B"]
        DevC["审查者 C"]
        DevA -->|push/PR| GitRepo
        DevB -->|push/PR| GitRepo
        DevC -->|review/merge| GitRepo
    end

    subgraph CICD["CI/CD 流水线"]
        Webhook["Git Webhook"]
        Builder["Build Service"]
        Scanner["Security Scanner\n(SCA/SAST/License)"]
        Signer["Signing Service\n(KMS/HSM + Cosign)"]
        Provenance["Provenance Generator\n(SLSA/in-toto)"]
    end

    subgraph Platform["私有市场平台 (Marketplace Platform)"]
        direction TB
        API["Marketplace API Gateway"]
        AuthSvc["Auth Service\n(OIDC/OAuth2)"]
        ACLSvc["ACL Service\n(RBAC/ABAC)"]
        IndexSvc["Index Service\n(marketplace.json 生成)"]
        MetaDB[("Metadata DB\n(PostgreSQL)")]
        ArtifactStore["Artifact Storage\n(S3/MinIO)"]
        CDN["CDN / Edge Cache"]
        AuditSvc["Audit Service\n(SIEM Pipeline)"]
    end

    subgraph Enterprise["企业控制面 (Enterprise Control Plane)"]
        IdP["SSO IdP\n(Okta/Azure AD/Keycloak)"]
        PolicySvc["Policy Service\n(OPA/Cedar)"]
        SIEM["SIEM / Log Analytics"]
    end

    subgraph Clients["Claude Code CLI 客户端"]
        CLI["Plugin Loader\nReconciler / Refresh"]
        LocalCache["本地 ZIP Cache\n(/mnt/plugins-cache/)"]
        Settings["Managed Settings\n(policySettings)"]
    end

    GitRepo -->|webhook| Webhook
    Webhook --> Builder
    Builder --> Scanner
    Scanner -->|pass| Signer
    Scanner -->|fail| Builder
    Signer --> ArtifactStore
    Builder --> Provenance --> ArtifactStore
    ArtifactStore --> IndexSvc
    IndexSvc --> MetaDB
    MetaDB --> API
    ArtifactStore --> CDN

    IdP --> AuthSvc
    PolicySvc --> ACLSvc
    ACLSvc --> API
    AuthSvc --> API
    API --> AuditSvc --> SIEM

    CLI -->|"OIDC Token\n(Authorization: Bearer xxx)"| API
    API -->|"marketplace.json\n(filtered by ACL)"| CLI
    CDN -->|"plugin.zip / skill.zip"| CLI
    CLI --> LocalCache
    Settings --> CLI
```

### 3.2 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 源码管理 | Git (多平台支持) | 企业可能使用 GitHub、GitLab、Gitea 等不同 Git 平台 |
| 认证协议 | OIDC + OAuth2 | 与企业 SSO 无缝集成，支持 Device Code Flow |
| 授权引擎 | RBAC + ABAC (OPA/Cedar) | 支持角色层级和属性基策略 |
| 分发格式 | ZIP (plugin bundle / skill bundle) | 复用现有 `zipCache.ts` 全部能力 |
| 索引格式 | marketplace.json (per-user filtered) | 与现有 `source:url` 完全兼容 |
| 签名方案 | Cosign + Sigstore | 业界标准，支持 keyless signing |
| 元数据存储 | PostgreSQL | 关系型，支持行级安全 (RLS) |
| 产物存储 | S3/MinIO | 对象存储，支持版本和生命周期 |

---

## 4. Git 协作模型 [提案]

### 4.1 Git 仓库结构标准

每个插件项目必须遵循以下目录结构：

```
my-enterprise-plugin/
├── plugin.json              # 插件 manifest（名称、版本、权限声明等）
├── README.md                # 插件文档
├── CHANGELOG.md             # 变更日志
├── skills/                  # Skill 定义目录
│   ├── my-skill/
│   │   ├── SKILL.md         # Skill 描述文件
│   │   └── handler.ts       # Skill 处理逻辑
│   └── another-skill/
│       └── SKILL.md
├── commands/                # Command 定义目录
│   ├── my-command/
│   │   └── command.ts
│   └── ...
├── hooks/                   # 生命周期钩子
│   ├── preToolExecution.ts
│   └── ...
├── tests/                   # 测试
│   └── ...
├── .marketplace/            # 市场发布配置
│   ├── publish.yaml         # 发布配置（渠道、可见性、审批规则）
│   └── signing-policy.yaml  # 签名策略
└── .github/                 # CI/CD 配置
    └── workflows/
        └── publish.yaml     # 自动发布工作流
```

### 4.2 plugin.json Manifest 规范

```json
{
  "name": "enterprise-code-reviewer",
  "version": "2.1.0",
  "displayName": "企业代码审查器",
  "description": "自动化代码审查，集成企业代码规范",
  "publisher": "platform-team",
  "license": "PROPRIETARY",
  "engines": {
    "claude-code": ">=2.0.0"
  },
  "categories": ["code-quality", "review"],
  "skills": ["skills/review-skill", "skills/lint-skill"],
  "commands": ["commands/review-cmd"],
  "hooks": {
    "PreToolExecution": "hooks/preToolExecution.ts"
  },
  "permissions": {
    "tools": ["Read", "Write", "Bash"],
    "network": ["https://internal-api.corp.com"]
  },
  "marketplace": {
    "visibility": "restricted",
    "allowedGroups": ["engineering", "qa"],
    "minApprovals": 2,
    "channels": ["stable", "beta"]
  }
}
```

### 4.3 Git 协作工作流

```mermaid
sequenceDiagram
    participant DevA as 开发者 A
    participant DevB as 开发者 B
    participant Git as Git 仓库 (main/develop)
    participant PR as Pull Request
    participant Review as 审查流程
    participant CI as CI Pipeline
    participant Mkt as Marketplace API
    participant Audit as 审计服务

    Note over DevA,Git: === 功能开发阶段 ===
    DevA->>Git: git checkout -b feature/new-skill
    DevA->>Git: git push origin feature/new-skill
    DevA->>PR: 创建 PR: feature/new-skill → develop

    Note over PR,Review: === 协作审查阶段 ===
    DevB->>PR: Code Review + 建议
    DevA->>PR: 根据反馈修改并推送
    Review->>PR: 自动化检查（lint/test/security）
    Review->>PR: 人工审批 (≥2 approvals)
    PR->>Git: Merge to develop

    Note over Git,CI: === 预发布阶段 ===
    Git->>CI: develop 分支触发 beta 构建
    CI->>CI: 构建 + 测试 + 安全扫描
    CI->>Mkt: 发布到 beta 渠道
    Mkt->>Audit: 记录 beta 发布事件

    Note over Git,Mkt: === 正式发布阶段 ===
    DevA->>Git: 创建 Release PR: develop → main
    Review->>Git: 审批 + Merge to main
    DevA->>Git: git tag v2.1.0
    Git->>CI: tag 触发 stable 构建
    CI->>CI: 完整安全扫描 + 签名
    CI->>Mkt: 发布到 stable 渠道
    Mkt->>Audit: 记录 stable 发布事件
```

### 4.4 分支策略

| 分支 | 用途 | 触发动作 |
|------|------|----------|
| `main` | 生产稳定版 | tag push → 发布到 stable 渠道 |
| `develop` | 集成分支 | merge → 发布到 beta 渠道 |
| `feature/*` | 功能开发 | PR → develop |
| `hotfix/*` | 紧急修复 | PR → main + develop |
| `release/*` | 发布候选 | 冻结测试 → 合并到 main |

### 4.5 版本控制规则

1. **语义化版本 (SemVer)**：所有插件版本必须遵循 `MAJOR.MINOR.PATCH` 格式
2. **自动版本递增**：CI 流水线根据 Conventional Commits 自动计算下一版本
3. **版本锁定**：生产环境可以锁定特定版本，不自动升级
4. **版本约束**：`plugin.json` 中的 `engines.claude-code` 字段约束兼容的 CLI 版本

### 4.6 Git 平台集成

市场平台通过 Webhook 监听 Git 事件：

```yaml
# .marketplace/publish.yaml
git:
  provider: github  # github | gitlab | gitea | bitbucket
  webhook:
    events:
      - push
      - tag
      - pull_request
    secret: "${WEBHOOK_SECRET}"  # 通过密钥管理系统注入

publish:
  channels:
    stable:
      trigger: tag
      pattern: "v*"
      requireSignedCommits: true
      requireApprovals: 2
    beta:
      trigger: branch
      branch: develop
      requireApprovals: 1
    nightly:
      trigger: cron
      schedule: "0 2 * * *"
      branch: develop

  prebuild:
    - npm ci
    - npm run build
    - npm test

  postpublish:
    notify:
      - slack: "#plugin-releases"
      - email: "plugin-team@corp.com"
```

### 4.7 Marketplace 如何从 Git 摄取

1. **Webhook 接收器**：市场平台暴露 `/api/v1/webhooks/git` 端点
2. **事件验证**：验证 webhook secret，确保事件来自可信 Git 平台
3. **源码拉取**：使用 `git clone --depth=1` 或 `git archive` 获取源码
4. **构建触发**：根据 `.marketplace/publish.yaml` 配置触发构建流水线
5. **产物上传**：构建产物（ZIP）上传到 Artifact Storage
6. **索引更新**：更新 MetaDB 中的版本元数据，触发 marketplace.json 重新生成

---

## 5. 用户级可见性与 ACL 模型 [提案]

### 5.1 权限模型概览

```mermaid
flowchart TB
    subgraph RoleHierarchy["角色层级 (Role Hierarchy)"]
        SA["Super Admin\n(全局管理员)"]
        MA["Marketplace Admin\n(市场管理员)"]
        SR["Security Reviewer\n(安全审查员)"]
        PUB["Publisher\n(插件发布者)"]
        CON["Consumer\n(插件消费者)"]
        VW["Viewer\n(只读观察者)"]

        SA --> MA
        SA --> SR
        MA --> PUB
        MA --> SR
        PUB --> CON
        SR --> CON
        CON --> VW
    end

    subgraph ACLLayers["ACL 层级"]
        TenantACL["租户级 ACL\n(Tenant-Level)"]
        MktACL["市场级 ACL\n(Marketplace-Level)"]
        PluginACL["插件级 ACL\n(Plugin-Level)"]
        VersionACL["版本级 ACL\n(Version/Channel-Level)"]

        TenantACL --> MktACL
        MktACL --> PluginACL
        PluginACL --> VersionACL
    end

    subgraph Groups["用户组 (Groups)"]
        OrgAll["@org/all"]
        OrgEng["@org/engineering"]
        OrgQA["@org/qa"]
        OrgSec["@org/security"]
        TeamFE["@team/frontend"]
        TeamBE["@team/backend"]
        TeamML["@team/ml"]
    end

    SA -.-> TenantACL
    MA -.-> MktACL
    PUB -.-> PluginACL
    Groups -.-> PluginACL
    Groups -.-> VersionACL
```

### 5.2 角色定义

| 角色 | 权限 | 说明 |
|------|------|------|
| **Super Admin** | `*` | 全局管理，包括租户管理、系统配置 |
| **Marketplace Admin** | `marketplace:*`, `plugin:*`, `user:read` | 管理市场、发布审批、用户查看 |
| **Security Reviewer** | `plugin:review`, `plugin:approve`, `plugin:reject`, `scan:read` | 安全审查、漏洞审批 |
| **Publisher** | `plugin:create`, `plugin:update`, `plugin:publish`, `version:create` | 创建和发布插件 |
| **Consumer** | `plugin:read`, `plugin:install`, `plugin:download` | 浏览、安装和下载插件 |
| **Viewer** | `plugin:read` | 只能浏览，不能安装/下载 |

### 5.3 ABAC 属性列表

| 属性 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `user.tenant` | string | 用户所属租户 | `acme-corp` |
| `user.department` | string | 用户部门 | `engineering` |
| `user.groups` | string[] | 用户组列表 | `["@org/eng", "@team/fe"]` |
| `user.clearance` | enum | 安全等级 | `public \| internal \| confidential \| secret` |
| `plugin.visibility` | enum | 插件可见性 | `public \| restricted \| private` |
| `plugin.riskLevel` | enum | 风险等级 | `low \| medium \| high \| critical` |
| `plugin.categories` | string[] | 插件分类 | `["security", "tooling"]` |
| `env.environment` | enum | 部署环境 | `dev \| staging \| prod` |
| `env.region` | string | 地域 | `us-east-1 \| cn-north-1` |

### 5.4 Per-User Marketplace View 流程

当用户请求 `marketplace.json` 时，API 会根据用户身份动态过滤返回内容：

```
用户请求 marketplace.json
        │
        ▼
┌──────────────────┐
│  1. Token 验证    │ → 从 Authorization header 提取并验证 JWT
│  2. 身份解析      │ → 解析 user_id, tenant, groups, roles, attributes
│  3. ACL 查询      │ → 查询 user 在当前 marketplace 的权限
│  4. ABAC 评估     │ → 基于属性策略过滤可见插件
│  5. 结果组装      │ → 只返回用户有权看到的插件列表
└──────────────────┘
        │
        ▼
  个性化 marketplace.json
```

### 5.5 ACL 规则示例

```yaml
# 示例：ACL 规则配置
acl_rules:
  # 所有人可见的基础插件
  - plugin: "core-formatter"
    visibility: public
    allowed: ["@org/all"]

  # 仅工程部门可见
  - plugin: "enterprise-code-reviewer"
    visibility: restricted
    allowed:
      groups: ["@org/engineering", "@org/qa"]
      users: ["alice@corp.com"]  # 额外授权个人

  # 仅安全团队可见
  - plugin: "security-scanner-plugin"
    visibility: restricted
    allowed:
      groups: ["@org/security"]
      roles: ["Security Reviewer"]

  # 私有插件 - 仅创建者和明确授权者
  - plugin: "experimental-ml-tool"
    visibility: private
    allowed:
      users: ["bob@corp.com", "charlie@corp.com"]
      groups: ["@team/ml"]

  # 基于环境的渠道控制
  - plugin: "database-migrator"
    visibility: restricted
    channel_acl:
      stable:
        allowed: ["@org/all"]
      beta:
        allowed: ["@org/engineering"]
      nightly:
        allowed: ["@team/backend"]
```

### 5.6 权限继承规则

1. **租户级**：用户必须属于租户才能访问该租户下的任何市场
2. **市场级**：用户必须有市场的 `read` 权限才能浏览该市场
3. **插件级**：插件的 `visibility` 决定默认可见范围
   - `public`：租户内所有用户可见
   - `restricted`：仅 `allowed` 列表中的组/用户可见
   - `private`：仅 owner 和明确授权者可见
4. **版本级**：不同渠道（stable/beta/nightly）可有独立 ACL
5. **继承方向**：上级拒绝 → 下级一律拒绝（deny 优先）

### 5.7 组与继承

```
@org/all (组织全员)
├── @org/engineering (工程部)
│   ├── @team/frontend (前端团队)
│   ├── @team/backend (后端团队)
│   └── @team/ml (ML 团队)
├── @org/qa (QA部)
├── @org/security (安全部)
└── @org/management (管理层)
```

组支持嵌套，权限沿树向下继承：授予 `@org/engineering` 的权限自动适用于 `@team/frontend`、`@team/backend`、`@team/ml`。

---

## 6. ZIP 下载机制（插件与 Skill）[提案]

### 6.1 ZIP 包类型

本方案支持两种 ZIP 包下载：

| 类型 | 内容 | 用途 | 文件名模式 |
|------|------|------|------------|
| **Plugin Bundle ZIP** | 完整插件包（manifest + skills + commands + hooks） | 安装完整插件 | `{pluginId}-{version}.plugin.zip` |
| **Skill ZIP** | 单个 Skill 目录（SKILL.md + handler） | 单独提取某个 Skill | `{pluginId}-{skillName}-{version}.skill.zip` |

### 6.2 Plugin Bundle ZIP 结构

```
enterprise-code-reviewer-2.1.0.plugin.zip
├── plugin.json
├── README.md
├── skills/
│   ├── review-skill/
│   │   ├── SKILL.md
│   │   └── handler.ts
│   └── lint-skill/
│       ├── SKILL.md
│       └── handler.ts
├── commands/
│   └── review-cmd/
│       └── command.ts
├── hooks/
│   └── preToolExecution.ts
└── .signature/
    ├── bundle.sig          # Cosign 签名
    ├── bundle.cert         # 签名证书
    └── provenance.json     # SLSA 溯源信息
```

### 6.3 Skill ZIP 结构

```
enterprise-code-reviewer-review-skill-2.1.0.skill.zip
├── SKILL.md
├── handler.ts
└── .signature/
    ├── skill.sig
    └── skill.cert
```

### 6.4 ZIP 下载流程

```mermaid
sequenceDiagram
    participant CLI as Claude Code CLI
    participant API as Marketplace API
    participant ACL as ACL Service
    participant CDN as CDN / Artifact Store
    participant Cache as Local ZIP Cache

    Note over CLI: 用户请求下载插件或 Skill

    alt 下载完整插件 (Plugin Bundle)
        CLI->>API: GET /v1/plugins/{id}/{ver}/download?type=plugin
        API->>ACL: 验证用户权限 (plugin:download)
        ACL-->>API: authorized
        API-->>CLI: 302 Redirect → CDN URL (signed, 5min TTL)
        CLI->>CDN: GET signed-url/enterprise-code-reviewer-2.1.0.plugin.zip
        CDN-->>CLI: plugin.zip (with Content-Disposition)
    else 下载单个 Skill
        CLI->>API: GET /v1/plugins/{id}/{ver}/skills/{skillName}/download
        API->>ACL: 验证用户权限 (plugin:download)
        ACL-->>API: authorized
        API-->>CLI: 302 Redirect → CDN URL (signed, 5min TTL)
        CLI->>CDN: GET signed-url/...-review-skill-2.1.0.skill.zip
        CDN-->>CLI: skill.zip
    end

    Note over CLI,Cache: ZIP 本地处理流程

    CLI->>CLI: 验证签名 (cosign verify)
    CLI->>CLI: 验证 SHA256 digest
    CLI->>Cache: 存储到 /mnt/plugins-cache/plugins/{id}/{ver}/
    CLI->>CLI: extractZipToDirectory() [已实现]
    CLI->>CLI: 加载插件/Skill 并激活
```

### 6.5 与现有 ZIP Cache 的集成

本方案直接复用 `zipCache.ts` [已实现] 的全部能力：

```typescript
// [提案] 扩展现有 ZIP 缓存路径约定
const CACHE_PATHS = {
    // 已有
    marketplaces: '/mnt/plugins-cache/marketplaces/',
    plugins:      '/mnt/plugins-cache/plugins/',
    // 新增 [提案]
    skills:       '/mnt/plugins-cache/skills/',        // 独立 Skill ZIP 缓存
    signatures:   '/mnt/plugins-cache/signatures/',    // 签名和溯源缓存
};

// [提案] 下载并缓存 Plugin ZIP
async function downloadAndCachePlugin(
    pluginId: string,
    version: string,
    downloadUrl: string,
    expectedDigest: string
): Promise<string> {
    const cachePath = path.join(CACHE_PATHS.plugins, pluginId, version);
    const zipPath = path.join(cachePath, `${pluginId}-${version}.plugin.zip`);

    // 检查缓存命中
    if (await fileExists(zipPath)) {
        const digest = await computeSHA256(zipPath);
        if (digest === expectedDigest) return zipPath;
    }

    // 下载 ZIP
    await downloadFile(downloadUrl, zipPath);

    // 验证完整性
    const digest = await computeSHA256(zipPath);
    if (digest !== expectedDigest) {
        throw new SecurityError('Digest mismatch - possible tampering');
    }

    // 验证签名 [提案]
    await verifySignature(zipPath, pluginId, version);

    return zipPath;
}

// [提案] 下载并缓存单个 Skill ZIP
async function downloadAndCacheSkill(
    pluginId: string,
    skillName: string,
    version: string,
    downloadUrl: string,
    expectedDigest: string
): Promise<string> {
    const cachePath = path.join(CACHE_PATHS.skills, pluginId, skillName, version);
    const zipPath = path.join(cachePath, `${pluginId}-${skillName}-${version}.skill.zip`);

    if (await fileExists(zipPath)) {
        const digest = await computeSHA256(zipPath);
        if (digest === expectedDigest) return zipPath;
    }

    await downloadFile(downloadUrl, zipPath);

    const digest = await computeSHA256(zipPath);
    if (digest !== expectedDigest) {
        throw new SecurityError('Digest mismatch');
    }

    await verifySignature(zipPath, pluginId, version);

    // 解压到对应目录 - 复用 [已实现] 的 extractZipToDirectory
    const extractDir = path.join(cachePath, 'extracted');
    extractZipToDirectory(zipPath, extractDir);

    return extractDir;
}
```

### 6.6 CLI 命令扩展 [提案]

```bash
# 下载完整插件 ZIP
claude plugin download enterprise-code-reviewer@2.1.0

# 下载单个 Skill ZIP
claude plugin download enterprise-code-reviewer@2.1.0 --skill review-skill

# 下载到指定目录
claude plugin download enterprise-code-reviewer@2.1.0 --output ./plugins/

# 列出插件包含的 Skills（供选择性下载）
claude plugin skills enterprise-code-reviewer@2.1.0
# Output:
#   review-skill   - 自动化代码审查 Skill
#   lint-skill     - 代码规范检查 Skill
```

---

## 7. 客户端注册与鉴权流程 [提案]

### 7.1 在 Claude Code 中注册私有市场

使用现有的 `source: 'url'` + `headers` 模式 [已实现] 注册私有市场：

```jsonc
// ~/.claude/settings.json
{
  "marketplaces": [
    {
      "source": "url",
      "url": "https://marketplace.corp.com/v1/marketplaces/acme/stable/marketplace.json",
      "headers": {
        "Authorization": "Bearer ${CORP_MARKETPLACE_TOKEN}",
        "X-Tenant-ID": "acme-corp",
        "X-Client-Version": "2.1.88"
      }
    }
  ]
}
```

### 7.2 多种 Token 获取方式

#### 方式一：手动 Token（快速开始）

```bash
# 1. 通过企业 SSO 获取 Token
export CORP_MARKETPLACE_TOKEN=$(curl -s https://auth.corp.com/oauth2/token \
  -d grant_type=client_credentials \
  -d client_id=$CLIENT_ID \
  -d client_secret=$CLIENT_SECRET | jq -r '.access_token')

# 2. 配置 Claude Code
cat > ~/.claude/settings.json << EOF
{
  "marketplaces": [
    {
      "source": "url",
      "url": "https://marketplace.corp.com/v1/marketplaces/acme/stable/marketplace.json",
      "headers": {
        "Authorization": "Bearer ${CORP_MARKETPLACE_TOKEN}"
      }
    }
  ]
}
EOF
```

#### 方式二：企业 Managed Settings（推荐）

```jsonc
// 由 IT 管理员通过 MDM/GPO 分发到 /etc/claude/managed-settings.json
{
  "policySettings": {
    "strictKnownMarketplaces": true,
    "blockedMarketplaces": [],
    "allowedMarketplaces": [
      {
        "hostPattern": "marketplace.corp.com",
        "pathPattern": "/v1/marketplaces/**"
      }
    ]
  },
  "marketplaces": [
    {
      "source": "url",
      "url": "https://marketplace.corp.com/v1/marketplaces/acme/stable/marketplace.json",
      "headers": {
        "Authorization": "Bearer ${AUTO_REFRESHED_TOKEN}"
      }
    }
  ]
}
```

#### 方式三：OIDC Device Flow（最安全）[提案]

```bash
# [提案] 新增的 CLI 子命令
claude marketplace login --provider corp-sso

# 交互流程：
# 1. CLI 启动 Device Code Flow
# 2. 显示：请在浏览器中打开 https://auth.corp.com/device 并输入代码: ABCD-EFGH
# 3. 用户在浏览器中完成 SSO 认证
# 4. CLI 获取 Access Token + Refresh Token
# 5. Token 安全存储在系统 keychain 中
# 6. 后续请求自动附加 Authorization header

claude marketplace list    # 浏览可用插件
claude marketplace install enterprise-code-reviewer@2.1.0
```

### 7.3 完整鉴权时序图

```mermaid
sequenceDiagram
    participant User as 用户
    participant CLI as Claude Code CLI
    participant Keychain as 系统 Keychain
    participant IdP as 企业 IdP (Okta/Azure AD)
    participant AuthGW as Auth Gateway
    participant MktAPI as Marketplace API
    participant ACL as ACL Service
    participant Policy as Managed Policy

    Note over User,CLI: === 首次登录 ===
    User->>CLI: claude marketplace login --provider corp-sso
    CLI->>IdP: POST /oauth2/device/authorize
    IdP-->>CLI: device_code + user_code + verification_uri
    CLI->>User: 请打开 https://auth.corp.com/device 输入代码 ABCD-EFGH
    User->>IdP: 浏览器中完成 SSO 认证
    CLI->>IdP: POST /oauth2/token (polling device_code)
    IdP-->>CLI: access_token (15min) + refresh_token (7d) + id_token
    CLI->>Keychain: 安全存储 refresh_token
    CLI->>CLI: 缓存 access_token (内存)

    Note over CLI,MktAPI: === 浏览市场 ===
    User->>CLI: claude marketplace list
    CLI->>Policy: 读取 policySettings [已实现]
    Policy-->>CLI: allowedMarketplaces, blockedMarketplaces

    alt Token 未过期
        CLI->>CLI: 使用缓存的 access_token
    else Token 已过期
        CLI->>Keychain: 读取 refresh_token
        CLI->>AuthGW: POST /oauth2/token (refresh_token)
        AuthGW->>IdP: 验证 refresh_token
        IdP-->>AuthGW: new access_token
        AuthGW-->>CLI: new access_token
    end

    CLI->>MktAPI: GET /v1/marketplaces/acme/stable/marketplace.json
    Note right of CLI: Authorization: Bearer {access_token}
    MktAPI->>ACL: 验证身份 + 查询权限
    ACL-->>MktAPI: user_permissions + visible_plugins
    MktAPI-->>CLI: marketplace.json (filtered by user ACL)

    Note over CLI,MktAPI: === 安装插件 ===
    User->>CLI: claude marketplace install code-reviewer@2.1.0
    CLI->>MktAPI: GET /v1/plugins/code-reviewer/2.1.0/download?type=plugin
    MktAPI->>ACL: 验证 plugin:download 权限
    ACL-->>MktAPI: authorized
    MktAPI-->>CLI: 302 → signed CDN URL
    CLI->>CLI: 下载 ZIP + 验证签名 + 验证 digest
    CLI->>CLI: settings-first 写入 enabledPlugins [已实现]
    CLI->>CLI: reconcile + refresh [已实现]
    CLI->>User: 插件安装成功 ✓
```

### 7.4 Token 生命周期管理

| 令牌类型 | 存储位置 | 生命周期 | 刷新策略 |
|----------|----------|----------|----------|
| Access Token | 内存（进程级） | 15-30 分钟 | Refresh Token 自动刷新 |
| Refresh Token | 系统 Keychain | 7 天 | 过期后需重新 Device Flow |
| ID Token | 不存储 | 验证后丢弃 | N/A |
| CDN Signed URL | 不存储 | 5 分钟 | 每次下载重新获取 |

---

## 8. 发布流水线与供应链安全 [提案]

### 8.1 发布流水线架构

```mermaid
flowchart LR
    subgraph GitPhase["Git 阶段"]
        Commit["Signed Commit"]
        Tag["Signed Tag\n(v2.1.0)"]
        Webhook["Git Webhook"]
    end

    subgraph BuildPhase["构建阶段"]
        Clone["Git Clone\n(verified source)"]
        Deps["Dependency Resolution\n(lockfile verified)"]
        Build["Build & Bundle"]
        Test["Unit + Integration Tests"]
    end

    subgraph SecurityPhase["安全阶段"]
        SCA["SCA 扫描\n(依赖漏洞)"]
        SAST["SAST 扫描\n(代码缺陷)"]
        License["License 合规检查"]
        SecReview["人工安全审查\n(high-risk only)"]
    end

    subgraph SignPhase["签名阶段"]
        SBOM["SBOM 生成\n(CycloneDX/SPDX)"]
        Digest["SHA256 Digest"]
        CosignSign["Cosign 签名\n(KMS/HSM)"]
        Provenance["SLSA Provenance\n(in-toto attestation)"]
    end

    subgraph PublishPhase["发布阶段"]
        Upload["上传 Artifact\n(S3/MinIO)"]
        Quarantine["Quarantine 隔离区"]
        Canary["Canary 验证"]
        Approve["审批发布"]
        IndexUpdate["更新 marketplace.json"]
    end

    Commit --> Tag --> Webhook
    Webhook --> Clone --> Deps --> Build --> Test
    Test --> SCA --> SAST --> License
    License -->|high-risk| SecReview
    License -->|low/medium| SBOM
    SecReview --> SBOM
    SBOM --> Digest --> CosignSign --> Provenance
    Provenance --> Upload --> Quarantine --> Canary --> Approve --> IndexUpdate
```

### 8.2 签名验证链

```
1. 验证 Git Commit 签名 (GPG/SSH)
   ↓
2. 验证 Git Tag 签名
   ↓
3. CI 环境身份验证 (OIDC Workload Identity)
   ↓
4. 构建产物 SHA256 Digest 记录
   ↓
5. Cosign 签名 (keyless via Fulcio + Rekor)
   ↓
6. SLSA Provenance 生成 (in-toto attestation)
   ↓
7. SBOM 生成并签名 (CycloneDX)
   ↓
8. 所有签名材料与产物一起上传到 Artifact Store
```

### 8.3 安全扫描策略

| 扫描类型 | 工具建议 | 阈值 | 阻断行为 |
|----------|----------|------|----------|
| 依赖漏洞 (SCA) | Snyk / Trivy | Critical/High = 0 | 阻断发布 |
| 静态代码分析 (SAST) | Semgrep / CodeQL | High = 0 | 阻断发布 |
| License 合规 | FOSSA / license-checker | 禁止 AGPL/GPL | 阻断发布 |
| 恶意代码检测 | Custom Rules | Any match | 阻断 + 告警 |
| Secret 泄露 | TruffleHog / Gitleaks | Any match | 阻断 + 告警 |

### 8.4 回滚机制

```bash
# 管理员触发回滚
POST /v1/admin/rollback
{
    "pluginId": "enterprise-code-reviewer",
    "fromVersion": "2.1.0",
    "toVersion": "2.0.5",
    "reason": "Critical security vulnerability in v2.1.0",
    "scope": "all-tenants"  # or specific tenant
}

# 回滚操作：
# 1. 将 v2.1.0 标记为 status=revoked
# 2. 更新所有受影响的 marketplace.json，指向 v2.0.5
# 3. 通知所有已安装 v2.1.0 的客户端
# 4. 审计日志记录回滚事件
# 5. 可选：强制客户端降级（通过 managed settings push）
```

### 8.5 GitHub Actions 发布工作流示例

```yaml
# .github/workflows/publish.yaml
name: Publish to Enterprise Marketplace

on:
  push:
    tags: ['v*']

permissions:
  id-token: write    # OIDC token for keyless signing
  contents: read

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install & Build
        run: |
          npm ci
          npm run build
          npm test

      - name: Security Scan (SCA)
        uses: snyk/actions/node@master
        with:
          args: --severity-threshold=high

      - name: Security Scan (SAST)
        uses: returntocorp/semgrep-action@v1
        with:
          config: p/security-audit

      - name: License Check
        run: npx license-checker --production --failOn "AGPL-1.0;GPL-2.0;GPL-3.0"

      - name: Generate SBOM
        run: npx @cyclonedx/cyclonedx-npm --output sbom.json

      - name: Create Plugin ZIP
        run: |
          mkdir -p dist
          zip -r dist/plugin.zip \
            plugin.json README.md \
            skills/ commands/ hooks/ \
            -x "*.test.*" "node_modules/*" ".git/*"

      - name: Compute Digest
        run: sha256sum dist/plugin.zip > dist/plugin.zip.sha256

      - name: Sign with Cosign (Keyless)
        uses: sigstore/cosign-installer@v3
        run: |
          cosign sign-blob \
            --yes \
            --bundle dist/plugin.zip.bundle \
            dist/plugin.zip

      - name: Generate SLSA Provenance
        uses: slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@v1.9.0
        with:
          base64-subjects: |
            $(sha256sum dist/plugin.zip | base64 -w0)

      - name: Publish to Marketplace
        env:
          MARKETPLACE_URL: https://marketplace.corp.com
        run: |
          # 获取 OIDC token
          TOKEN=$(curl -s -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
            "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=marketplace.corp.com" | jq -r '.value')

          # 上传插件
          curl -X POST "${MARKETPLACE_URL}/v1/publish" \
            -H "Authorization: Bearer ${TOKEN}" \
            -F "bundle=@dist/plugin.zip" \
            -F "signature=@dist/plugin.zip.bundle" \
            -F "sbom=@sbom.json" \
            -F "digest=@dist/plugin.zip.sha256" \
            -F "version=${GITHUB_REF_NAME#v}" \
            -F "channel=stable"
```

---

## 9. 详细 API 设计 [提案]

### 9.1 API 总览

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| GET | `/v1/marketplaces/{tenant}/{channel}/marketplace.json` | 获取市场索引（per-user filtered） | Consumer |
| GET | `/v1/plugins` | 搜索/列出插件 | Consumer |
| GET | `/v1/plugins/{id}` | 获取插件详情 | Consumer |
| GET | `/v1/plugins/{id}/{version}` | 获取特定版本详情 | Consumer |
| GET | `/v1/plugins/{id}/{version}/download` | 下载插件 ZIP | Consumer |
| GET | `/v1/plugins/{id}/{version}/skills/{skill}/download` | 下载 Skill ZIP | Consumer |
| GET | `/v1/plugins/{id}/{version}/signature` | 获取签名信息 | Consumer |
| GET | `/v1/plugins/{id}/{version}/sbom` | 获取 SBOM | Consumer |
| POST | `/v1/publish` | 发布新版本 | Publisher |
| POST | `/v1/publish/validate` | 预验证发布包 | Publisher |
| PUT | `/v1/plugins/{id}/visibility` | 修改插件可见性 | Publisher/Admin |
| POST | `/v1/plugins/{id}/{version}/approve` | 审批版本 | Security Reviewer |
| POST | `/v1/plugins/{id}/{version}/reject` | 拒绝版本 | Security Reviewer |
| POST | `/v1/plugins/{id}/{version}/revoke` | 撤销版本 | Admin |
| POST | `/v1/admin/rollback` | 回滚到指定版本 | Admin |
| GET | `/v1/admin/audit/events` | 查询审计日志 | Admin/Auditor |
| POST | `/v1/webhooks/git` | Git webhook 接收器 | System |
| GET | `/v1/health` | 健康检查 | Public |

### 9.2 核心 API 详细设计

#### 9.2.1 获取市场索引

```http
GET /v1/marketplaces/{tenant}/{channel}/marketplace.json
Authorization: Bearer <access_token>
X-Client-Version: 2.1.88
Accept: application/json
```

**响应 200:**
```json
{
  "name": "ACME Corp Plugin Marketplace",
  "version": "2025.01.15.001",
  "tenant": "acme-corp",
  "channel": "stable",
  "updatedAt": "2025-01-15T10:30:00Z",
  "plugins": [
    {
      "id": "enterprise-code-reviewer",
      "displayName": "企业代码审查器",
      "version": "2.1.0",
      "publisher": "platform-team",
      "description": "自动化代码审查，集成企业代码规范",
      "categories": ["code-quality", "review"],
      "riskLevel": "medium",
      "digest": "sha256:abc123...",
      "downloadUrl": "/v1/plugins/enterprise-code-reviewer/2.1.0/download",
      "skills": [
        {
          "name": "review-skill",
          "description": "代码审查 Skill",
          "downloadUrl": "/v1/plugins/enterprise-code-reviewer/2.1.0/skills/review-skill/download"
        },
        {
          "name": "lint-skill",
          "description": "代码规范检查 Skill",
          "downloadUrl": "/v1/plugins/enterprise-code-reviewer/2.1.0/skills/lint-skill/download"
        }
      ],
      "signature": {
        "algorithm": "cosign",
        "signatureUrl": "/v1/plugins/enterprise-code-reviewer/2.1.0/signature",
        "sbomUrl": "/v1/plugins/enterprise-code-reviewer/2.1.0/sbom"
      },
      "permissions": {
        "tools": ["Read", "Write", "Bash"],
        "network": ["https://internal-api.corp.com"]
      },
      "engines": {
        "claude-code": ">=2.0.0"
      },
      "publishedAt": "2025-01-15T10:00:00Z"
    }
  ],
  "allowCrossMarketplaceDependenciesOn": [],
  "policies": {
    "requireSignatureVerification": true,
    "minimumRiskLevel": "low",
    "autoUpdate": false
  }
}
```

#### 9.2.2 搜索/列出插件

```http
GET /v1/plugins?q=code+reviewer&category=code-quality&channel=stable&page=1&limit=20
Authorization: Bearer <access_token>
```

**响应 200:**
```json
{
  "total": 42,
  "page": 1,
  "limit": 20,
  "items": [
    {
      "id": "enterprise-code-reviewer",
      "displayName": "企业代码审查器",
      "latestVersion": "2.1.0",
      "publisher": "platform-team",
      "description": "自动化代码审查",
      "categories": ["code-quality", "review"],
      "riskLevel": "medium",
      "downloads": 1523,
      "rating": 4.8,
      "updatedAt": "2025-01-15T10:00:00Z"
    }
  ]
}
```

#### 9.2.3 下载插件 ZIP

```http
GET /v1/plugins/{id}/{version}/download?type=plugin
Authorization: Bearer <access_token>
```

**响应 302 (Redirect to signed CDN URL):**
```http
HTTP/1.1 302 Found
Location: https://cdn.corp.com/artifacts/enterprise-code-reviewer-2.1.0.plugin.zip?sig=xxx&exp=1705312200
X-Content-Digest: sha256:abc123...
X-Signature-Url: /v1/plugins/enterprise-code-reviewer/2.1.0/signature
```

#### 9.2.4 下载 Skill ZIP

```http
GET /v1/plugins/{id}/{version}/skills/{skillName}/download
Authorization: Bearer <access_token>
```

**响应 302:**
```http
HTTP/1.1 302 Found
Location: https://cdn.corp.com/artifacts/enterprise-code-reviewer-review-skill-2.1.0.skill.zip?sig=xxx&exp=1705312200
X-Content-Digest: sha256:def456...
```

#### 9.2.5 发布新版本

```http
POST /v1/publish
Authorization: Bearer <oidc_token>
Content-Type: multipart/form-data

--boundary
Content-Disposition: form-data; name="bundle"; filename="plugin.zip"
Content-Type: application/zip
<binary ZIP data>

--boundary
Content-Disposition: form-data; name="signature"; filename="plugin.zip.bundle"
Content-Type: application/octet-stream
<cosign signature bundle>

--boundary
Content-Disposition: form-data; name="sbom"; filename="sbom.json"
Content-Type: application/json
<CycloneDX SBOM>

--boundary
Content-Disposition: form-data; name="metadata"
Content-Type: application/json
{
    "pluginId": "enterprise-code-reviewer",
    "version": "2.1.0",
    "channel": "stable",
    "releaseNotes": "新增 lint-skill，修复 review-skill 误报问题",
    "gitRef": "refs/tags/v2.1.0",
    "gitCommit": "abc123def456...",
    "buildUrl": "https://github.com/acme/code-reviewer/actions/runs/12345"
}
--boundary--
```

**响应 202 (Accepted):**
```json
{
  "publishId": "pub-20250115-001",
  "status": "quarantine",
  "message": "版本已提交，进入隔离验证阶段",
  "estimatedTime": "5-15 minutes",
  "statusUrl": "/v1/publish/pub-20250115-001/status"
}
```

#### 9.2.6 审批版本

```http
POST /v1/plugins/{id}/{version}/approve
Authorization: Bearer <access_token>
Content-Type: application/json

{
    "decision": "approve",
    "comment": "安全扫描通过，代码审查完成",
    "conditions": [],
    "reviewer": "security-team@corp.com"
}
```

**响应 200:**
```json
{
  "pluginId": "enterprise-code-reviewer",
  "version": "2.1.0",
  "status": "approved",
  "approvedBy": "security-team@corp.com",
  "approvedAt": "2025-01-15T11:00:00Z"
}
```

#### 9.2.7 Git Webhook 接收器

```http
POST /v1/webhooks/git
X-Hub-Signature-256: sha256=<hmac_signature>
X-GitHub-Event: push
Content-Type: application/json

{
    "ref": "refs/tags/v2.1.0",
    "repository": {
        "full_name": "acme-corp/enterprise-code-reviewer",
        "clone_url": "https://github.com/acme-corp/enterprise-code-reviewer.git"
    },
    "head_commit": {
        "id": "abc123...",
        "message": "release: v2.1.0",
        "author": {
            "name": "Alice",
            "email": "alice@corp.com"
        }
    }
}
```

**响应 202:**
```json
{
  "buildId": "build-20250115-001",
  "status": "queued",
  "message": "构建已排队"
}
```

#### 9.2.8 审计事件查询

```http
GET /v1/admin/audit/events?type=publish,install,rollback&from=2025-01-01&to=2025-01-31&page=1&limit=50
Authorization: Bearer <admin_token>
```

**响应 200:**
```json
{
  "total": 1234,
  "page": 1,
  "items": [
    {
      "id": "evt-001",
      "type": "plugin.publish",
      "actor": "ci-bot@corp.com",
      "actorType": "service",
      "target": "enterprise-code-reviewer@2.1.0",
      "tenant": "acme-corp",
      "timestamp": "2025-01-15T10:00:00Z",
      "details": {
        "channel": "stable",
        "digest": "sha256:abc123...",
        "buildUrl": "https://github.com/acme/code-reviewer/actions/runs/12345"
      },
      "outcome": "success"
    },
    {
      "id": "evt-002",
      "type": "plugin.install",
      "actor": "bob@corp.com",
      "actorType": "user",
      "target": "enterprise-code-reviewer@2.1.0",
      "tenant": "acme-corp",
      "timestamp": "2025-01-15T10:05:00Z",
      "details": {
        "clientVersion": "2.1.88",
        "os": "darwin",
        "arch": "arm64"
      },
      "outcome": "success"
    }
  ]
}
```

---

## 10. 数据库 Schema 设计 [提案]

### 10.1 核心表结构

```sql
-- ========================================
-- 租户管理
-- ========================================
CREATE TABLE tenants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug            VARCHAR(100) UNIQUE NOT NULL,      -- 'acme-corp'
    display_name    VARCHAR(255) NOT NULL,              -- 'ACME Corporation'
    status          VARCHAR(20) DEFAULT 'active',       -- active | suspended | archived
    settings        JSONB DEFAULT '{}',                 -- 租户级配置
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ========================================
-- 用户与身份
-- ========================================
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    external_id     VARCHAR(255) NOT NULL,              -- IdP 中的用户标识
    email           VARCHAR(255) NOT NULL,
    display_name    VARCHAR(255),
    clearance       VARCHAR(20) DEFAULT 'internal',     -- public | internal | confidential | secret
    status          VARCHAR(20) DEFAULT 'active',
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id, external_id),
    UNIQUE(tenant_id, email)
);

-- ========================================
-- 用户组
-- ========================================
CREATE TABLE groups (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    slug            VARCHAR(100) NOT NULL,              -- '@org/engineering'
    display_name    VARCHAR(255) NOT NULL,
    parent_id       UUID REFERENCES groups(id),         -- 支持嵌套
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id, slug)
);

CREATE TABLE user_groups (
    user_id         UUID NOT NULL REFERENCES users(id),
    group_id        UUID NOT NULL REFERENCES groups(id),
    added_at        TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, group_id)
);

-- ========================================
-- 角色与权限
-- ========================================
CREATE TABLE roles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    name            VARCHAR(100) NOT NULL,              -- 'Marketplace Admin'
    description     TEXT,
    permissions     JSONB NOT NULL DEFAULT '[]',        -- ['plugin:read', 'plugin:publish', ...]
    is_system       BOOLEAN DEFAULT FALSE,              -- 系统内置角色不可删除
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id, name)
);

CREATE TABLE user_roles (
    user_id         UUID NOT NULL REFERENCES users(id),
    role_id         UUID NOT NULL REFERENCES roles(id),
    scope_type      VARCHAR(20) DEFAULT 'global',       -- global | marketplace | plugin
    scope_id        UUID,                               -- 对应 marketplace_id 或 plugin_id
    granted_at      TIMESTAMPTZ DEFAULT NOW(),
    granted_by      UUID REFERENCES users(id),
    PRIMARY KEY (user_id, role_id, scope_type, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'))
);

-- ========================================
-- 市场 (Marketplace)
-- ========================================
CREATE TABLE marketplaces (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    slug            VARCHAR(100) NOT NULL,              -- 'main', 'experimental'
    display_name    VARCHAR(255) NOT NULL,
    description     TEXT,
    status          VARCHAR(20) DEFAULT 'active',
    settings        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id, slug)
);

-- ========================================
-- 插件 (Plugin)
-- ========================================
CREATE TABLE plugins (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    marketplace_id  UUID NOT NULL REFERENCES marketplaces(id),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    slug            VARCHAR(200) NOT NULL,              -- 'enterprise-code-reviewer'
    display_name    VARCHAR(255) NOT NULL,
    description     TEXT,
    publisher_id    UUID NOT NULL REFERENCES users(id),
    visibility      VARCHAR(20) DEFAULT 'restricted',   -- public | restricted | private
    risk_level      VARCHAR(20) DEFAULT 'medium',       -- low | medium | high | critical
    categories      TEXT[] DEFAULT '{}',
    git_repo_url    VARCHAR(500),                       -- Git 仓库地址
    git_provider    VARCHAR(20),                        -- github | gitlab | gitea | bitbucket
    webhook_secret  VARCHAR(255),                       -- Webhook 签名密钥
    downloads       BIGINT DEFAULT 0,
    status          VARCHAR(20) DEFAULT 'active',       -- active | deprecated | archived
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(marketplace_id, slug)
);

-- ========================================
-- 插件版本 (Plugin Version)
-- ========================================
CREATE TABLE plugin_versions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plugin_id       UUID NOT NULL REFERENCES plugins(id),
    version         VARCHAR(50) NOT NULL,               -- '2.1.0' (SemVer)
    channel         VARCHAR(50) NOT NULL DEFAULT 'stable', -- stable | beta | nightly
    status          VARCHAR(20) DEFAULT 'quarantine',   -- quarantine | scanning | pending_review | approved | rejected | revoked
    release_notes   TEXT,
    git_ref         VARCHAR(255),                       -- 'refs/tags/v2.1.0'
    git_commit      VARCHAR(64),                        -- commit SHA
    build_url       VARCHAR(500),                       -- CI 构建链接

    -- 产物信息
    bundle_path     VARCHAR(500) NOT NULL,              -- S3 路径: artifacts/acme/code-reviewer/2.1.0/plugin.zip
    bundle_size     BIGINT NOT NULL,                    -- 字节数
    bundle_digest   VARCHAR(128) NOT NULL,              -- 'sha256:abc123...'

    -- 签名信息
    signature_path  VARCHAR(500),                       -- S3 路径: artifacts/.../plugin.zip.bundle
    sbom_path       VARCHAR(500),                       -- S3 路径: artifacts/.../sbom.json
    provenance_path VARCHAR(500),                       -- S3 路径: artifacts/.../provenance.json

    -- 安全扫描结果
    scan_results    JSONB DEFAULT '{}',                 -- { sca: {}, sast: {}, license: {} }

    -- 兼容性
    engine_constraint VARCHAR(100),                     -- '>=2.0.0'

    -- 权限声明
    permissions     JSONB DEFAULT '{}',                 -- { tools: [...], network: [...] }

    -- 时间戳
    published_at    TIMESTAMPTZ,
    approved_at     TIMESTAMPTZ,
    approved_by     UUID REFERENCES users(id),
    revoked_at      TIMESTAMPTZ,
    revoked_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(plugin_id, version, channel)
);

-- ========================================
-- Skill 元数据 (独立跟踪以支持 Skill ZIP 下载)
-- ========================================
CREATE TABLE plugin_skills (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plugin_version_id UUID NOT NULL REFERENCES plugin_versions(id),
    skill_name      VARCHAR(200) NOT NULL,              -- 'review-skill'
    description     TEXT,
    skill_zip_path  VARCHAR(500),                       -- S3 路径: artifacts/.../review-skill.zip
    skill_zip_size  BIGINT,
    skill_zip_digest VARCHAR(128),                      -- 'sha256:def456...'
    created_at      TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(plugin_version_id, skill_name)
);

-- ========================================
-- 插件 ACL (Plugin-Level Access Control)
-- ========================================
CREATE TABLE plugin_acl (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plugin_id       UUID NOT NULL REFERENCES plugins(id),
    principal_type  VARCHAR(20) NOT NULL,               -- 'user' | 'group' | 'role'
    principal_id    UUID NOT NULL,                      -- 对应 user_id, group_id, 或 role_id
    permission      VARCHAR(50) NOT NULL,               -- 'read' | 'install' | 'download' | 'publish' | 'admin'
    channel         VARCHAR(50),                        -- NULL = 所有渠道; 'beta' = 仅 beta
    granted_at      TIMESTAMPTZ DEFAULT NOW(),
    granted_by      UUID REFERENCES users(id),

    UNIQUE(plugin_id, principal_type, principal_id, permission, COALESCE(channel, '*'))
);

-- ========================================
-- 审计日志
-- ========================================
CREATE TABLE audit_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    event_type      VARCHAR(100) NOT NULL,              -- 'plugin.publish', 'plugin.install', etc.
    actor_id        UUID,                               -- 操作者 user_id
    actor_type      VARCHAR(20) NOT NULL,               -- 'user' | 'service' | 'system'
    actor_email     VARCHAR(255),
    target_type     VARCHAR(50),                        -- 'plugin', 'version', 'marketplace'
    target_id       UUID,
    target_ref      VARCHAR(255),                       -- 'enterprise-code-reviewer@2.1.0'
    details         JSONB DEFAULT '{}',
    outcome         VARCHAR(20) NOT NULL,               -- 'success' | 'failure' | 'denied'
    client_ip       INET,
    user_agent      VARCHAR(500),
    timestamp       TIMESTAMPTZ DEFAULT NOW()
);

-- 审计日志使用 TimescaleDB 或分区表优化查询性能
CREATE INDEX idx_audit_tenant_time ON audit_events (tenant_id, timestamp DESC);
CREATE INDEX idx_audit_type ON audit_events (event_type);
CREATE INDEX idx_audit_actor ON audit_events (actor_id);
CREATE INDEX idx_audit_target ON audit_events (target_id);

-- ========================================
-- 市场索引快照 (支持回滚)
-- ========================================
CREATE TABLE marketplace_snapshots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    marketplace_id  UUID NOT NULL REFERENCES marketplaces(id),
    channel         VARCHAR(50) NOT NULL,
    snapshot_version VARCHAR(50) NOT NULL,              -- '2025.01.15.001'
    content_hash    VARCHAR(128) NOT NULL,              -- marketplace.json 的 SHA256
    storage_path    VARCHAR(500) NOT NULL,              -- S3 路径
    is_active       BOOLEAN DEFAULT FALSE,              -- 当前活跃的快照
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    created_by      UUID REFERENCES users(id)
);

-- ========================================
-- Webhook 注册
-- ========================================
CREATE TABLE webhook_registrations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plugin_id       UUID NOT NULL REFERENCES plugins(id),
    provider        VARCHAR(20) NOT NULL,               -- github | gitlab | gitea
    repo_url        VARCHAR(500) NOT NULL,
    webhook_id      VARCHAR(100),                       -- 平台上的 webhook ID
    secret_hash     VARCHAR(128) NOT NULL,              -- webhook secret 的 hash
    events          TEXT[] DEFAULT '{push,tag}',
    status          VARCHAR(20) DEFAULT 'active',
    last_delivery   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ========================================
-- 行级安全策略 (RLS)
-- ========================================

-- 启用 RLS
ALTER TABLE plugins ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

-- 租户隔离策略
CREATE POLICY tenant_isolation_plugins ON plugins
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE POLICY tenant_isolation_versions ON plugin_versions
    FOR ALL
    USING (plugin_id IN (
        SELECT id FROM plugins
        WHERE tenant_id = current_setting('app.current_tenant_id')::UUID
    ));

CREATE POLICY tenant_isolation_audit ON audit_events
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
```

### 10.2 关键索引

```sql
-- 性能优化索引
CREATE INDEX idx_plugins_marketplace ON plugins(marketplace_id);
CREATE INDEX idx_plugins_publisher ON plugins(publisher_id);
CREATE INDEX idx_plugins_slug ON plugins(slug);
CREATE INDEX idx_plugins_categories ON plugins USING GIN(categories);

CREATE INDEX idx_versions_plugin ON plugin_versions(plugin_id);
CREATE INDEX idx_versions_channel ON plugin_versions(channel);
CREATE INDEX idx_versions_status ON plugin_versions(status);
CREATE INDEX idx_versions_digest ON plugin_versions(bundle_digest);

CREATE INDEX idx_acl_plugin ON plugin_acl(plugin_id);
CREATE INDEX idx_acl_principal ON plugin_acl(principal_type, principal_id);

CREATE INDEX idx_skills_version ON plugin_skills(plugin_version_id);

CREATE INDEX idx_groups_parent ON groups(parent_id);
CREATE INDEX idx_groups_tenant ON groups(tenant_id);
```

---

## 11. 数据模型 ER 图 [提案]

```mermaid
erDiagram
    TENANT ||--o{ USER : "belongs to"
    TENANT ||--o{ MARKETPLACE : "owns"
    TENANT ||--o{ GROUP : "has"
    TENANT ||--o{ ROLE : "defines"
    TENANT ||--o{ AUDIT_EVENT : "generates"

    USER ||--o{ USER_GROUP : "member of"
    GROUP ||--o{ USER_GROUP : "contains"
    GROUP ||--o| GROUP : "parent"

    USER ||--o{ USER_ROLE : "assigned"
    ROLE ||--o{ USER_ROLE : "granted to"

    MARKETPLACE ||--o{ PLUGIN : "hosts"
    MARKETPLACE ||--o{ MARKETPLACE_SNAPSHOT : "versioned by"

    PLUGIN ||--o{ PLUGIN_VERSION : "has versions"
    PLUGIN ||--o{ PLUGIN_ACL : "controlled by"
    PLUGIN ||--o| WEBHOOK_REGISTRATION : "triggered by"

    PLUGIN_VERSION ||--o{ PLUGIN_SKILL : "contains"

    USER ||--o{ PLUGIN : "publishes"
    USER ||--o{ PLUGIN_ACL : "grants"
    USER ||--o{ AUDIT_EVENT : "performs"

    TENANT {
        uuid id PK
        varchar slug UK
        varchar display_name
        varchar status
        jsonb settings
    }

    USER {
        uuid id PK
        uuid tenant_id FK
        varchar external_id
        varchar email
        varchar clearance
    }

    GROUP {
        uuid id PK
        uuid tenant_id FK
        varchar slug UK
        uuid parent_id FK
    }

    ROLE {
        uuid id PK
        uuid tenant_id FK
        varchar name UK
        jsonb permissions
        boolean is_system
    }

    MARKETPLACE {
        uuid id PK
        uuid tenant_id FK
        varchar slug UK
        varchar display_name
        varchar status
    }

    PLUGIN {
        uuid id PK
        uuid marketplace_id FK
        varchar slug UK
        varchar visibility
        varchar risk_level
        varchar git_repo_url
        bigint downloads
    }

    PLUGIN_VERSION {
        uuid id PK
        uuid plugin_id FK
        varchar version
        varchar channel
        varchar status
        varchar bundle_digest
        varchar bundle_path
        jsonb scan_results
    }

    PLUGIN_SKILL {
        uuid id PK
        uuid plugin_version_id FK
        varchar skill_name
        varchar skill_zip_path
        varchar skill_zip_digest
    }

    PLUGIN_ACL {
        uuid id PK
        uuid plugin_id FK
        varchar principal_type
        uuid principal_id
        varchar permission
        varchar channel
    }

    AUDIT_EVENT {
        uuid id PK
        uuid tenant_id FK
        varchar event_type
        uuid actor_id
        varchar outcome
        jsonb details
        timestamptz timestamp
    }

    MARKETPLACE_SNAPSHOT {
        uuid id PK
        uuid marketplace_id FK
        varchar channel
        varchar snapshot_version
        boolean is_active
    }

    WEBHOOK_REGISTRATION {
        uuid id PK
        uuid plugin_id FK
        varchar provider
        varchar repo_url
        varchar status
    }
```

---

## 12. 部署架构 [提案]

### 12.1 容器化部署架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    Kubernetes Cluster                            │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ Ingress      │  │ Cert Manager │  │ External     │          │
│  │ Controller   │  │ (Let's       │  │ Secrets      │          │
│  │ (NGINX/      │  │  Encrypt)    │  │ Operator     │          │
│  │  Traefik)    │  │              │  │ (Vault)      │          │
│  └──────┬───────┘  └──────────────┘  └──────────────┘          │
│         │                                                       │
│  ┌──────┴─────────────────────────────────────┐                │
│  │             API Gateway (Kong/Envoy)        │                │
│  │  - Rate limiting  - Auth validation         │                │
│  │  - Request routing  - TLS termination       │                │
│  └──────┬──────────┬──────────┬───────────────┘                │
│         │          │          │                                  │
│  ┌──────┴──────┐ ┌─┴────────┐ ┌┴─────────────┐                │
│  │ Marketplace │ │ Auth     │ │ Build        │                 │
│  │ API Service │ │ Service  │ │ Service      │                 │
│  │ (3 replicas)│ │ (2 rep.) │ │ (Job-based)  │                 │
│  └──────┬──────┘ └─┬────────┘ └┬─────────────┘                │
│         │          │           │                                │
│  ┌──────┴──────┐ ┌─┴────────┐ ┌┴─────────────┐                │
│  │ ACL Service │ │ Webhook  │ │ Scanner      │                 │
│  │ (2 replicas)│ │ Receiver │ │ Service      │                 │
│  └──────┬──────┘ │ (2 rep.) │ │ (Job-based)  │                │
│         │        └──────────┘ └──────────────┘                 │
│  ┌──────┴──────┐                                               │
│  │ Index       │                                               │
│  │ Generator   │                                               │
│  │ (CronJob)   │                                               │
│  └─────────────┘                                               │
│                                                                 │
│  ┌──────────────────────────────────────────────┐              │
│  │              Message Queue (NATS/RabbitMQ)    │              │
│  │  - build.trigger  - scan.complete             │              │
│  │  - publish.approved  - audit.event            │              │
│  └──────────────────────────────────────────────┘              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

外部依赖:
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ PostgreSQL   │  │ S3 / MinIO   │  │ Redis        │
│ (RDS/Aurora) │  │ (Artifact    │  │ (Cache +     │
│              │  │  Storage)    │  │  Sessions)   │
└──────────────┘  └──────────────┘  └──────────────┘

┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ CDN          │  │ KMS / HSM    │  │ SIEM         │
│ (CloudFront/ │  │ (Signing     │  │ (Splunk/     │
│  Cloudflare) │  │  Keys)       │  │  Datadog)    │
└──────────────┘  └──────────────┘  └──────────────┘
```

### 12.2 服务组件说明

| 服务 | 副本数 | 资源配置 | 说明 |
|------|--------|----------|------|
| API Gateway | 2-4 | 1C/1G | 请求路由、限流、TLS |
| Marketplace API | 3+ | 2C/4G | 核心 API，无状态 |
| Auth Service | 2+ | 1C/2G | Token 验证和交换 |
| ACL Service | 2+ | 1C/2G | 权限计算和缓存 |
| Index Generator | 1 (CronJob) | 2C/4G | 定期重新生成 marketplace.json |
| Build Service | 0-N (Job) | 4C/8G | 按需创建构建 Pod |
| Scanner Service | 0-N (Job) | 2C/4G | 按需创建扫描 Pod |
| Webhook Receiver | 2+ | 1C/1G | 接收 Git 事件 |

### 12.3 存储规划

| 组件 | 技术选型 | 容量规划 | 备份策略 |
|------|----------|----------|----------|
| Metadata DB | PostgreSQL 15+ (Aurora) | 100GB+ | 连续备份 + 跨区只读副本 |
| Artifact Store | S3/MinIO | 1TB+ | 版本控制 + 跨区复制 |
| Cache | Redis 7+ (Cluster) | 16GB+ | AOF 持久化 |
| CDN | CloudFront/Cloudflare | N/A | 边缘缓存，源站回源 |
| KMS | AWS KMS / HashiCorp Vault | N/A | HSM 后端 |
| 审计日志 | TimescaleDB / S3 归档 | 无限增长 | 冷热分层，90天热+归档 |

### 12.4 网络安全

```
Internet
    │
    ▼
[WAF] → [CDN] → [Load Balancer]
                      │
                      ▼
              [API Gateway] (TLS termination)
                      │
                  [VPC 内网]
                 ┌────┴────┐
                 │ Services │ (mTLS between services)
                 └────┬────┘
                 ┌────┴────┐
                 │ Database │ (Private subnet, no public access)
                 └─────────┘
```

### 12.5 高可用与容灾

| 层级 | 策略 |
|------|------|
| **应用层** | 多副本部署，跨 AZ，HPA 自动伸缩 |
| **数据库** | 主从复制，自动故障转移，跨区只读副本 |
| **对象存储** | 跨区域复制 (CRR)，版本控制防误删 |
| **CDN** | 多 POP 点，源站故障自动回源 |
| **整体 DR** | RPO < 1h, RTO < 4h；每季度演练 |

---

## 13. Claude Code CLI 集成示例 [提案]

### 13.1 基本配置

```jsonc
// ~/.claude/settings.json
{
  // 注册私有市场 — 使用现有 source:url + headers [已实现]
  "marketplaces": [
    // 生产稳定渠道
    {
      "source": "url",
      "url": "https://marketplace.corp.com/v1/marketplaces/acme/stable/marketplace.json",
      "headers": {
        "Authorization": "Bearer eyJhbGciOiJSUzI1NiIs...",
        "X-Tenant-ID": "acme-corp"
      }
    },
    // Beta 渠道（可选）
    {
      "source": "url",
      "url": "https://marketplace.corp.com/v1/marketplaces/acme/beta/marketplace.json",
      "headers": {
        "Authorization": "Bearer eyJhbGciOiJSUzI1NiIs...",
        "X-Tenant-ID": "acme-corp"
      }
    }
  ]
}
```

### 13.2 企业 Managed Settings（IT 管理员配置）

```jsonc
// /etc/claude/managed-settings.json (通过 MDM/GPO 分发)
{
  "policySettings": {
    // 锁定只允许使用已知市场 [已实现]
    "strictKnownMarketplaces": true,

    // 允许的市场源 [已实现]
    "allowedMarketplaces": [
      {
        "hostPattern": "marketplace.corp.com",
        "pathPattern": "/v1/marketplaces/**"
      }
    ],

    // 阻断的市场源 [已实现]
    "blockedMarketplaces": [
      {
        "hostPattern": "*",
        "pathPattern": "**"
      }
    ]
  },

  // 强制启用的插件 [已实现]
  "managedEnabledPlugins": [
    "enterprise-code-reviewer",
    "security-scanner"
  ],

  // 强制禁用的插件 [已实现]
  "managedDisabledPlugins": [
    "untrusted-plugin"
  ],

  // 市场配置（自动注入到用户设置）
  "marketplaces": [
    {
      "source": "url",
      "url": "https://marketplace.corp.com/v1/marketplaces/acme/stable/marketplace.json",
      "headers": {
        "Authorization": "Bearer ${DYNAMIC_TOKEN}"
      }
    }
  ]
}
```

### 13.3 环境变量配置

```bash
# 启用 ZIP 缓存 [已实现]
export CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE=1

# [提案] 私有市场相关环境变量
export CORP_MARKETPLACE_URL="https://marketplace.corp.com"
export CORP_MARKETPLACE_TENANT="acme-corp"

# [提案] 自动 Token 刷新
export CORP_MARKETPLACE_TOKEN_ENDPOINT="https://auth.corp.com/oauth2/token"
export CORP_MARKETPLACE_CLIENT_ID="claude-code-client"
```

### 13.4 典型使用流程

```bash
# 1. 登录企业市场 [提案]
$ claude marketplace login --provider corp-sso
→ 请在浏览器中打开 https://auth.corp.com/device
→ 输入代码: ABCD-EFGH
→ 登录成功！Token 已安全存储。

# 2. 浏览可用插件（只显示你有权限访问的）
$ claude marketplace list
┌───────────────────────────┬─────────┬────────┬──────────────────┐
│ Plugin                    │ Version │ Risk   │ Description      │
├───────────────────────────┼─────────┼────────┼──────────────────┤
│ enterprise-code-reviewer  │ 2.1.0   │ medium │ 企业代码审查器    │
│ security-scanner          │ 1.5.2   │ high   │ 安全扫描器       │
│ db-migrator               │ 3.0.1   │ medium │ 数据库迁移工具    │
│ api-generator             │ 1.2.0   │ low    │ API 代码生成器    │
└───────────────────────────┴─────────┴────────┴──────────────────┘

# 3. 查看插件详情
$ claude marketplace info enterprise-code-reviewer
Name:        enterprise-code-reviewer
Version:     2.1.0
Publisher:   platform-team
Risk Level:  medium
Signed:      ✓ (cosign, verified)
SBOM:        ✓ (CycloneDX)
Skills:
  - review-skill: 自动化代码审查 Skill
  - lint-skill:   代码规范检查 Skill
Permissions:
  - Tools: Read, Write, Bash
  - Network: https://internal-api.corp.com

# 4. 安装完整插件
$ claude marketplace install enterprise-code-reviewer@2.1.0
→ 下载插件包... ██████████ 100%
→ 验证签名... ✓
→ 验证完整性 (SHA256)... ✓
→ 安装到本地缓存... ✓
→ 插件已启用 ✓

# 5. 仅下载某个 Skill
$ claude marketplace install enterprise-code-reviewer@2.1.0 --skill review-skill
→ 下载 Skill 包... ██████████ 100%
→ 验证签名... ✓
→ 安装 review-skill 到本地缓存... ✓
→ Skill 已启用 ✓

# 6. 导出插件为 ZIP 文件（离线分享）
$ claude marketplace download enterprise-code-reviewer@2.1.0 --output ./
→ 已下载: ./enterprise-code-reviewer-2.1.0.plugin.zip

# 7. 导出单个 Skill 为 ZIP 文件
$ claude marketplace download enterprise-code-reviewer@2.1.0 --skill review-skill --output ./
→ 已下载: ./enterprise-code-reviewer-review-skill-2.1.0.skill.zip
```

### 13.5 与现有 Git Source 配合使用

```jsonc
// 混合使用多种 marketplace source [已实现]
{
  "marketplaces": [
    // 私有市场（URL + 鉴权）
    {
      "source": "url",
      "url": "https://marketplace.corp.com/v1/marketplaces/acme/stable/marketplace.json",
      "headers": {
        "Authorization": "Bearer ${TOKEN}"
      }
    },
    // 内部 Git 仓库中的插件（Git source）
    {
      "source": "git",
      "url": "https://git.corp.com/team/internal-plugins.git",
      "ref": "main",
      "path": "marketplace.json"
    },
    // GitHub 上的公开插件（GitHub source）
    {
      "source": "github",
      "repo": "anthropics/claude-code-plugins",
      "ref": "main",
      "path": "marketplace.json"
    }
  ]
}
```

---

## 14. 企业治理：审计、合规、多租户、灾备 [提案]

### 14.1 审计追踪

#### 14.1.1 审计事件类型

| 事件类型 | 触发时机 | 记录内容 |
|----------|----------|----------|
| `user.login` | 用户通过 OIDC 登录 | user_id, idp, device_info |
| `marketplace.access` | 用户获取 marketplace.json | user_id, filters_applied, plugins_visible |
| `plugin.publish` | 新版本发布 | publisher, version, channel, digest, scan_results |
| `plugin.approve` | 审批通过 | reviewer, decision, conditions |
| `plugin.reject` | 审批拒绝 | reviewer, reason |
| `plugin.install` | 用户安装插件 | user_id, plugin, version, client_info |
| `plugin.download` | 用户下载 ZIP | user_id, plugin, type (plugin/skill) |
| `plugin.revoke` | 版本被撤销 | admin, reason, affected_users |
| `plugin.rollback` | 版本回滚 | admin, from_version, to_version, scope |
| `policy.update` | 策略变更 | admin, old_policy, new_policy |
| `policy.deny` | 策略阻断安装 | user_id, plugin, deny_reason |
| `acl.grant` | 权限授予 | granter, grantee, permission, scope |
| `acl.revoke` | 权限撤销 | revoker, revokee, permission |

#### 14.1.2 审计日志格式 (OpenTelemetry 兼容)

```json
{
  "timestamp": "2025-01-15T10:05:00.000Z",
  "severity": "INFO",
  "traceId": "abc123def456...",
  "spanId": "789ghi...",
  "body": "plugin.install",
  "attributes": {
    "audit.event_type": "plugin.install",
    "audit.tenant_id": "acme-corp",
    "audit.actor.id": "user-uuid-001",
    "audit.actor.email": "bob@corp.com",
    "audit.actor.type": "user",
    "audit.target.type": "plugin_version",
    "audit.target.ref": "enterprise-code-reviewer@2.1.0",
    "audit.outcome": "success",
    "audit.client.version": "2.1.88",
    "audit.client.os": "darwin",
    "audit.client.arch": "arm64",
    "audit.client.ip": "10.0.1.100"
  },
  "resource": {
    "service.name": "marketplace-api",
    "service.version": "1.0.0",
    "deployment.environment": "production"
  }
}
```

#### 14.1.3 审计数据流

```
Claude Code CLI → Marketplace API → Audit Service → Message Queue
                                                          │
                                    ┌─────────────────────┤
                                    ▼                     ▼
                              PostgreSQL            SIEM Pipeline
                              (热数据，90天)        (Splunk/Datadog/ELK)
                                    │
                                    ▼
                              S3 归档
                              (冷数据，7年+)
```

### 14.2 合规框架

| 合规要求 | 实现方式 |
|----------|----------|
| **SOC 2 Type II** | 完整审计日志、访问控制、变更管理 |
| **ISO 27001** | 信息安全管理体系，风险评估 |
| **GDPR** | 数据最小化、用户数据可删除、审计日志脱敏 |
| **HIPAA** | PHI 隔离、加密传输/存储、访问审计 |
| **FedRAMP** | FIPS 加密、边界控制、持续监控 |

### 14.3 多租户隔离

| 隔离层 | 技术实现 |
|--------|----------|
| **数据库** | PostgreSQL RLS (Row-Level Security) 按 tenant_id 隔离 |
| **对象存储** | S3 bucket prefix 按 tenant 分区：`s3://artifacts/{tenant_id}/` |
| **网络** | VPC 内网隔离，tenant 间不可直接通信 |
| **密钥** | 每个 tenant 独立的 KMS key，签名密钥隔离 |
| **缓存** | Redis key prefix：`{tenant_id}:` |
| **CDN** | 签名 URL 包含 tenant scope，防止跨租户访问 |

### 14.4 多环境管理

```
生产环境 (prod)
├── stable 渠道 → 全员可见
├── beta 渠道   → 工程部可见
└── canary 渠道 → SRE 团队可见

预生产环境 (staging)
├── stable 渠道 → QA + 工程部
└── beta 渠道   → 工程部

开发环境 (dev)
├── nightly 渠道 → 插件开发者
└── local 渠道   → 个人开发者
```

### 14.5 灾备策略

#### 14.5.1 备份策略

| 组件 | RPO | RTO | 备份方式 |
|------|-----|-----|----------|
| PostgreSQL | < 1 分钟 | < 15 分钟 | 连续 WAL 归档 + 时间点恢复 |
| S3 Artifacts | 0 (跨区复制) | < 5 分钟 | CRR + 版本控制 |
| Redis Cache | < 5 分钟 | < 5 分钟 | AOF + 快照 (可丢失，可重建) |
| marketplace.json | 0 (CDN 缓存) | < 1 分钟 | Snapshot 表 + S3 快照 |

#### 14.5.2 灾难恢复流程

```
1. 检测：监控告警 + 健康检查自动触发
   ↓
2. 判定：自动故障转移（数据库、DNS）或人工介入
   ↓
3. 切换：
   - DB: Aurora 自动故障转移到只读副本
   - S3: 切换到备份区域的 CRR 副本
   - DNS: Route53 健康检查自动切换
   ↓
4. 验证：运行端到端健康检查
   ↓
5. 通知：告知受影响的租户
   ↓
6. 恢复：故障修复后，数据同步 + 切回主区域
```

#### 14.5.3 定期演练

- **频率**：每季度一次完整 DR 演练
- **范围**：包括数据库故障转移、区域切换、数据恢复
- **记录**：演练结果记录并纳入 SOC 2 审计证据

### 14.6 密钥管理

```
┌────────────────────────────────┐
│     Key Hierarchy              │
│                                │
│  Root Key (HSM)                │
│  ├── Tenant Master Key         │
│  │   ├── Signing Key           │  → 用于插件签名
│  │   ├── Encryption Key        │  → 用于敏感数据加密
│  │   └── Webhook Secret Key    │  → 用于生成 webhook secret
│  └── Platform Master Key       │
│      ├── JWT Signing Key       │  → 用于签发 JWT
│      ├── CDN Signing Key       │  → 用于生成签名 URL
│      └── DB Encryption Key     │  → 用于数据库 TDE
└────────────────────────────────┘
```

### 14.7 配额与限流

| 资源 | 限制 | 说明 |
|------|------|------|
| API 请求 | 1000 req/min/tenant | 按租户限流 |
| 上传大小 | 100MB/插件包 | 单个 ZIP 上限 |
| 发布频率 | 10 次/小时/publisher | 防止滥用 |
| 下载带宽 | 1GB/小时/user | CDN 带宽控制 |
| 并发构建 | 5/tenant | 构建资源限制 |

---

## 15. 具体实现计划 [提案]

### 15.1 与现有代码的对接点

| 改造点 | 涉及文件 | 改造内容 | 复杂度 |
|--------|----------|----------|--------|
| **Token 获取与刷新** | 新增 `src/utils/plugins/auth/` | OIDC Device Flow + Token Cache + Auto Refresh | 高 |
| **动态 Header 注入** | `schemas.ts:910-914` | 支持 `headers` 中的 `${VAR}` 动态替换 | 中 |
| **签名验证** | 新增 `src/utils/plugins/verify/` | 下载后验证 Cosign 签名 + Digest | 高 |
| **Skill 独立下载** | `loadPluginCommands.ts`, `zipCache.ts` | 支持从 marketplace 下载单个 Skill ZIP | 中 |
| **marketplace.json 扩展** | `schemas.ts:1000-1043` | 新增 `skills[]` 和 `signature` 字段到 plugin entry | 低 |
| **审计事件上报** | 新增 `src/utils/plugins/audit/` | install/deny/verify/rollback 事件上报 | 中 |
| **CLI 子命令** | 新增 `src/commands/marketplace/` | `marketplace login/list/install/download` | 高 |
| **策略扩展** | `marketplaceHelpers.ts` | 支持 `requireSignatureVerification` 策略 | 低 |
| **ZIP Cache 路径扩展** | `zipCache.ts` | 新增 `skills/` 和 `signatures/` 缓存路径 | 低 |

### 15.2 分阶段实施路线图

#### Phase 1：基础市场服务 (4-6 周)

- [ ] 搭建 Marketplace API 服务框架（Node.js/Go）
- [ ] 实现 PostgreSQL Schema + RLS
- [ ] 实现 Git Webhook 接收器 + 基础构建流水线
- [ ] 实现 `marketplace.json` 生成（不含 ACL 过滤）
- [ ] CLI: 使用现有 `source:url` + `headers` 手动 Token 接入

#### Phase 2：安全与签名 (3-4 周)

- [ ] 集成 Cosign 签名服务
- [ ] 实现安全扫描流水线 (SCA + SAST + License)
- [ ] CLI: 实现签名验证逻辑
- [ ] 实现 Quarantine → Approve 发布流程
- [ ] 实现版本回滚机制

#### Phase 3：ACL 与 Per-User Visibility (3-4 周)

- [ ] 实现 RBAC + ABAC 授权引擎
- [ ] 实现 Per-User marketplace.json 过滤
- [ ] 实现组层级和权限继承
- [ ] 实现插件级和渠道级 ACL

#### Phase 4：CLI 深度集成 (3-4 周)

- [ ] CLI: 实现 OIDC Device Flow 登录
- [ ] CLI: 实现 Token 自动刷新
- [ ] CLI: 实现 `marketplace` 子命令族
- [ ] CLI: 实现 Skill 独立下载
- [ ] CLI: 实现签名验证集成

#### Phase 5：企业治理 (2-3 周)

- [ ] 实现完整审计日志管线
- [ ] 实现多租户隔离加固
- [ ] 实现 Managed Settings 动态下发
- [ ] 灾备方案实施和演练
- [ ] 性能优化和压力测试

### 15.3 关键技术栈建议

| 层级 | 技术选型 | 备选 |
|------|----------|------|
| API 服务 | Node.js (Fastify) / Go (Gin) | Rust (Axum) |
| 数据库 | PostgreSQL 15+ | CockroachDB |
| 缓存 | Redis 7+ | KeyDB |
| 消息队列 | NATS | RabbitMQ / Kafka |
| 对象存储 | AWS S3 / MinIO | GCS / Azure Blob |
| CDN | CloudFront / Cloudflare | Fastly |
| 签名 | Cosign + Sigstore | Notary v2 |
| 授权引擎 | OPA (Rego) / Cedar | Casbin |
| 容器编排 | Kubernetes | ECS / Nomad |
| CI/CD | GitHub Actions | GitLab CI / Tekton |
| 监控 | Prometheus + Grafana | Datadog |
| 日志 | OpenTelemetry + Loki | ELK Stack |
| 密钥管理 | AWS KMS / HashiCorp Vault | GCP KMS |

---

## 16. 附录

### 16.1 术语表

| 术语 | 说明 |
|------|------|
| **Plugin** | Claude Code 的扩展包，包含 Skills、Commands、Hooks |
| **Skill** | 插件中的一个独立技能单元，包含 SKILL.md 描述和处理逻辑 |
| **Marketplace** | 插件市场，提供 `marketplace.json` 索引 |
| **Channel** | 发布渠道：stable, beta, nightly |
| **Bundle** | 插件打包后的 ZIP 文件 |
| **Manifest** | 插件描述文件 `plugin.json` |
| **Reconciler** | 声明态与物化态的同步器 [已实现] |
| **Materialization** | 从声明（settings）到实际文件的实例化过程 [已实现] |
| **RLS** | Row-Level Security，PostgreSQL 行级安全策略 |
| **SLSA** | Supply-chain Levels for Software Artifacts，供应链安全等级 |
| **SBOM** | Software Bill of Materials，软件物料清单 |

### 16.2 参考资料

- [Sigstore / Cosign](https://docs.sigstore.dev/) - 供应链签名
- [SLSA Framework](https://slsa.dev/) - 供应链安全等级
- [OPA (Open Policy Agent)](https://www.openpolicyagent.org/) - 策略引擎
- [Cedar Policy Language](https://www.cedarpolicy.com/) - Amazon 策略语言
- [CycloneDX](https://cyclonedx.org/) - SBOM 标准
- [OpenTelemetry](https://opentelemetry.io/) - 可观测性标准

### 16.3 变更日志

| 版本 | 日期 | 变更内容 |
|------|------|----------|
| v2.0 | 2025-01 | 完全重写：新增 Git 协作模型、Per-User Visibility、ZIP 下载、详细 API、数据库 Schema、部署架构、CLI 集成示例、企业治理 |
| v1.0 | 2025-01 | 初始版本：基础架构、鉴权模型、发布流程 |

---

> **总结**：本方案与当前 Claude Code 实现完全兼容，核心策略是继续复用 **"settings-first + reconcile + refresh + fail-closed policy"** 主干架构 [已实现]，在此基础上增量扩展以下能力 [提案]：
>
> 1. **Git-Native 协作** — 插件开发者通过 Git 分支/PR 协作，市场通过 Webhook 自动摄取
> 2. **Per-User Visibility** — ACL + RBAC/ABAC 驱动的个性化市场视图
> 3. **ZIP 下载** — 插件 Bundle 和 Skill 均支持 ZIP 下载，复用现有 zipCache
> 4. **无缝 CLI 集成** — 通过现有 `source:url` + `headers` 零改造接入
> 5. **供应链安全** — Cosign 签名 + SLSA 溯源 + SCA/SAST 扫描 + 一键回滚
> 6. **企业治理** — 完整审计、多租户隔离、合规框架、灾备策略
