# Computer Use MCP Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `recover/claude-v2.1.165.js` 中的 `@ant/computer-use-mcp` 建立脚本化模块簇分析能力，并在仓库内落地最小可维护的 `packages/ant-computer-use-mcp` 包骨架，使当前构建与类型解析不再依赖全局 missing-module stub 来解析该包。

**Architecture:** 先复用现有 `scripts/workflow-deobfuscator.mjs` 的字符串锚点/平衡片段抽取风格，新增一个面向 computer-use 的 recover 分析脚本，输出模块簇证据文件；再将当前仓库对 `@ant/computer-use-mcp` 的真实导出需求收敛到一个本地 workspace 包中，并修改 `scripts/build.mjs`、workspace 配置与类型声明，让 `@ant/computer-use-mcp` 走本地实现、而 `@ant/computer-use-input` / `@ant/computer-use-swift` 仍维持原生 stub 策略。

**Tech Stack:** TypeScript, Node.js ESM, esbuild, pnpm workspace, ripgrep-compatible bundle analysis, existing Claude Code recovery build pipeline

---

## File map

### New files
- `scripts/computer-use-deobfuscator.mjs` — 从 recover bundle 中提取 computer-use 相关 symbol 邻域、模块簇与导出候选。
- `scripts/computer-use-deobfuscator.test.mjs` — deobfuscator 的最小自测。
- `packages/ant-computer-use-mcp/package.json` — 本地 workspace 包 manifest。
- `packages/ant-computer-use-mcp/src/index.ts` — 包主导出面。
- `packages/ant-computer-use-mcp/src/types.ts` — 由现有调用方反推得到的最小公开类型。
- `packages/ant-computer-use-mcp/src/sentinelApps.ts` — 哨兵 app 分类。
- `packages/ant-computer-use-mcp/src/coordinates.ts` — `API_RESIZE_PARAMS` 与 `targetImageSize`。
- `packages/ant-computer-use-mcp/src/toolDefinitions.ts` — `buildComputerUseTools` 的最小实现。
- `packages/ant-computer-use-mcp/src/server.ts` — `createComputerUseMcpServer` 的最小实现。
- `packages/ant-computer-use-mcp/src/session.ts` — `bindSessionContext` 的最小实现。

### Modified files
- `pnpm-workspace.yaml` — 加入 `packages/*`。
- `package.json` — 显式声明 `@ant/computer-use-mcp` 的 workspace 依赖，并增加 deobfuscator 运行脚本。
- `tsconfig.json` — 为 `@ant/computer-use-mcp` 与 `@ant/computer-use-mcp/*` 添加 paths。
- `scripts/build.mjs` — 让 `@ant/computer-use-mcp` 解析到 workspace 包源码，而不是掉进 `missing-module.cjs`；保留其他 `@ant/*` stub 行为。
- `types/ant-modules.d.ts` — 删除或收缩 `@ant/computer-use-mcp*` 相关声明，仅保留尚未本地化的 `@ant/*` 模块声明。

### Existing files to consult while implementing
- `scripts/workflow-deobfuscator.mjs`
- `scripts/workflow-deobfuscator.test.mjs`
- `src/utils/computerUse/setup.ts`
- `src/utils/computerUse/mcpServer.ts`
- `src/utils/computerUse/wrapper.tsx`
- `src/utils/computerUse/executor.ts`
- `src/utils/computerUse/gates.ts`
- `src/utils/computerUse/hostAdapter.ts`
- `src/components/permissions/ComputerUseApproval/ComputerUseApproval.tsx`

---

### Task 1: 建立 computer-use recover 分析脚本

**Files:**
- Create: `scripts/computer-use-deobfuscator.mjs`
- Create: `scripts/computer-use-deobfuscator.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: 写 computer-use deobfuscator 的 failing test**

```js
#!/usr/bin/env node
import assert from 'node:assert/strict'

import {
  extractComputerUseEvidence,
  findBundlerModuleAt,
} from './computer-use-deobfuscator.mjs'

