// Read-only control requests a host app (the VS Code extension, Desktop)
// sends to draw its own /status, /usage, /export and @-mention widgets.
import stripAnsi from 'strip-ansi'
import {
  getModelUsage,
  getPlanSlugCache,
  getSessionId,
  getTotalAPIDuration,
  getTotalCostUSD,
  getTotalDuration,
  getTotalLinesAdded,
  getTotalLinesRemoved,
} from '../bootstrap/state.js'
import { getDefaultExportFilename } from '../commands/export/export.js'
import {
  buildDiagnostics,
  buildPrimarySection,
  buildSecondarySection,
  buildStatusUsage,
} from '../components/Settings/Status.js'
import { formatTotalCost } from '../cost-tracker.js'
import { generateFileSuggestions } from '../hooks/fileSuggestions.js'
import {
  fetchUtilization,
  getModelScopedUsageLimits,
  type RateLimit,
  type Utilization,
} from '../services/api/usage.js'
import type { AppState } from '../state/AppState.js'
import type { Tools } from '../Tool.js'
import type { Message } from '../types/message.js'
import { getSubscriptionType } from '../utils/auth.js'
import { getCwd } from '../utils/cwd.js'
import { renderMessagesToPlainText } from '../utils/exportRenderer.js'
import { getPlan, getPlanFilePath } from '../utils/plans.js'
import { renderToString } from '../utils/staticRender.js'
import type { Diagnostic, Property } from '../utils/status.js'

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
