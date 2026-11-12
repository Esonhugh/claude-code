/**
 * `/api/ext/*`: the data and actions behind the sidebar's Skills, Plugins,
 * Memory, Hooks, Mods, Channels and Stats dialogs. Everything runs in the
 * `claude web` process through the same modules as `/skills`, `/plugin`,
 * `claude plugin`, `/memory`, `/hooks` and `/stats`; nothing is shelled out.
 * Project scope is the web process's original cwd, which `claude web` sets to
 * its workspace. The browser names things (skill, plugin, hook position);
 * file paths are always looked up here, never taken from a request.
 */
import { createHash } from 'crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { basename, dirname, join, relative, resolve, sep } from 'path'
import { z } from 'zod/v4'
import { getOriginalCwd } from '../bootstrap/state.js'
import { type Command, clearCommandsCache, getCommandName, getCommands } from '../commands.js'
import { HOOK_EVENTS } from '../entrypoints/sdk/coreTypes.js'
import { scanMemoryFiles } from '../memdir/memoryScan.js'
import { getAutoMemPath, isAutoMemoryEnabled } from '../memdir/paths.js'
import type { HookCommand, HookMatcher } from '../schemas/hooks.js'
import { fetchOpenAIActivity } from '../services/api/usage.js'
import { isChannelAllowlisted } from '../services/mcp/channelAllowlist.js'
import {
  installPluginOp,
  setPluginEnabledOp,
  uninstallPluginOp,
  updatePluginOp,
} from '../services/plugins/pluginOperations.js'
import type { LoadedPlugin } from '../types/plugin.js'
import { clearMemoryFileCaches, getMemoryFiles } from '../utils/claudemd.js'
import { logForDebugging } from '../utils/debug.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { errorMessage } from '../utils/errors.js'
import { renderModelName } from '../utils/model/model.js'
import { clearAllCaches } from '../utils/plugins/cacheUtils.js'
import {
  addMarketplaceSource,
  getMarketplaceCacheOnly,
  loadKnownMarketplacesConfig,
  refreshMarketplace,
  removeMarketplaceSource,
  saveMarketplaceToSettings,
} from '../utils/plugins/marketplaceManager.js'
import { ESONHUGH_MARKETPLACE_NAME } from '../utils/plugins/esonhughMarketplace.js'
import { OFFICIAL_MARKETPLACE_NAME } from '../utils/plugins/officialMarketplace.js'
import { parseMarketplaceInput } from '../utils/plugins/parseMarketplaceInput.js'
import { loadPluginMcpServers } from '../utils/plugins/mcpPluginIntegration.js'
import { loadAllPlugins } from '../utils/plugins/pluginLoader.js'
import { getPluginStorageId } from '../utils/plugins/pluginOptionsStorage.js'
import type { EditableSettingSource } from '../utils/settings/constants.js'
import {
  getInitialSettings,
  getSettingsFilePathForSource,
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'
import { getSkillOverride, isSkillOverridable } from '../utils/skillOverrides.js'
import { aggregateClaudeCodeStats } from '../utils/stats.js'

export class ExtError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

const MAX_PREVIEW_BYTES = 64 * 1024
// Plugin and marketplace names: what `claude plugin` accepts, no paths.
const NAME = /^[A-Za-z0-9][\w.-]{0,127}$/
const PLUGIN_ID = /^[A-Za-z0-9][\w.-]{0,127}(@[A-Za-z0-9][\w.-]{0,127})?$/
const SKILL_NAME = /^[A-Za-z0-9][\w.:-]{0,199}$/
const CHANNEL_ENTRY = /^plugin:[A-Za-z0-9][\w.-]{0,127}@[A-Za-z0-9][\w.-]{0,127}$/

export function tildify(path: string): string {
  const home = homedir()
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path
}

async function readPreview(path: string): Promise<string> {
  try {
    const text = await readFile(path, 'utf8')
    return text.length > MAX_PREVIEW_BYTES ? `${text.slice(0, MAX_PREVIEW_BYTES)}\n…` : text
  } catch {
    return ''
  }
}

/**
 * A marketplace source typed into the page: `owner/repo` or an https URL.
 * Local paths and ssh remotes stay with the CLI, so nothing from the page
 * names a file on this machine.
 */
export function parseWebMarketplaceSource(input: string): string | undefined {
  const value = input.trim()
  if (value.length > 500 || /\s/.test(value)) return undefined
  if (/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*(#[\w./-]+)?$/.test(value)) return value
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return undefined
    return value
  } catch {
    return undefined
  }
}

// ---- skills (as /skills) ----

type SkillCommand = Extract<Command, { type: 'prompt' }>

const SKILL_LOADERS = new Set(['skills', 'commands_DEPRECATED', 'plugin', 'bundled'])

export type SkillGroup = 'project' | 'user' | 'plugin' | 'builtin'

function skillGroup(cmd: SkillCommand): SkillGroup {
  if (cmd.source === 'plugin') return 'plugin'
  if (cmd.source === 'bundled' || cmd.source === 'builtin' || cmd.loadedFrom === 'bundled') return 'builtin'
  if (cmd.source === 'userSettings') return 'user'
  return 'project'
}

async function skillCommands(): Promise<SkillCommand[]> {
  const commands = await getCommands(getOriginalCwd())
  return commands.filter(
    (cmd): cmd is SkillCommand => cmd.type === 'prompt' && SKILL_LOADERS.has(cmd.loadedFrom ?? '') && !cmd.isHidden,
  )
}

export async function listSkills() {
  clearCommandsCache()
  const overrides = getInitialSettings().skillOverrides
  return (await skillCommands()).map(cmd => {
    const group = skillGroup(cmd)
    return {
      name: cmd.name,
      display: getCommandName(cmd),
      group,
      where:
        group === 'plugin'
          ? (cmd.pluginInfo?.repository ?? 'plugin')
          : group === 'builtin'
            ? ''
            : tildify(cmd.skillRoot ?? (cmd.skillFile ? dirname(cmd.skillFile.path) : '')),
      description: cmd.description ?? '',
      on: getSkillOverride(cmd, overrides) !== 'off',
      toggleable: isSkillOverridable(cmd),
    }
  })
}

async function findSkill(name: string): Promise<SkillCommand> {
  if (!SKILL_NAME.test(name)) throw new ExtError('Invalid skill name')
  const skill = (await skillCommands()).find(cmd => cmd.name === name)
  if (!skill) throw new ExtError('Skill not found', 404)
  return skill
}

export async function skillContent(name: string): Promise<{ content: string; file?: string }> {
  const skill = await findSkill(name)
  const file = skill.skillFile?.path
  return file ? { content: await readPreview(file), file: tildify(file) } : { content: '' }
}

/** Same write as the /skills menu: `skillOverrides` in local settings, "on" removes the entry. */
export async function setSkillEnabled(name: string, on: boolean): Promise<void> {
  const skill = await findSkill(name)
  if (!isSkillOverridable(skill)) throw new ExtError('This skill is turned off with its plugin')
  const { error } = updateSettingsForSource('localSettings', {
    skillOverrides: { [skill.name]: on ? undefined : 'off' },
  })
  if (error) throw new ExtError(error.message, 500)
  clearCommandsCache()
}

// ---- plugins (as /plugin and `claude plugin`) ----

function countEntries(dirs: (string | undefined)[], match: (dir: string, name: string) => boolean): number {
  let n = 0
  for (const dir of dirs) {
    if (!dir) continue
    try {
      n += readdirSync(dir).filter(name => match(dir, name)).length
    } catch {
      // Missing component folder.
    }
  }
  return n
}

/** What a plugin brings, for the tags under each row: `{ skills: 4, mcp: 1 }`. */
export function pluginParts(plugin: LoadedPlugin): Record<string, number> {
  const skills = countEntries([plugin.skillsPath, ...(plugin.skillsPaths ?? [])], (dir, name) =>
    existsSync(join(dir, name, 'SKILL.md')),
  )
  const commands = countEntries([plugin.commandsPath, ...(plugin.commandsPaths ?? [])], (_, name) => name.endsWith('.md'))
  const agents = countEntries([plugin.agentsPath, ...(plugin.agentsPaths ?? [])], (_, name) => name.endsWith('.md'))
  const hooks = Object.values(plugin.hooksConfig ?? {}).flatMap(m => m ?? []).flatMap(m => m.hooks).length
  const parts: Record<string, number> = {
    skills,
    commands,
    agents,
    hooks,
    mcp: Object.keys(
      plugin.mcpServers ?? (typeof plugin.manifest.mcpServers === 'object' && !Array.isArray(plugin.manifest.mcpServers) ? plugin.manifest.mcpServers : {}),
    ).length,
    mods: plugin.hookModules?.length ? 1 : 0,
  }
  return Object.fromEntries(Object.entries(parts).filter(([, n]) => n > 0))
}

async function allPlugins(): Promise<LoadedPlugin[]> {
  const { enabled, disabled } = await loadAllPlugins()
  return [...enabled, ...disabled]
}

function marketplaceUrl(source: { source: string; repo?: string; url?: string; path?: string } | undefined): string {
  if (!source) return ''
  if (source.source === 'github' && source.repo) return `github.com/${source.repo}`
  return source.url ?? (source.path ? tildify(source.path) : source.source)
}

export async function listPlugins() {
  const plugins = (await allPlugins()).filter(p => !p.isBuiltin)
  const known = await loadKnownMarketplacesConfig()
  // The fork's own marketplace first, then Anthropic's, then the rest as added.
  const rank = (name: string) => [ESONHUGH_MARKETPLACE_NAME, OFFICIAL_MARKETPLACE_NAME].indexOf(name) >>> 0
  const marketplaces = await Promise.all(
    Object.entries(known)
      .sort(([a], [b]) => rank(a) - rank(b))
      .map(async ([name, entry]) => ({
        name,
        url: marketplaceUrl(entry?.source as { source: string; repo?: string; url?: string; path?: string }),
        official: name === OFFICIAL_MARKETPLACE_NAME || name === ESONHUGH_MARKETPLACE_NAME,
        data: await getMarketplaceCacheOnly(name).catch(() => null),
      })),
  )
  const installedIds = new Set(plugins.map(getPluginStorageId))
  const latest = new Map<string, string>()
  const discover = marketplaces.flatMap(m =>
    (m.data?.plugins ?? []).map(entry => {
      const id = `${entry.name}@${m.name}`
      if (entry.version) latest.set(id, entry.version)
      const record = entry as Record<string, unknown>
      return {
        id,
        name: entry.name,
        marketplace: m.name,
        description: entry.description ?? '',
        installed: installedIds.has(id),
        channel: (Array.isArray(record.channels) && record.channels.length > 0) || isChannelAllowlisted(id),
      }
    }),
  )
  return {
    installed: plugins.map(p => {
      const id = getPluginStorageId(p)
      const version = p.manifest.version
      const newest = latest.get(id)
      return {
        id,
        name: p.name,
        marketplace: id.includes('@') ? id.slice(id.indexOf('@') + 1) : '',
        version: version ?? '',
        description: p.manifest.description ?? '',
        on: p.enabled !== false,
        parts: pluginParts(p),
        ...(newest && version && newest !== version && { update: newest }),
      }
    }),
    discover,
    marketplaces: marketplaces.map(({ name, url, official }) => ({ name, url, official })),
  }
}

function checkPluginId(id: string): string {
  if (!PLUGIN_ID.test(id)) throw new ExtError('Invalid plugin id')
  return id
}

function opResult(result: { success: boolean; message: string }): { message: string } {
  clearAllCaches()
  if (!result.success) throw new ExtError(result.message, 422)
  return { message: result.message }
}

export async function pluginAction(
  action: 'install' | 'uninstall' | 'enable' | 'disable' | 'update',
  id: string,
): Promise<{ message: string }> {
  checkPluginId(id)
  switch (action) {
    case 'install':
      return opResult(await installPluginOp(id, 'user'))
    case 'uninstall':
      return opResult(await uninstallPluginOp(id, 'user'))
    case 'enable':
    case 'disable':
      return opResult(await setPluginEnabledOp(id, action === 'enable'))
    case 'update':
      return opResult(await updatePluginOp(id, 'user'))
  }
}

/** `claude plugin marketplace add <source>` at user scope. */
export async function addMarketplace(input: string): Promise<{ name: string }> {
  const source = parseWebMarketplaceSource(input)
  if (!source) throw new ExtError('Use owner/repo or an https URL')
  const parsed = await parseMarketplaceInput(source)
  if (!parsed) throw new ExtError('Invalid marketplace source')
  if ('error' in parsed) throw new ExtError(String(parsed.error))
  if (parsed.source !== 'github' && parsed.source !== 'git' && parsed.source !== 'url') {
    throw new ExtError('Use owner/repo or an https URL')
  }
  const { name, resolvedSource } = await addMarketplaceSource(parsed)
  saveMarketplaceToSettings(name, { source: resolvedSource }, 'userSettings')
  clearAllCaches()
  return { name }
}

export async function marketplaceAction(action: 'refresh' | 'remove', name: string): Promise<void> {
  if (!NAME.test(name)) throw new ExtError('Invalid marketplace name')
  if (!(name in (await loadKnownMarketplacesConfig()))) throw new ExtError('Marketplace not found', 404)
  if (action === 'refresh') await refreshMarketplace(name)
  else await removeMarketplaceSource(name)
  clearAllCaches()
}

// ---- channels (plugins that declare `channels`; defaults become --channels) ----

function channelsFile(configDir: string): string {
  return join(configDir, 'web', 'channels.json')
}

/** `plugin:<name>@<marketplace>` entries every new web session gets as `--channels`. */
export function readDefaultChannels(configDir: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(channelsFile(configDir), 'utf8')) as { channels?: unknown }
    return Array.isArray(raw.channels)
      ? raw.channels.filter((c): c is string => typeof c === 'string' && CHANNEL_ENTRY.test(c))
      : []
  } catch {
    return []
  }
}

