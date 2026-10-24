import { createReadStream } from 'fs'
import { readdir, stat } from 'fs/promises'
import uniqBy from 'lodash-es/uniqBy.js'
import { join } from 'path'
import { createInterface } from 'readline'
import { getProjectRoot, getSdkBetas } from '../../bootstrap/state.js'
import {
  type Command,
  getMcpSkillCommands,
  getSkillToolCommands,
} from '../../commands.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { roughTokenCountEstimation } from '../../services/tokenEstimation.js'
import { formatCommandsWithinBudget } from '../../tools/SkillTool/prompt.js'
import type { LocalJSXCommandContext } from '../../types/command.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { formatTokens } from '../../utils/format.js'
import { getProjectsDir } from '../../utils/sessionStorage.js'
import { plural } from '../../utils/stringUtils.js'

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS

export type SkillDoctorRow = {
  name: string
  source: string
  owner: 'settings' | 'plugin' | 'mcp'
  pluginKey?: string
  usageCount: number
  daysSinceUse: number | null
  listingTokens: number | null
  weekTokens: number | null
}

type SkillUsage = Record<string, { usageCount: number; lastUsedAt: number }>

/** Tokens each skill's one-line entry costs in the skill listing, keyed by name. */
export function getListingTokens(
  listed: Command[],
  contextWindowTokens: number,
): Map<string, number> {
  const tokens = new Map<string, number>()
  if (listed.length === 0) return tokens
  // formatCommandsWithinBudget emits one line per command in name order.
  const sorted = [...listed].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )
  const lines = formatCommandsWithinBudget(listed, contextWindowTokens).split('\n')
  sorted.forEach((cmd, i) => {
    const line = lines[i]
    if (line !== undefined) tokens.set(cmd.name, roughTokenCountEstimation(line))
  })
  return tokens
}

export function collectSkillRows(
  commands: readonly Command[],
  listingTokens: Map<string, number>,
  usage: SkillUsage,
  now: number,
  weekTokens: Map<string, number> = new Map(),
): SkillDoctorRow[] {
  const rows: SkillDoctorRow[] = []
  for (const cmd of uniqBy(commands, 'name')) {
    // Workflows are listed as prompt commands but are not skills.
    if (cmd.type !== 'prompt' || cmd.kind === 'workflow') continue
    if (
      cmd.source === 'bundled' ||
      cmd.source === 'builtin' ||
      cmd.source === 'policySettings'
    ) {
      continue
    }
    if (cmd.source === 'mcp' && cmd.loadedFrom !== 'mcp') continue
    const used = usage[cmd.name]
    rows.push({
      name: cmd.name,
      source: cmd.pluginInfo ? cmd.pluginInfo.pluginManifest.name : cmd.source,
      owner:
        cmd.source === 'plugin' ? 'plugin' : cmd.source === 'mcp' ? 'mcp' : 'settings',
      pluginKey: cmd.pluginInfo?.pluginManifest.name,
      usageCount: used?.usageCount ?? 0,
      daysSinceUse: used ? Math.floor((now - used.lastUsedAt) / DAY_MS) : null,
      listingTokens: listingTokens.get(cmd.name) ?? null,
      // Responses are stamped with getSkillAttributionName(): the unqualified name.
      weekTokens: weekTokens.get(cmd.unqualifiedName ?? cmd.name) ?? weekTokens.get(cmd.name) ?? null,
    })
  }
  // Never-used first, then least recently used.
  rows.sort(
    (a, b) =>
      (b.daysSinceUse ?? Infinity) - (a.daysSinceUse ?? Infinity) ||
      a.name.localeCompare(b.name),
  )
  return rows
}

function padEnd(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - stringWidth(text)))
}

function padStart(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - stringWidth(text))) + text
}

function formatListingTokens(tokens: number): string {
  return tokens < 20 ? '< 20' : `~${formatTokens(Math.round(tokens / 10) * 10)}`
}

function formatTable(rows: SkillDoctorRow[]): string {
  if (rows.length === 0) return '  (no skills loaded)'
  const cells = rows.map(row => ({
    context: row.listingTokens === null ? '-' : formatListingTokens(row.listingTokens),
    week: row.weekTokens === null ? '-' : formatTokens(row.weekTokens),
    uses: String(row.usageCount),
    lastUsed:
      row.daysSinceUse === null
        ? 'never'
        : row.daysSinceUse === 0
          ? 'today'
          : `${row.daysSinceUse} ${plural(row.daysSinceUse, 'day')}`,
  }))
  const width = {
    name: Math.max(5, ...rows.map(r => stringWidth(r.name))),
    source: Math.max(6, ...rows.map(r => stringWidth(r.source))),
    context: Math.max(7, ...cells.map(c => stringWidth(c.context))),
    week: Math.max(9, ...cells.map(c => stringWidth(c.week))),
    uses: Math.max(4, ...cells.map(c => stringWidth(c.uses))),
  }
  const header = `  ${padEnd('skill', width.name)}  ${padEnd('source', width.source)}  ${padStart('context', width.context)}  ${padStart('7d tokens', width.week)}  ${padStart('uses', width.uses + 1)}  last used`
  const lines = rows.map((row, i) => {
    const cell = cells[i]!
    return `  ${padEnd(row.name, width.name)}  ${padEnd(row.source, width.source)}  ${padStart(cell.context, width.context)}  ${padStart(cell.week, width.week)}  ${padStart(cell.uses, width.uses)}×  ${cell.lastUsed}`
  })
  return [header, ...lines].join('\n')
}

function mcpServerOf(row: SkillDoctorRow): string | undefined {
  const colon = row.name.indexOf(':')
  return colon > 0 ? row.name.slice(0, colon) : undefined
}