const sample = `
var cuPkg = {};
j_(cuPkg, {
  buildComputerUseTools: () => buildTools,
  createComputerUseMcpServer: () => createServer,
  bindSessionContext: () => bindCtx,
  DEFAULT_GRANT_FLAGS: () => grantFlags,
});
var cuInit = L(() => {
  depA();
  depB();
});
function buildTools() { return [{ name: 'request_access' }]; }
function createServer() { return { connect() {} }; }
function bindCtx() { return async () => ({ content: [] }); }
const grantFlags = { clipboardRead: false, clipboardWrite: false, systemKeyCombos: false };
const entry = '--computer-use-mcp';
`

const evidence = extractComputerUseEvidence(sample, {
  symbols: ['buildComputerUseTools', 'createComputerUseMcpServer', '--computer-use-mcp'],
  contextBytes: 80,
})

assert.equal(evidence.symbols.length >= 3, true)
assert.equal(evidence.moduleClusters.length >= 1, true)
assert.equal(evidence.exportCandidates.some(item => item.exports.includes('buildComputerUseTools')), true)

const cluster = findBundlerModuleAt(sample, sample.indexOf('buildComputerUseTools'))
assert.equal(cluster?.exports.includes('bindSessionContext'), true)

console.log('computer-use-deobfuscator.test.mjs passed')
```

- [ ] **Step 2: 运行测试，确认当前失败**

Run: `node ./scripts/computer-use-deobfuscator.test.mjs`

Expected: FAIL，提示 `Cannot find module './computer-use-deobfuscator.mjs'` 或缺少导出。

- [ ] **Step 3: 实现 deobfuscator 脚本主体**

```js
#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultSymbols = [
  '--computer-use-mcp',
  'createComputerUseMcpServerForCli',
  'runComputerUseMcpServer',
  'buildComputerUseTools',
  'createComputerUseMcpServer',
  'bindSessionContext',
  'DEFAULT_GRANT_FLAGS',
  'API_RESIZE_PARAMS',
  'targetImageSize',
  'sentinelApps',
  'getSentinelCategory',
]