/**
 * Channel plugins: those that declare `channels`, and the approved ones (the
 * official telegram/discord/imessage/fakechat declare none), whose every MCP
 * server is a channel.
 */
export async function listChannels(configDir: string) {
  const defaults = new Set(readDefaultChannels(configDir))
  const plugins = (await allPlugins()).filter(p => !p.isBuiltin)
  const rows = await Promise.all(
    plugins.map(async p => {
      const id = getPluginStorageId(p)
      const declared = p.manifest.channels ?? []
      const channels = declared.length
        ? declared
        : isChannelAllowlisted(id)
          ? Object.keys(p.mcpServers ?? (await loadPluginMcpServers(p)) ?? {}).map(server => ({
              server,
              displayName: undefined,
            }))
          : []
      return channels.map(channel => ({
        name: channel.server,
        displayName: channel.displayName ?? channel.server,
        plugin: id,
        // The runtime name a plugin's MCP server connects under.
        server: `plugin:${p.name}:${channel.server}`,
        pluginEnabled: p.enabled !== false,
        def: defaults.has(`plugin:${id}`),
      }))
    }),
  )
  return rows.flat()
}

export async function setDefaultChannel(configDir: string, plugin: string, on: boolean): Promise<void> {
  const entry = `plugin:${checkPluginId(plugin)}`
  if (!CHANNEL_ENTRY.test(entry)) throw new ExtError('A channel plugin needs plugin@marketplace')
  const next = new Set(readDefaultChannels(configDir))
  if (on) next.add(entry)
  else next.delete(entry)
  await mkdir(join(configDir, 'web'), { recursive: true })
  await writeFile(channelsFile(configDir), JSON.stringify({ channels: [...next] }, null, 2) + '\n')
}

