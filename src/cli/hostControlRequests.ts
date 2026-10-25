// Read-only control requests a host app (the VS Code extension, Desktop)
// sends to draw its own /status, /usage, /memory, /skills, /hooks,
// /permissions, /diff, /export and @-mention widgets.
import { feature } from 'bun:bundle'
import { existsSync } from 'fs'
import { join } from 'path'
import stripAnsi from 'strip-ansi'
import {
  getModelUsage,
  getOriginalCwd,
  getPlanSlugCache,
  getSessionId,
  getTotalAPIDuration,
  getTotalCostUSD,
  getTotalDuration,
  getTotalLinesAdded,
  getTotalLinesRemoved,
} from '../bootstrap/state.js'
import { type Command, getCommandName } from '../commands.js'
import { getDefaultExportFilename } from '../commands/export/export.js'
import {
  buildDiagnostics,
  buildPrimarySection,
  buildSecondarySection,
  buildStatusUsage,
} from '../components/Settings/Status.js'
import { formatTotalCost } from '../cost-tracker.js'
import { generateFileSuggestions } from '../hooks/fileSuggestions.js'
import { scanMemoryFiles } from '../memdir/memoryScan.js'
import { getAutoMemPath, isAutoMemoryEnabled } from '../memdir/paths.js'
import {
  fetchUtilization,
  getModelScopedUsageLimits,
  type RateLimit,
  type Utilization,
} from '../services/api/usage.js'
import { isAutoDreamEnabled } from '../services/autoDream/config.js'
import { readLastConsolidatedAt } from '../services/autoDream/consolidationLock.js'
import { estimateSkillFrontmatterTokens } from '../skills/loadSkillsDir.js'
import type { AppState } from '../state/AppState.js'
import { isLocalShellTask } from '../tasks/LocalShellTask/guards.js'
import { getAgentMemoryDir } from '../tools/AgentTool/agentMemory.js'
import type { Tools } from '../Tool.js'
import type { Message } from '../types/message.js'
import { getSubscriptionType } from '../utils/auth.js'
import { clearMemoryFileCaches, getMemoryFiles } from '../utils/claudemd.js'
import { getCwd } from '../utils/cwd.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { renderMessagesToPlainText } from '../utils/exportRenderer.js'
import { tailFile } from '../utils/fsOperations.js'
import { formatRelativeTimeAgo } from '../utils/format.js'
import { fetchGitDiff, fetchGitDiffHunks } from '../utils/gitDiff.js'
import {
  getHookEventMetadata,
  getSortedMatchersForEvent,
  groupHooksByEventAndMatcher,
  type HookEventMetadata,
} from '../utils/hooks/hooksConfigManager.js'
import { getHookDisplayText, hookSourceDescriptionDisplayString } from '../utils/hooks/hooksSettings.js'
import { projectIsInGitRepo } from '../utils/memory/versions.js'
import { shouldAllowManagedPermissionRulesOnly } from '../utils/permissions/permissionsLoader.js'
import { getPlan, getPlanFilePath } from '../utils/plans.js'
import { getSettingSourceName } from '../utils/settings/constants.js'
import { getSettingsForSource } from '../utils/settings/settings.js'
import { renderToString } from '../utils/staticRender.js'
import type { Diagnostic, Property } from '../utils/status.js'
import { getTaskOutputPath } from '../utils/task/diskOutput.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPaths = feature('TEAMMEM')
  ? (require('../memdir/teamMemPaths.js') as typeof import('../memdir/teamMemPaths.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

// Wide enough that no status value wraps.
const STATUS_TEXT_COLUMNS = 400

async function toText(value: Property['value'] | Diagnostic): Promise<string> {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.join(', ')
  return (await renderToString(value, STATUS_TEXT_COLUMNS)).trim()
}

async function toRows(properties: Property[]) {
  return Promise.all(
    properties.map(async ({ label, value }) => ({
      ...(label === undefined ? {} : { label }),
      value: await toText(value),
    })),
  )
}

export async function buildStatusResponse(appState: AppState) {
  const [usage, diagnostics] = await Promise.all([
    buildStatusUsage(),
    buildDiagnostics(),
  ])
  const sections = [
    { title: 'Session', rows: await toRows(buildPrimarySection(usage)) },
    {
      title: 'Environment',
      rows: await toRows(
        buildSecondarySection({
          mainLoopModel: appState.mainLoopModel,
          mcp: appState.mcp,
          theme: 'dark',
          ideInstallationStatus: null,
        }),
      ),
    },
    {
      title: 'System Diagnostics',
      rows: await Promise.all(diagnostics.map(async d => ({ value: await toText(d) }))),
    },
  ]
  return { sections: sections.filter(section => section.rows.length > 0) }
}

const window = (limit: RateLimit | null | undefined) =>
  limit ? { utilization: limit.utilization, resets_at: limit.resets_at } : null

// ChatGPT reports its windows as primary/secondary; dev maps them onto
// seven_day/seven_day_sonnet for the Usage tab, so place them by length.
function chatGPTRateLimits(utilization: Utilization) {
  const windows = [utilization.seven_day, utilization.seven_day_sonnet].filter(
    (w): w is RateLimit => !!w,
  )
  const byMinutes = (minutes: number) =>
    window(windows.find(w => w.window_minutes === minutes))
  return {
    five_hour: byMinutes(300),
    seven_day: byMinutes(7 * 24 * 60),
    model_scoped: (utilization.chatgpt_limits ?? []).map(row => ({
      display_name: row.title,
      utilization: row.limit.utilization,
      resets_at: row.limit.resets_at,
    })),
  }
}

function claudeRateLimits(utilization: Utilization) {
  return {
    five_hour: window(utilization.five_hour),
    seven_day: window(utilization.seven_day),
    seven_day_oauth_apps: window(utilization.seven_day_oauth_apps),
    seven_day_opus: window(utilization.seven_day_opus),
    seven_day_sonnet: window(utilization.seven_day_sonnet),
    ...(utilization.limits
      ? {
          model_scoped: getModelScopedUsageLimits(utilization.limits).map(row => ({
            display_name: row.title,
            utilization: row.limit.utilization,
            resets_at: row.limit.resets_at,
          })),
        }
      : {}),
    extra_usage: utilization.extra_usage ?? null,
  }
}

export async function buildUsageResponse() {
  let utilization: Utilization | null = null
  try {
    utilization = await fetchUtilization()
  } catch {
    utilization = null
  }
  const isChatGPT = utilization?.source === 'chatgpt'
  return {
    session: {
      total_cost_usd: getTotalCostUSD(),
      total_api_duration_ms: getTotalAPIDuration(),
      total_duration_ms: getTotalDuration(),
      total_lines_added: getTotalLinesAdded(),
      total_lines_removed: getTotalLinesRemoved(),
      model_usage: getModelUsage(),
    },
    subscription_type: isChatGPT
      ? (utilization?.plan_type ?? null)
      : getSubscriptionType(),
    rate_limits_available: utilization !== null,
    rate_limits: utilization
      ? isChatGPT
        ? chatGPTRateLimits(utilization)
        : claudeRateLimits(utilization)
      : null,
    // dev has no local transcript behavior scan.
    behaviors: null,
  }
}

export function buildSessionCostResponse() {
  return { text: stripAnsi(formatTotalCost()) }
}

export function buildBinaryVersionResponse() {
  return {
    version: MACRO.VERSION,
    ...(MACRO.BUILD_TIME ? { buildTime: MACRO.BUILD_TIME } : {}),
  }
}

export async function buildFileSuggestionsResponse(query: string) {
  const items = await generateFileSuggestions(query, true)
  return {
    suggestions: items.map(item => {
      const score = (item.metadata as { score?: number } | undefined)?.score
      return {
        path: item.displayText,
        ...(typeof score === 'number' ? { score } : {}),
      }
    }),
    cwd: getCwd(),
  }
}

export function buildPlanResponse() {
  // Never mint a slug: a session that has not planned has none cached.
  if (!getPlanSlugCache().has(getSessionId())) return { exists: false }
  const content = getPlan()
  return content === null
    ? { exists: false }
    : { exists: true, content, path: getPlanFilePath() }
}

export async function buildExportConversationResponse(
  messages: Message[],
  tools: Tools,
) {
  return {
    text: await renderMessagesToPlainText(messages, tools),
    default_filename: getDefaultExportFilename(messages),
  }
}

export async function buildMemoryDialogResponse(appState: AppState) {
  clearMemoryFileCaches()
  const loaded = (await getMemoryFiles()).filter(
    f => f.type !== 'AutoMem' && f.type !== 'TeamMem',
  )
  const userPath = join(getClaudeConfigHomeDir(), 'CLAUDE.md')
  const projectPath = join(getOriginalCwd(), 'CLAUDE.md')
  const projectAltPath = join(getOriginalCwd(), '.claude', 'CLAUDE.md')
  const isGit = projectIsInGitRepo(getOriginalCwd())
  const files = loaded.map(f => {
    const kind =
      f.path === userPath ? 'user'
        : f.path === projectPath ? 'project'
          : f.path === projectAltPath ? 'project-alt'
            : f.type === 'Local' ? 'local'
              : 'other'
    return { kind, path: f.path, parent: f.parent }
  })
  if (!files.some(f => f.kind === 'user')) files.unshift({ kind: 'user', path: userPath, parent: undefined })
  if (!files.some(f => f.kind === 'project')) {
    files.splice(1, 0, { kind: 'project', path: projectPath, parent: undefined })
  }
  const labels: Record<string, string> = {
    user: 'User instructions',
    project: 'Project instructions',
    'project-alt': 'Project instructions (.claude/CLAUDE.md)',
    local: 'Local instructions',
  }
  const descriptions: Record<string, string> = {
    user: 'Saved in ~/.claude/CLAUDE.md',
    project: `${isGit ? 'Checked in at' : 'Saved in'} ./CLAUDE.md`,
    'project-alt': `${isGit ? 'Checked in at' : 'Saved in'} ./.claude/CLAUDE.md`,
    local: 'Saved in ./CLAUDE.local.md',
  }

  const autoMemoryOn = isAutoMemoryEnabled()
  const folders: { kind: 'auto' | 'team' | 'agent'; path: string; label: string; description: string }[] = []
  if (autoMemoryOn) {
    folders.push({ kind: 'auto', path: getAutoMemPath(), label: 'Open auto-memory folder', description: '' })
    if (feature('TEAMMEM') && teamMemPaths!.isTeamMemoryEnabled()) {
      folders.push({ kind: 'team', path: teamMemPaths!.getTeamMemPath(), label: 'Open team memory folder', description: '' })
    }
    for (const agent of appState.agentDefinitions.activeAgents) {
      if (agent.memory) {
        folders.push({
          kind: 'agent',
          path: getAgentMemoryDir(agent.agentType, agent.memory),
          label: `Open ${agent.agentType} agent memory`,
          description: `${agent.memory} scope`,
        })
      }
    }
  }

  let memories
  if (autoMemoryOn) {
    const dir = getAutoMemPath()
    const index = join(dir, 'MEMORY.md')
    const headers = await scanMemoryFiles(dir, new AbortController().signal)
    memories = [
      ...(existsSync(index)
        ? [{ name: 'MEMORY.md', path: index, description: null, type: null, modified_ms: 0 }]
        : []),
      ...headers.map(m => ({
        name: m.filename,
        path: m.filePath,
        description: m.description,
        type: m.type ?? null,
        modified_ms: m.mtimeMs,
      })),
    ]
  }

  const dreamRunning = Object.values(appState.tasks).some(
    t => t.type === 'dream' && t.status === 'running',
  )
  const lastDreamAt = autoMemoryOn && !dreamRunning ? await readLastConsolidatedAt() : null
  const dreamOn = isAutoDreamEnabled()
  return {
    files: files.map(f => ({
      kind: f.kind,
      path: f.path,
      label: labels[f.kind] ?? f.path,
      description: descriptions[f.kind] ?? (f.parent ? '@-imported' : ''),
      exists: existsSync(f.path),
    })),
    folders,
    ...(memories ? { memories } : {}),
    auto_memory: { enabled: autoMemoryOn, toggleable: true, status: autoMemoryOn ? 'on' : 'off' },
    auto_dream: {
      shown: autoMemoryOn,
      enabled: dreamOn,
      toggleable: autoMemoryOn,
      status: dreamOn ? 'on' : 'off',
      detail: dreamRunning
        ? 'running'
        : lastDreamAt === null
          ? ''
          : lastDreamAt === 0
            ? 'never'
            : `last ran ${formatRelativeTimeAgo(new Date(lastDreamAt))}`,
    },
  }
}

const SKILL_LOADERS = new Set(['skills', 'commands_DEPRECATED', 'plugin', 'mcp', 'codex_app'])

export function buildSkillsDialogResponse(commands: Command[]) {
  const skills = commands.filter(
    cmd => cmd.type === 'prompt' && SKILL_LOADERS.has(cmd.loadedFrom ?? ''),
  )
  const sourceLabel = (cmd: Command) =>
    cmd.type !== 'prompt' ? 'unknown'
      : cmd.loadedFrom === 'codex_app' ? 'codex app'
        : cmd.source === 'plugin' || cmd.source === 'mcp' || cmd.source === 'builtin' || cmd.source === 'bundled'
          ? cmd.source
          : getSettingSourceName(cmd.source)
  return {
    skills: skills
      .map(cmd => ({
        name: cmd.name,
        display_name: getCommandName(cmd),
        description: cmd.description,
        source: sourceLabel(cmd),
        tokens: cmd.type === 'prompt' ? estimateSkillFrontmatterTokens(cmd) : 0,
        state: cmd.disableModelInvocation ? 'user-invocable-only' : 'on',
        ...(cmd.disableModelInvocation
          ? { locked_by: 'author' }
          : cmd.type === 'prompt' && cmd.source === 'plugin'
            ? { locked_by: 'plugin' }
            : {}),
        advertised: cmd.userInvocable !== false && !cmd.isHidden,
        handles: {},
      }))
      .sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name)),
  }
}