export function normalizeSnippet(value) {
  return [...value]
    .map(char => {
      const code = char.charCodeAt(0)
      return code <= 0x1f || code === 0x7f ? ' ' : char
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

export function symbolNeighborhoods(source, symbols, contextBytes = 320) {
  const results = []
  for (const symbol of symbols) {
    let offset = source.indexOf(symbol)
    while (offset !== -1) {
      results.push({
        symbol,
        offset,
        context: normalizeSnippet(
          source.slice(
            Math.max(0, offset - contextBytes),
            Math.min(source.length, offset + symbol.length + contextBytes),
          ),
        ),
      })
      offset = source.indexOf(symbol, offset + symbol.length)
    }
  }
  return results.sort((a, b) => a.offset - b.offset)
}

function readBalancedBlock(source, startIndex) {
  const braceStart = source.indexOf('{', startIndex)
  if (braceStart === -1) return null
  let depth = 0
  let quote
  let escaped = false
  for (let i = braceStart; i < source.length; i += 1) {
    const char = source[i]
    if (quote) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(startIndex, i + 1)
    }
  }
  return null
}

export function findBundlerModuleAt(source, offset) {
  const exportObjectStart = source.lastIndexOf('var ', offset)
  if (exportObjectStart === -1) return null
  const exportBlockStart = source.indexOf('j_(', exportObjectStart)
  if (exportBlockStart === -1 || exportBlockStart > offset + 600) return null
  const exportBlock = readBalancedBlock(source, exportBlockStart)
  const initDeclStart = source.indexOf('var ', exportBlockStart + 1)
  const initCallStart = source.indexOf('= L(() => {', initDeclStart)
  const initBlock = initCallStart === -1 ? null : readBalancedBlock(source, initCallStart + 2)
  const exportMatches = [...(exportBlock ?? '').matchAll(/([A-Za-z_$][\w$]*)\s*:\s*\(\)\s*=>/g)]
  const deps = [...(initBlock ?? '').matchAll(/([A-Za-z_$][\w$]*)\(\);/g)]
    .map(match => match[1])
    .filter(name => name !== 'L')
  return {
    exportBlock: exportBlock ? normalizeSnippet(exportBlock) : '',
    initBlock: initBlock ? normalizeSnippet(initBlock) : '',
    exports: [...new Set(exportMatches.map(match => match[1]))],
    dependencies: [...new Set(deps)],
    offset: exportObjectStart,
  }
}

export function extractComputerUseEvidence(source, options = {}) {
  const symbols = options.symbols ?? defaultSymbols
  const neighborhoods = symbolNeighborhoods(source, symbols, options.contextBytes ?? 320)
  const clusters = []
  for (const item of neighborhoods) {
    const cluster = findBundlerModuleAt(source, item.offset)
    if (!cluster) continue
    const key = `${cluster.offset}:${cluster.exports.join(',')}`
    if (!clusters.some(existing => `${existing.offset}:${existing.exports.join(',')}` === key)) {
      clusters.push(cluster)
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    symbols: neighborhoods,
    moduleClusters: clusters,
    exportCandidates: clusters.map(cluster => ({
      offset: cluster.offset,
      exports: cluster.exports,
      dependencies: cluster.dependencies,
    })),
  }
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const projectRoot = resolve(scriptDir, '..')
  const bundlePath = process.argv[2] ?? resolve(projectRoot, 'recover', 'claude-v2.1.165.js')
  const outputRoot = resolve(projectRoot, '.claude', 'computer-use-deobfuscation')
  if (!existsSync(bundlePath)) {
    throw new Error(`Bundle not found: ${bundlePath}`)
  }
  await mkdir(outputRoot, { recursive: true })
  const source = await readFile(bundlePath, 'utf8')
  const evidence = extractComputerUseEvidence(source)
  await writeFile(resolve(outputRoot, 'computer-use-module-clusters.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  await writeFile(
    resolve(outputRoot, 'computer-use-symbol-neighborhoods.txt'),
    evidence.symbols.map(item => `# ${item.symbol} @ ${item.offset}\n${item.context}\n`).join('\n'),
  )
  await writeFile(
    resolve(outputRoot, 'computer-use-export-candidates.json'),
    `${JSON.stringify(evidence.exportCandidates, null, 2)}\n`,
  )
  console.log(`computer-use deobfuscation output: ${outputRoot}`)
  console.log(`symbols: ${evidence.symbols.length}`)
  console.log(`clusters: ${evidence.moduleClusters.length}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}
```

- [ ] **Step 4: 在 `package.json` 中加入脚本入口**

```json
{
  "scripts": {
    "computer-use:deobfuscate": "node ./scripts/computer-use-deobfuscator.mjs",
    "computer-use:deobfuscate:test": "node ./scripts/computer-use-deobfuscator.test.mjs"
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node ./scripts/computer-use-deobfuscator.test.mjs`

Expected: PASS，输出 `computer-use-deobfuscator.test.mjs passed`

- [ ] **Step 6: 在真实 bundle 上跑一次脚本**

Run: `node ./scripts/computer-use-deobfuscator.mjs ./recover/claude-v2.1.165.js`

Expected: 生成：
- `.claude/computer-use-deobfuscation/computer-use-module-clusters.json`
- `.claude/computer-use-deobfuscation/computer-use-symbol-neighborhoods.txt`
- `.claude/computer-use-deobfuscation/computer-use-export-candidates.json`

- [ ] **Step 7: Commit**

```bash
git add package.json scripts/computer-use-deobfuscator.mjs scripts/computer-use-deobfuscator.test.mjs
git commit -m "feat: add computer use deobfuscation tooling"
```

---

### Task 2: 落地 `@ant/computer-use-mcp` 本地 workspace 包骨架

**Files:**
- Create: `packages/ant-computer-use-mcp/package.json`
- Create: `packages/ant-computer-use-mcp/src/index.ts`
- Create: `packages/ant-computer-use-mcp/src/types.ts`
- Create: `packages/ant-computer-use-mcp/src/sentinelApps.ts`
- Create: `packages/ant-computer-use-mcp/src/coordinates.ts`
- Create: `packages/ant-computer-use-mcp/src/toolDefinitions.ts`
- Create: `packages/ant-computer-use-mcp/src/server.ts`
- Create: `packages/ant-computer-use-mcp/src/session.ts`

- [ ] **Step 1: 写最小类型与导出面的 failing test（静态导入验证）**

Create `packages/ant-computer-use-mcp/src/index.ts` test harness snippet in a temporary local command target by importing all expected symbols:

```ts
import {
  API_RESIZE_PARAMS,
  DEFAULT_GRANT_FLAGS,
  bindSessionContext,
  buildComputerUseTools,
  createComputerUseMcpServer,
  targetImageSize,
} from '@ant/computer-use-mcp'
import { getSentinelCategory } from '@ant/computer-use-mcp/sentinelApps'
import type {
  CoordinateMode,
  CuPermissionRequest,
  CuPermissionResponse,
} from '@ant/computer-use-mcp/types'

void API_RESIZE_PARAMS
void DEFAULT_GRANT_FLAGS
void bindSessionContext
void buildComputerUseTools
void createComputerUseMcpServer
void targetImageSize
void getSentinelCategory
void (null as CoordinateMode | null)
void (null as CuPermissionRequest | null)
void (null as CuPermissionResponse | null)
```

- [ ] **Step 2: 建立 package manifest**

```json
{
  "name": "@ant/computer-use-mcp",
  "private": true,
  "version": "0.0.0-local",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./types": "./src/types.ts",
    "./sentinelApps": "./src/sentinelApps.ts"
  }
}
```

- [ ] **Step 3: 写最小类型文件**

```ts
export type CoordinateMode = 'pixels' | 'absolute' | 'relative'

export type CuSubGates = {
  pixelValidation: boolean
  clipboardPasteMultiline: boolean
  mouseAnimation: boolean
  hideBeforeAction: boolean
  autoTargetDisplay: boolean
  clipboardGuard: boolean
}

export type CuGrantFlags = {
  clipboardRead: boolean
  clipboardWrite: boolean
  systemKeyCombos: boolean
}

export type AppGrant = {
  bundleId: string
  displayName: string
  grantedAt: number
}

export type ScreenshotDims = {
  width: number
  height: number
  displayWidth?: number
  displayHeight?: number
  displayId?: number
  originX?: number
  originY?: number
}

export type CuPermissionRequest = {
  toolName: string
  input: Record<string, unknown>
  reason?: string
  apps: Array<{
    requestedName: string
    alreadyGranted?: boolean
    resolved?: { bundleId: string; displayName: string }
  }>
  requestedFlags: CuGrantFlags
  tccState?: { accessibility: boolean; screenRecording: boolean }
  willHide?: string[]
}

export type CuPermissionResponse = {
  behavior?: 'allow' | 'deny'
  granted: AppGrant[]
  denied: Array<{ bundleId: string; reason: 'user_denied' | 'not_installed' }>
  flags: CuGrantFlags
}

export type Logger = {
  silly(message: string, ...args: unknown[]): void
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

export type ComputerExecutor = {
  capabilities: Record<string, unknown>
  listInstalledApps?: () => Promise<Array<{ bundleId: string; displayName: string; path?: string }>>
}

export type ComputerUseHostAdapter = {
  serverName: string
  logger: Logger
  executor: ComputerExecutor
  ensureOsPermissions?: () => Promise<unknown>
  isDisabled: () => boolean
  getSubGates?: () => CuSubGates
  getAutoUnhideEnabled?: () => boolean
  cropRawPatch?: (...args: unknown[]) => unknown
}

export type ComputerUseSessionContext = {
  getAllowedApps: () => AppGrant[]
  getGrantFlags: () => CuGrantFlags
  getUserDeniedBundleIds: () => string[]
  getSelectedDisplayId: () => number | undefined
  getDisplayPinnedByModel: () => boolean
  getDisplayResolvedForApps: () => string | undefined
  getLastScreenshotDims: () => ScreenshotDims | undefined
  onPermissionRequest: (req: CuPermissionRequest, signal?: AbortSignal) => Promise<CuPermissionResponse>
  onAllowedAppsChanged: (apps: AppGrant[], flags: CuGrantFlags) => void
  onAppsHidden: (ids: string[]) => void
  onResolvedDisplayUpdated: (id: number | undefined) => void
  onDisplayPinned: (id: number | undefined) => void
  onDisplayResolvedForApps: (key: string | undefined) => void
  onScreenshotCaptured: (dims: ScreenshotDims) => void
  checkCuLock: () => Promise<{ holder: string | undefined; isSelf: boolean }>
  acquireCuLock: () => Promise<void>
  formatLockHeldMessage: (holder: string) => string
}

export type CuCallToolResult = {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType?: string }
  >
  telemetry?: { error_kind?: string }
}
```

- [ ] **Step 4: 写常量、sentinel 分类与最小 runtime**

```ts
// src/coordinates.ts
export const API_RESIZE_PARAMS = { width: 1366, height: 768 }

export function targetImageSize(width: number, height: number) {
  const scale = Math.min(API_RESIZE_PARAMS.width / width, API_RESIZE_PARAMS.height / height, 1)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}
```

```ts
// src/sentinelApps.ts
const SENTINELS: Record<string, 'shell' | 'filesystem' | 'system_settings'> = {
  'com.apple.Terminal': 'shell',
  'com.googlecode.iterm2': 'shell',
  'com.apple.finder': 'filesystem',
  'com.apple.systempreferences': 'system_settings',
}

export function getSentinelCategory(appName: string) {
  return SENTINELS[appName]
}
```

```ts
// src/toolDefinitions.ts
import type { CoordinateMode } from './types.js'

export function buildComputerUseTools(
  capabilities: Record<string, unknown>,
  coordinateMode: CoordinateMode,
  installedAppNames: string[] = [],
) {
  return [
    {
      name: 'request_access',
      description: `Request computer-use access (${coordinateMode})${installedAppNames.length ? ` for apps like ${installedAppNames.slice(0, 5).join(', ')}` : ''}`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      capabilities,
    },
  ]
}
```

```ts
// src/server.ts
export function createComputerUseMcpServer(adapter: { isDisabled: () => boolean }) {
  const handlers = new Map()
  return {
    setRequestHandler(schema: unknown, handler: unknown) {
      handlers.set(schema, handler)
    },
    async connect(_transport: unknown) {
      return { connected: !adapter.isDisabled(), handlers: handlers.size }
    },
  }
}
```

```ts
// src/session.ts
import { DEFAULT_GRANT_FLAGS } from './index.js'
import type {
  ComputerUseHostAdapter,
  ComputerUseSessionContext,
  CuCallToolResult,
} from './types.js'

export function bindSessionContext(
  _adapter: ComputerUseHostAdapter,
  _coordinateMode: unknown,
  ctx: ComputerUseSessionContext,
) {
  return async function dispatch(name: string, args: unknown): Promise<CuCallToolResult> {
    if (name === 'request_access') {
      const response = await ctx.onPermissionRequest(
        typeof args === 'object' && args !== null
          ? ({
              toolName: 'request_access',
              input: args as Record<string, unknown>,
              apps: [],
              requestedFlags: DEFAULT_GRANT_FLAGS,
            } as any)
          : ({
              toolName: 'request_access',
              input: {},
              apps: [],
              requestedFlags: DEFAULT_GRANT_FLAGS,
            } as any),
      )
      return {
        content: [{ type: 'text', text: JSON.stringify(response) }],
      }
    }
    return {
      content: [{ type: 'text', text: `computer-use placeholder: ${name}` }],
    }
  }
}
```

```ts
// src/index.ts
export const DEFAULT_GRANT_FLAGS = {
  clipboardRead: false,
  clipboardWrite: false,
  systemKeyCombos: false,
}

export { API_RESIZE_PARAMS, targetImageSize } from './coordinates.js'
export { getSentinelCategory } from './sentinelApps.js'
export { buildComputerUseTools } from './toolDefinitions.js'
export { createComputerUseMcpServer } from './server.js'
export { bindSessionContext } from './session.js'
export type * from './types.js'
```

- [ ] **Step 5: 运行静态导入验证**

Run: `node -e "import('@ant/computer-use-mcp').then(m=>console.log(Object.keys(m).sort().join(',')))"`

Expected: 输出包含：
- `API_RESIZE_PARAMS`
- `DEFAULT_GRANT_FLAGS`
- `bindSessionContext`
- `buildComputerUseTools`
- `createComputerUseMcpServer`
- `targetImageSize`

- [ ] **Step 6: Commit**

```bash
git add packages/ant-computer-use-mcp
git commit -m "feat: add local computer use mcp package skeleton"
```

---

### Task 3: 接入 workspace、TypeScript paths 与 build resolver

**Files:**
- Modify: `pnpm-workspace.yaml`
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `scripts/build.mjs`

- [ ] **Step 1: 写 failing verification（证明当前 build 仍把包打到 missing stub）**

Run: `rg -n "@ant/computer-use-mcp|missing-module" scripts/build.mjs`

Expected: 能看到 `@ant/` 在 `unavailablePackagePrefixes` 下统一走 stub，说明还未接入真实包解析。

- [ ] **Step 2: 将 workspace 范围扩到 `packages/*`**

```yaml
packages:
  - 'packages/*'

allowBuilds:
  esbuild: true
  isolated-vm: false
  protobufjs: true
  sharp: true
```

- [ ] **Step 3: 在根 `package.json` 声明本地依赖**

```json
{
  "dependencies": {
    "@ant/computer-use-mcp": "workspace:*"
  }
}
```

- [ ] **Step 4: 在 `tsconfig.json` 加 paths**

```json
{
  "compilerOptions": {
    "paths": {
      "src/*": ["./src/*"],
      "@ant/computer-use-mcp": ["./packages/ant-computer-use-mcp/src/index.ts"],
      "@ant/computer-use-mcp/*": ["./packages/ant-computer-use-mcp/src/*"]
    }
  },
  "include": [
    "src",
    "vendor",
    "scripts",
    "types",
    "packages"
  ]
}
```

- [ ] **Step 5: 修改 `scripts/build.mjs`，为 `@ant/computer-use-mcp` 加真实解析特例**

```js
const localAntPackageMap = new Map([
  ['@ant/computer-use-mcp', path.join(projectDir, 'packages/ant-computer-use-mcp', 'src', 'index.ts')],
])
```

```js
pluginBuild.onResolve({ filter: /^[^./@#]|^\@/ }, args => {
  if (builtinSet.has(args.path)) {
    return { path: args.path, external: true }
  }

  if (localAntPackageMap.has(args.path)) {
    return { path: localAntPackageMap.get(args.path) }
  }

  for (const [pkgName, pkgEntry] of localAntPackageMap.entries()) {
    if (args.path.startsWith(`${pkgName}/`)) {
      const subpath = args.path.slice(pkgName.length + 1)
      return {
        path: path.join(path.dirname(pkgEntry), `${subpath}.ts`),
      }
    }
  }

  if (
    unavailablePackagePrefixes.some(prefix => args.path === prefix || args.path.startsWith(prefix))
  ) {
    return { path: missingModuleStubPath }
  }

  return null
})
```

并把 `@ant/computer-use-mcp` 从统一 stub 前缀策略中排除：

```js
const unavailablePackagePrefixes = [
  'audio-capture-napi',
  'audio-capture.node',
  'image-processor-napi',
  'modifiers-napi',
  'url-handler-napi',
  '@ant/computer-use-input',
  '@ant/computer-use-swift',
  '@ant/claude-for-chrome-mcp',
]
```

- [ ] **Step 6: 安装/刷新 workspace 依赖**

Run: `pnpm install`

Expected: lockfile 更新，本地 workspace 依赖可被解析。

- [ ] **Step 7: 验证 resolver 生效**

Run: `node -e "import('./scripts/build.mjs').catch(err=>{console.error(err);process.exit(1)})"`

Expected: 不再因为 `@ant/computer-use-mcp` 被 missing-module stub 吃掉而失败；若失败，应是更具体的源码问题而非解析问题。

- [ ] **Step 8: Commit**

```bash
git add pnpm-workspace.yaml package.json tsconfig.json scripts/build.mjs pnpm-lock.yaml
git commit -m "build: resolve local computer use mcp package"
```

---

### Task 4: 收缩旧的 `@ant/computer-use-mcp` 占位声明

**Files:**
- Modify: `types/ant-modules.d.ts`

- [ ] **Step 1: 写 failing verification（检查旧声明仍覆盖新包）**

Run: `rg -n "declare module '@ant/computer-use-mcp|declare module '@ant/computer-use-mcp/types|declare module '@ant/computer-use-mcp/sentinelApps'" types/ant-modules.d.ts`

Expected: 能看到三段旧声明仍存在。

- [ ] **Step 2: 删除本地化后的三段声明，仅保留未本地化模块**

目标是把以下声明移除：

```ts
declare module '@ant/computer-use-mcp' {
  // ...
}

declare module '@ant/computer-use-mcp/types' {
  // ...
}

declare module '@ant/computer-use-mcp/sentinelApps' {
  // ...
}
```

保留：
- `@ant/computer-use-input`
- `@ant/computer-use-swift`
- `@ant/claude-for-chrome-mcp`

- [ ] **Step 3: 验证类型解析来自新包**

Run: `pnpm exec tsc --noEmit`

Expected: 不再依赖 `types/ant-modules.d.ts` 中的 `@ant/computer-use-mcp*` 声明才能通过解析；如有错误，应聚焦到新包类型定义缺项。

- [ ] **Step 4: Commit**

```bash
git add types/ant-modules.d.ts packages/ant-computer-use-mcp/src/types.ts
git commit -m "refactor: source computer use mcp types from local package"
```

---

### Task 5: 构建与端到端验证

**Files:**
- Verify only: no new source files required

- [ ] **Step 1: 运行 deobfuscator 自测**

Run: `node ./scripts/computer-use-deobfuscator.test.mjs`

Expected: PASS。

- [ ] **Step 2: 运行真实 deobfuscation 脚本**

Run: `node ./scripts/computer-use-deobfuscator.mjs ./recover/claude-v2.1.165.js`

Expected: `.claude/computer-use-deobfuscation/` 下生成三个证据文件。

- [ ] **Step 3: 运行 TypeScript 检查**

Run: `pnpm exec tsc --noEmit`

Expected: PASS；若失败，仅允许是本轮新包导出/类型缺项并应先修复后继续。

- [ ] **Step 4: 按项目要求执行构建**

Run: `CLAUDE_CODE_VERSION=2.1.165-dev pnpm build`

Expected: PASS，输出 `dist/cli.js`，且 build resolver 不再把 `@ant/computer-use-mcp` 降级为 missing stub。

- [ ] **Step 5: 做最小运行验证**

Run: `node ./dist/cli.js --version`

Expected: 输出 `2.1.165-dev (Claude Code)`。

- [ ] **Step 6: 验证 computer-use fast path 至少能解析入口**

Run: `node ./dist/cli.js --computer-use-mcp`

Expected: 允许因为环境/stdio 生命周期退出，但不应出现 `Cannot find module '@ant/computer-use-mcp'` 或直接命中 `missingRecoveredModule` 的错误。

- [ ] **Step 7: 检查工作区差异并整理证据**

Run: `git status --short`

Expected: 仅包含本计划涉及的脚本、workspace 包、构建配置和类型调整。

- [ ] **Step 8: Final commit**

```bash
git add .
git commit -m "feat: extract local computer use mcp analysis and package skeleton"
```

---

## Self-review checklist
- 本计划覆盖了两条主线：recover 模块分析脚本 + 本地 workspace 包骨架与解析接入。
- 未把 `executor.ts`、`hostAdapter.ts`、`wrapper.tsx` 等 CLI 宿主逻辑强行迁入包内，保持边界清晰。
- 所有命令均使用 `pnpm`，符合仓库约束。
- 构建验证使用项目要求的 `CLAUDE_CODE_VERSION=2.1.165-dev pnpm build`。