// ---- memory (as /memory; search through the memory.sqlite FTS index) ----

type MemoryEntry = { id: string; kind: string; title: string; where: string; path: string; modified?: number; missing?: boolean }

async function memoryEntries(): Promise<MemoryEntry[]> {
  clearMemoryFileCaches()
  const cwd = getOriginalCwd()
  const userPath = join(getClaudeConfigHomeDir(), 'CLAUDE.md')
  const projectPath = join(cwd, 'CLAUDE.md')
  const loaded = (await getMemoryFiles()).filter(f => f.type !== 'AutoMem' && f.type !== 'TeamMem')
  const paths = [userPath, projectPath, ...loaded.map(f => f.path)]
  const seen = new Set<string>()
  const entries: MemoryEntry[] = []
  for (const path of paths) {
    if (seen.has(path)) continue
    seen.add(path)
    const missing = !existsSync(path)
    if (path !== userPath && path !== projectPath && missing) continue
    const kind =
      path === userPath
        ? 'user'
        : path === projectPath || path === join(cwd, '.claude', 'CLAUDE.md')
          ? 'project'
          : basename(path) === 'CLAUDE.local.md'
            ? 'local'
            : 'other'
    // The user and project files are listed even before they exist, so they can be created.
    entries.push({ id: `f${entries.length}`, kind, title: basename(path), where: tildify(path), path, ...(missing && { missing }) })
  }
  if (isAutoMemoryEnabled()) {
    // Every file, not the newest 200 that recall prompts list, so the page can show and search all of them.
    const headers = await scanMemoryFiles(getAutoMemPath(), new AbortController().signal, Infinity)
    for (const m of headers.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
      entries.push({
        id: `a${entries.length}`,
        kind: 'auto',
        title: m.filename.replace(/\.md$/, ''),
        where: tildify(m.filePath),
        path: m.filePath,
        modified: m.mtimeMs,
      })
    }
  }
  return entries
}