const HOOK_CONTENT_LABELS: Record<string, string> = {
  command: 'Command',
  prompt: 'Prompt',
  agent: 'Prompt',
  http: 'URL',
}

export function buildHooksListingResponse(appState: AppState, toolNames: string[]) {
  const metadata: Record<string, HookEventMetadata> = getHookEventMetadata(toolNames)
  const grouped = groupHooksByEventAndMatcher(appState, toolNames)
  const eventCatalog = Object.entries(metadata).map(([name, m]) => ({
    name,
    summary: m.summary,
    supportsMatcher: m.matcherMetadata !== undefined,
  }))
  const hooks = eventCatalog.flatMap(({ name }) => {
    const event = name as keyof typeof grouped
    return getSortedMatchersForEvent(grouped, event).flatMap(matcher =>
      (grouped[event][matcher] ?? []).map(hook => {
        const config = hook.config as typeof hook.config & {
          timeout?: number
          statusMessage?: string
          once?: boolean
          async?: boolean
          if?: string
        }
        const commandText = getHookDisplayText({ ...config, statusMessage: undefined } as typeof config)
        return {
          event: name,
          matcher,
          source: hook.source,
          sourceLabel: hookSourceDescriptionDisplayString(hook.source),
          ...(hook.pluginName ? { pluginName: hook.pluginName } : {}),
          type: config.type,
          displayText: getHookDisplayText(config),
          commandText,
          contentLabel: HOOK_CONTENT_LABELS[config.type] ?? 'Command',
          ...(config.if ? { condition: config.if } : {}),
          ...(typeof config.timeout === 'number' ? { timeout: config.timeout } : {}),
          ...(config.statusMessage ? { statusMessage: config.statusMessage } : {}),
          ...(config.once ? { runsOnce: true } : {}),
          ...(config.async ? { runsInBackground: true } : {}),
        }
      }),
    )
  })
  const policy = getSettingsForSource('policySettings')
  const counts = new Map<string, number>()
  for (const hook of hooks) counts.set(hook.event, (counts.get(hook.event) ?? 0) + 1)
  return {
    events: eventCatalog
      .filter(e => counts.has(e.name))
      .map(e => ({ ...e, hookCount: counts.get(e.name)! })),
    hooks,
    eventCatalog,
    policy: {
      disabledByPolicy: policy?.disableAllHooks === true,
      managedOnly: policy?.allowManagedHooksOnly === true,
      pluginOnly: policy?.strictPluginOnlyCustomization !== undefined && policy?.strictPluginOnlyCustomization !== false,
      allDisabled: appState.settings.disableAllHooks === true,
      policyHookCount: Object.values(policy?.hooks ?? {}).flatMap(m => m ?? []).flatMap(m => m.hooks).length,
    },
    safeMode: null,
  }
}