export function formatSkillDoctorReport(rows: SkillDoctorRow[]): string {
  const out = ['Skills loaded this session', '', formatTable(rows)]
  if (rows.length > 0) {
    out.push(
      '',
      "  context = this skill's one-line listing in the system prompt, included every turn",
      '  (dash = not in the current listing, costs nothing; full SKILL.md loads only when it runs)',
      '  7d tokens = tokens attributed to the skill over the last 7 days of sessions on this machine',
    )
  }
  out.push('')

  const unused = rows.filter(r => r.usageCount === 0 && r.listingTokens !== null)
  const owned = unused.filter(r => r.owner === 'settings')
  if (owned.length > 0) {
    out.push(
      `${owned.length} ${plural(owned.length, 'skill')} loaded but never invoked. Each one adds to the system prompt every turn. Disable in /skills, or remove from .claude/skills.`,
    )
  }

  const usedPlugins = new Set(
    rows.filter(r => r.usageCount > 0 && r.pluginKey !== undefined).map(r => r.pluginKey),
  )
  const fromPlugins = unused.filter(
    r => r.owner === 'plugin' && (r.pluginKey === undefined || !usedPlugins.has(r.pluginKey)),
  )
  if (fromPlugins.length > 0) {
    const plugins = [...new Set(fromPlugins.map(r => r.source))]
    out.push(
      `${fromPlugins.length} plugin ${plural(fromPlugins.length, 'skill')} loaded but never invoked, from ${plugins.join(', ')}. Each one adds to the system prompt every turn. Plugin skills can't be turned off individually — disable ${plugins.length === 1 ? 'the plugin' : 'those plugins'} in /plugin.`,
    )
  }

  const usedServers = new Set(
    rows.filter(r => r.owner === 'mcp' && r.usageCount > 0).map(mcpServerOf),
  )
  const fromMcp = unused.filter(r => {
    if (r.owner !== 'mcp') return false
    const server = mcpServerOf(r)
    return server === undefined || !usedServers.has(server)
  })
  if (fromMcp.length > 0) {
    const servers = [
      ...new Set(fromMcp.map(mcpServerOf).filter(s => s !== undefined)),
    ]
    const one = servers.length <= 1
    out.push(
      `${fromMcp.length} MCP ${plural(fromMcp.length, 'skill')} loaded but never invoked${servers.length > 0 ? `, from ${servers.join(', ')}` : ''}. Each one adds to the system prompt every turn. MCP skills live on the server, not on disk — turning ${one ? 'that server' : 'those servers'} off in /mcp also removes ${one ? 'its' : 'their'} tools.`,
    )
  }

  if (rows.length > 0 && rows.every(r => r.usageCount > 0)) {
    out.push('All loaded skills have been used at least once.')
  }
  return out.join('\n').trimEnd()
}

/** Lists the transcripts (subagents' included) written since `since`. */
async function recentTranscripts(projectsDir: string, since: number): Promise<string[]> {
  const files: string[] = []
  const addIfRecent = async (path: string) => {
    const info = await stat(path).catch(() => null)
    if (info?.isFile() && info.mtimeMs >= since) files.push(path)
  }
  for (const project of await readdir(projectsDir).catch(() => [])) {
    const dir = join(projectsDir, project)
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        await addIfRecent(join(dir, entry.name))
      } else if (entry.isDirectory()) {
        const subagents = join(dir, entry.name, 'subagents')
        for (const rel of await readdir(subagents, { recursive: true }).catch(() => [])) {
          if (rel.endsWith('.jsonl')) await addIfRecent(join(subagents, rel))
        }
      }
    }
  }
  return files
}

/**
 * Tokens attributed to each skill (input, cache and output of the responses
 * stamped with `attributionSkill`) over the last 7 days of transcripts.
 */
export async function getWeekSkillTokens(projectsDir: string, now: number): Promise<Map<string, number>> {
  const since = now - WEEK_MS
  // A response is recorded once per content block; count each message once.
  const byMessage = new Map<string, { skill: string; tokens: number }>()
  for (const file of await recentTranscripts(projectsDir, since)) {
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    for await (const line of lines) {
      if (!line.includes('"attributionSkill":"')) continue
      let record: { type?: string; uuid?: string; timestamp?: string; attributionSkill?: string; message?: { id?: string; usage?: Record<string, number> } }
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      const usage = record.message?.usage
      if (record.type !== 'assistant' || !record.attributionSkill || !usage) continue
      if (Date.parse(record.timestamp ?? '') < since) continue
      const tokens =
        (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.output_tokens ?? 0)
      const key = record.message?.id ?? record.uuid ?? line
      const seen = byMessage.get(key)
      if (!seen || tokens > seen.tokens) byMessage.set(key, { skill: record.attributionSkill, tokens })
    }
  }
  const totals = new Map<string, number>()
  for (const { skill, tokens } of byMessage.values()) totals.set(skill, (totals.get(skill) ?? 0) + tokens)
  return totals
}

export async function buildSkillDoctorReport(
  context: Pick<LocalJSXCommandContext, 'options' | 'getAppState'>,
): Promise<string> {
  const mcpCommands = context.getAppState().mcp.commands
  const localSkills = await getSkillToolCommands(getProjectRoot())
  const listed = uniqBy(
    [...localSkills, ...getMcpSkillCommands(mcpCommands)],
    'name',
  )
  const listingTokens = getListingTokens(
    listed,
    getContextWindowForModel(context.options.mainLoopModel, getSdkBetas()),
  )
  const now = Date.now()
  const rows = collectSkillRows(
    [...context.options.commands, ...mcpCommands],
    listingTokens,
    getGlobalConfig().skillUsage ?? {},
    now,
    await getWeekSkillTokens(getProjectsDir(), now),
  )
  return formatSkillDoctorReport(rows)
}