function sqliteEnabled(): boolean {
  return getInitialSettings().memory?.sqlite?.enabled === true
}

export async function listMemory() {
  const entries = await memoryEntries()
  const sqlite = sqliteEnabled()
  let index: { path: string; files: number; chunks: number; builtAt?: number } | undefined
  if (sqlite && typeof Bun !== 'undefined') {
    const { getMemoryIndexStatus } = await import('../memdir/memoryIndex.js')
    const status = getMemoryIndexStatus()
    index = { path: tildify(status.path), files: status.files, chunks: status.chunks, builtAt: status.builtAt }
  }
  return {
    files: await Promise.all(
      entries.map(async ({ path, ...entry }) => ({ ...entry, body: await readPreview(path) })),
    ),
    autoMemory: isAutoMemoryEnabled(),
    sqlite,
    ...(index && { index }),
  }
}

export async function searchMemoryIndex(query: string, scope: 'all' | 'memory' | 'session') {
  const q = query.trim().slice(0, 200)
  if (q.length < 2 || !sqliteEnabled() || typeof Bun === 'undefined') return { memory: [], sessions: [] }
  const { searchMemory } = await import('../memdir/memoryIndex.js')
  // Separate searches, so transcript chunks cannot take every slot from memory files.
  // One row per file, so a long session cannot fill the slots and hide other sessions.
  const [memoryHits, sessionHits] = await Promise.all([
    scope === 'session' ? [] : searchMemory({ query: q, scopes: ['user', 'project'], limit: 1000, onePerFile: true }),
    scope === 'memory' ? [] : searchMemory({ query: q, scopes: ['session'], limit: 1000, onePerFile: true }),
  ])
  const entries = await memoryEntries()
  const byPath = new Map(entries.map(e => [resolve(e.path), e.id]))
  return {
    memory: memoryHits.flatMap(h => {
      const id = h.kind === 'memory' ? byPath.get(resolve(h.path)) : undefined
      return id ? [{ id, snippet: h.snippet, match: h.match }] : []
    }),
    sessions: sessionHits.map(h => ({ session: basename(h.path, '.jsonl'), snippet: h.snippet, match: h.match })),
  }
}