const PERSISTENT_RULE_SOURCES = new Set(['userSettings', 'projectSettings', 'localSettings'])
const SESSION_RULE_SOURCES = new Set(['cliArg', 'session'])

export function buildPermissionRulesResponse(appState: AppState) {
  const context = appState.toolPermissionContext
  const managedOnly = shouldAllowManagedPermissionRulesOnly()
  const rules = (
    [
      ['allow', context.alwaysAllowRules],
      ['deny', context.alwaysDenyRules],
      ['ask', context.alwaysAskRules],
    ] as const
  ).flatMap(([behavior, bySource]) =>
    Object.entries(bySource).flatMap(([source, list]) =>
      (list ?? []).map(rule => ({
        behavior,
        source,
        rule,
        editability: PERSISTENT_RULE_SOURCES.has(source)
          ? 'persistent'
          : SESSION_RULE_SOURCES.has(source)
            ? 'session'
            : 'readonly',
      })),
    ),
  )
  return {
    state: {
      rules,
      workspaceDirectories: Array.from(
        context.additionalWorkingDirectories as unknown as ReadonlyMap<string, { source: string }>,
        ([path, dir]) => ({ path, source: dir.source }),
      ),
      originalCwd: getOriginalCwd(),
      managedOnly,
    },
  }
}