export function setMemoryToggle(key: 'autoMemory' | 'sqlite', on: boolean): void {
  const { error } = updateSettingsForSource(
    'userSettings',
    key === 'autoMemory' ? { autoMemoryEnabled: on } : { memory: { sqlite: { enabled: on } } },
  )
  if (error) throw new ExtError(error.message, 500)
}

// ---- hooks (settings `hooks`, written like the TUI's settings writes) ----

const HOOK_SOURCES = { user: 'userSettings', project: 'projectSettings' } as const
const EDITABLE: EditableSettingSource[] = ['userSettings', 'projectSettings', 'localSettings']
type HookEvent = (typeof HOOK_EVENTS)[number]
// source:event:group:index:fingerprint — the place it was listed at, and what was there.
const HOOK_ID = /^(userSettings|projectSettings|localSettings):([A-Za-z]+):(\d{1,4}):(\d{1,4}):([0-9a-f]{12})$/

function hookFingerprint(matcher: string | undefined, hook: HookCommand): string {
  return createHash('sha256').update(JSON.stringify([matcher ?? '', hook])).digest('hex').slice(0, 12)
}

export const hookInputSchema = z.object({
  event: z.enum(HOOK_EVENTS),
  matcher: z.string().max(200).regex(/^[^\n\r\0]*$/),
  command: z.string().trim().min(1).max(4000).regex(/^[^\0]*$/),
  timeout: z.number().int().min(1).max(600).optional(),
  source: z.enum(['user', 'project']),
})
export type HookInput = z.infer<typeof hookInputSchema>

function settingsHooks(source: EditableSettingSource): Partial<Record<HookEvent, HookMatcher[]>> {
  return (getSettingsForSource(source)?.hooks ?? {}) as Partial<Record<HookEvent, HookMatcher[]>>
}

/**
 * Rewrites `hooks[event]` from the file as it is on disk now (under the
 * settings lock), so hooks written since this process read the file are kept.
 */
function editHooks(source: EditableSettingSource, event: HookEvent, edit: (matchers: HookMatcher[]) => void): void {
  let refused: ExtError | undefined
  const { error } = updateSettingsForSource(source, existing => {
    const matchers = structuredClone(((existing.hooks ?? {}) as Partial<Record<HookEvent, HookMatcher[]>>)[event] ?? [])
    try {
      edit(matchers)
    } catch (err) {
      if (!(err instanceof ExtError)) throw err
      refused = err
      return {}
    }
    const kept = matchers.filter(m => m.hooks.length > 0)
    return { hooks: { [event]: kept.length ? kept : undefined } }
  })
  if (refused) throw refused
  if (error) throw new ExtError(error.message, 500)
}

export async function listHooks() {
  const seen = new Set<string>()
  const rows: {
    id?: string
    event: string
    matcher: string
    command: string
    timeout?: number
    source: string
    label: string
  }[] = []
  for (const source of EDITABLE) {
    const file = getSettingsFilePathForSource(source)
    if (!file || seen.has(resolve(file))) continue
    seen.add(resolve(file))
    for (const [event, matchers] of Object.entries(settingsHooks(source))) {
      ;(matchers ?? []).forEach((m, mi) =>
        m.hooks.forEach((h, hi) =>
          rows.push({
            id: `${source}:${event}:${mi}:${hi}:${hookFingerprint(m.matcher, h)}`,
            event,
            matcher: m.matcher ?? '',
            command: hookText(h),
            ...(typeof h.timeout === 'number' && { timeout: h.timeout }),
            source: source === 'userSettings' ? 'user' : source === 'projectSettings' ? 'project' : 'local',
            label: tildify(file),
          }),
        ),
      )
    }
  }
  for (const [event, matchers] of Object.entries(getSettingsForSource('policySettings')?.hooks ?? {})) {
    for (const m of matchers ?? []) {
      for (const h of m.hooks) {
        rows.push({ event, matcher: m.matcher ?? '', command: hookText(h), source: 'policy', label: '' })
      }
    }
  }
  for (const plugin of (await loadAllPlugins()).enabled) {
    for (const [event, matchers] of Object.entries(plugin.hooksConfig ?? {}) as [string, HookMatcher[] | undefined][]) {
      for (const m of matchers ?? []) {
        for (const h of m.hooks) {
          rows.push({
            event,
            matcher: m.matcher ?? '',
            command: hookText(h),
            ...(typeof h.timeout === 'number' && { timeout: h.timeout }),
            source: 'plugin',
            label: plugin.name,
          })
        }
      }
    }
  }
  return { disabled: getInitialSettings().disableAllHooks === true, hooks: rows }
}

function hookText(h: HookCommand): string {
  switch (h.type) {
    case 'command':
      return h.command
    case 'http':
      return h.url
    default:
      return h.prompt
  }
}

type HookId = { source: EditableSettingSource; event: HookEvent; mi: number; hi: number; fingerprint: string }

function parseHookId(id: string): HookId {
  const match = HOOK_ID.exec(id)
  if (!match || !(HOOK_EVENTS as readonly string[]).includes(match[2]!)) throw new ExtError('Invalid hook id')
  return {
    source: match[1] as EditableSettingSource,
    event: match[2] as HookEvent,
    mi: Number(match[3]),
    hi: Number(match[4]),
    fingerprint: match[5]!,
  }
}