export async function buildWorkspaceDiffResponse() {
  const diff = await fetchGitDiff()
  if (!diff) return { diff: null }
  const hunks = await fetchGitDiffHunks()
  return {
    diff: {
      stats: diff.stats,
      perFileStats: [...diff.perFileStats].map(([path, stats]) => ({
        path,
        added: stats.added,
        removed: stats.removed,
        isBinary: stats.isBinary,
        isUntracked: stats.isUntracked === true,
      })),
      skippedLarge: [],
      restricted: [],
      source: { kind: 'working-tree' },
      hunks: [...hunks].map(([path, fileHunks]) => ({
        path,
        hunks: fileHunks.map(h => ({
          oldStart: h.oldStart,
          oldLines: h.oldLines,
          newStart: h.newStart,
          newLines: h.newLines,
          lines: h.lines,
        })),
      })),
    },
  }
}

const TASK_OUTPUT_TAIL_BYTES = 8 * 1024
// A shell task's id (generateTaskId with the local_bash prefix). An ended
// task leaves AppState, so its output stays readable by an id of this shape.
const SHELL_TASK_ID = /^b[0-9a-z]{8}$/

export async function buildTaskOutputResponse(appState: AppState, taskId: string) {
  const task = appState.tasks[taskId]
  if (task ? !isLocalShellTask(task) : !SHELL_TASK_ID.test(taskId)) {
    throw new Error('get_task_output: no shell or Monitor task with that task_id in this session')
  }
  try {
    const { content, bytesTotal, bytesRead } = await tailFile(
      getTaskOutputPath(taskId),
      TASK_OUTPUT_TAIL_BYTES,
    )
    return { output: content, total_bytes: bytesTotal, truncated: bytesTotal > bytesRead }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { output: '', total_bytes: 0, truncated: false }
    }
    throw error
  }
}