/**
 * Where the hook the list showed is now: at its listed place, else the one
 * place an identical hook moved to (another process added or removed hooks).
 */
function findListedHook(matchers: HookMatcher[], id: HookId): [number, number] {
  const at = (mi: number, hi: number) => {
    const hook = matchers[mi]?.hooks[hi]
    return !!hook && hookFingerprint(matchers[mi]!.matcher, hook) === id.fingerprint
  }
  if (at(id.mi, id.hi)) return [id.mi, id.hi]
  const found = matchers.flatMap((m, mi) => m.hooks.flatMap((_, hi) => (at(mi, hi) ? [[mi, hi] as [number, number]] : [])))
  if (found.length === 1) return found[0]!
  throw new ExtError('This hook was changed elsewhere; the list now shows it as it is', 409)
}

/** Removes one hook; the matcher group and event go too once empty. */
export function deleteHook(id: string): void {
  const listed = parseHookId(id)
  editHooks(listed.source, listed.event, matchers => {
    const [mi, hi] = findListedHook(matchers, listed)
    matchers[mi]!.hooks.splice(hi, 1)
  })
}

function pushHook(matchers: HookMatcher[], matcher: string, hook: HookCommand): void {
  const group = matchers.find(m => (m.matcher ?? '') === matcher)
  if (group) group.hooks.push(hook)
  else matchers.push({ ...(matcher && { matcher }), hooks: [hook] })
}

function commandHook(input: HookInput): HookCommand {
  return {
    type: 'command',
    command: input.command.trim(),
    ...(input.timeout !== undefined && { timeout: input.timeout }),
  }
}

export function addHook(input: HookInput): void {
  editHooks(HOOK_SOURCES[input.source], input.event, matchers => pushHook(matchers, input.matcher, commandHook(input)))
}

/**
 * Changes what the dialog shows (text, timeout, matcher, event, file) and keeps
 * the rest of the hook: its type (an http hook stays one), async, headers, ….
 */
export function updateHook(id: string, input: HookInput): void {
  const listed = parseHookId(id)
  const { source, event } = listed
  let old: HookCommand | undefined
  editHooks(source, event, matchers => {
    const [mi, hi] = findListedHook(matchers, listed)
    old = matchers[mi]!.hooks[hi]!
    const text = input.command.trim()
    const { timeout: _, ...rest } = old
    const hook = {
      ...rest,
      ...(old.type === 'command' ? { command: text } : old.type === 'http' ? { url: text } : { prompt: text }),
      ...(input.timeout !== undefined && { timeout: input.timeout }),
    } as HookCommand
    const target = HOOK_SOURCES[input.source]
    if (target === source && input.event === event && (matchers[mi]!.matcher ?? '') === input.matcher) {
      matchers[mi]!.hooks[hi] = hook
      old = undefined
      return
    }
    matchers[mi]!.hooks.splice(hi, 1)
    old = hook
  })
  if (old) editHooks(HOOK_SOURCES[input.source], input.event, matchers => pushHook(matchers, input.matcher, old!))
}

/** "停用全部 hooks": `disableAllHooks` in user settings; turning it back on clears every editable file. */
export function setHooksDisabled(disabled: boolean): void {
  for (const source of disabled ? (['userSettings'] as const) : EDITABLE) {
    if (!disabled && getSettingsForSource(source)?.disableAllHooks === undefined) continue
    const { error } = updateSettingsForSource(source, { disableAllHooks: disabled ? true : undefined })
    if (error) throw new ExtError(error.message, 500)
  }
}

// ---- mods (plugins with hook modules) ----

/** Events and UI surfaces a mod's source registers, for the list's second line. */
export function scanModSource(source: string): { events: string[]; surfaces: string[] } {
  const events = new Set<string>()
  const surfaces = new Set<string>()
  for (const m of source.matchAll(/\$\.on\(\s*['"]([\w.]+)['"]/g)) events.add(m[1]!)
  for (const m of source.matchAll(/component:\s*['"](\w+)['"]/g)) surfaces.add(m[1]!)
  if (/\$\.command\.register\(/.test(source)) events.add('command.run')
  return { events: [...events], surfaces: [...surfaces] }
}

function modEntry(plugin: LoadedPlugin): string | undefined {
  const group = plugin.hookModules?.[0]
  const path = group?.paths[0]
  return group && path ? resolve(dirname(group.configPath), path) : undefined
}

function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), path)
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel)
}

export async function listMods() {
  const mods = (await allPlugins()).filter(p => (p.hookModules?.length ?? 0) > 0)
  return Promise.all(
    mods.map(async p => {
      const entry = modEntry(p)
      const source = entry ? await readPreview(entry) : ''
      return {
        id: p.name,
        plugin: getPluginStorageId(p),
        on: p.enabled !== false,
        description: p.manifest.description ?? '',
        file: entry ? relative(p.path, entry) : '',
        editable: !p.isBuiltin && !!entry && isInside(p.path, entry),
        ...scanModSource(source),
      }
    }),
  )
}

async function findMod(id: string): Promise<{ plugin: LoadedPlugin; entry: string }> {
  if (!NAME.test(id)) throw new ExtError('Invalid mod name')
  const plugin = (await allPlugins()).find(p => p.name === id && (p.hookModules?.length ?? 0) > 0)
  const entry = plugin && modEntry(plugin)
  if (!plugin || !entry) throw new ExtError('Mod not found', 404)
  return { plugin, entry }
}

export async function modSource(id: string): Promise<{ source: string }> {
  const { entry } = await findMod(id)
  return { source: await readPreview(entry) }
}

export async function saveModSource(id: string, source: string): Promise<void> {
  const { plugin, entry } = await findMod(id)
  if (plugin.isBuiltin || !isInside(plugin.path, entry)) throw new ExtError('This mod is read-only', 403)
  if (source.length > 512 * 1024) throw new ExtError('Source is too large', 413)
  if (!existsSync(entry) || !statSync(entry).isFile()) throw new ExtError('Mod file not found', 404)
  writeFileSync(entry, source)
}

export async function setModEnabled(id: string, on: boolean): Promise<{ message: string }> {
  const { plugin } = await findMod(id)
  return opResult(await setPluginEnabledOp(getPluginStorageId(plugin), on))
}

// ---- stats (as /stats) ----

export async function loadStats() {
  // The ChatGPT account's Codex activity, as the OpenAI tab of /stats; null when not signed in with ChatGPT.
  const [stats, codex] = await Promise.all([
    aggregateClaudeCodeStats(),
    fetchOpenAIActivity().catch(error => {
      logForDebugging(`stats: ChatGPT activity unavailable: ${errorMessage(error)}`, { level: 'warn' })
      return null
    }),
  ])
  const names = new Map<string, string>()
  const name = (id: string) => {
    if (!names.has(id)) names.set(id, renderModelName(id))
    return names.get(id)!
  }
  return {
    days: stats.dailyActivity.map(d => ({ date: d.date, sessions: d.sessionCount, messages: d.messageCount })),
    tokens: stats.dailyModelTokens.map(d => ({
      date: d.date,
      byModel: Object.fromEntries(
        Object.entries(d.tokensByModel).reduce<[string, number][]>((acc, [id, n]) => {
          const label = name(id)
          const found = acc.find(([k]) => k === label)
          if (found) found[1] += n
          else acc.push([label, n])
          return acc
        }, []),
      ),
    })),
    streaks: { current: stats.streaks.currentStreak, longest: stats.streaks.longestStreak },
    longestSessionMs: stats.longestSession?.duration ?? 0,
    hours: Array.from({ length: 24 }, (_, h) => stats.hourCounts?.[h] ?? 0),
    totalSessions: stats.totalSessions,
    codex: codex && {
      lifetimeTokens: codex.lifetime_tokens ?? null,
      peakDailyTokens: codex.peak_daily_tokens ?? null,
      currentStreakDays: codex.current_streak_days ?? null,
      longestStreakDays: codex.longest_streak_days ?? null,
      longestTurnSec: codex.longest_running_turn_sec ?? null,
      daily: (codex.daily_usage_buckets ?? []).map(b => ({ date: b.start_date, tokens: b.tokens })),
    },
  }
}
