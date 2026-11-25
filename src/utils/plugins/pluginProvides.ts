import type { Dirent } from 'fs'
import { readdir, readFile, realpath, stat } from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'path'
import type { LoadedPlugin } from '../../types/plugin.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { parseFrontmatter } from '../frontmatterParser.js'
import { jsonParse } from '../slowOperations.js'
import type { HooksSettings } from '../settings/types.js'
import { urlHost } from '../../services/mods/loader.js'
import { loadPluginLspServers } from './lspPluginIntegration.js'
import { isMcpbSource } from './mcpbHandler.js'
import { loadMcpServersFromFile } from './mcpPluginIntegration.js'
import { PluginHooksSchema, PluginManifestSchema, type PluginManifest } from './schemas.js'
import type { ValidationResult } from './validatePlugin.js'

// Official 2.1.329 `claude plugin validate` lists what a plugin with no errors
// provides, one "<kind>: <values>" line per entry, then the hosts its parts reach.
// The listing reads the manifest and the component files the way contract
// discovery does: nothing is materialized, run or installed.
type Entry = string | Record<string, unknown>
export type PluginProvides = Record<string, Entry[]>

type Components = {
  name: string
  path: string
  manifest: PluginManifest
  network: unknown
  skills: string[]
  commands: string[]
  commandsMetadata: Record<string, { source?: string; content?: string }>
  agents: string[]
  outputStyles: string[]
  hooksConfig?: HooksSettings
  modules: string[]
}

const byJson = (entries: Entry[]) => {
  const unique = new Map(entries.map(entry => [JSON.stringify(entry), entry]))
  return [...unique.keys()].sort().map(key => unique.get(key)!)
}
const uniqueByJson = <T>(entries: T[]) => [...new Map(entries.map(entry => [JSON.stringify(entry), entry])).values()]
const named = (plugin: string, name: string) => `${plugin}:${name.replace(/[^a-zA-Z0-9_-]/g, '-')}`
const frontmatterName = async (file: string) => {
  const name = parseFrontmatter(await readFile(file, 'utf8'), file).frontmatter.name
  return typeof name === 'string' ? name.trim() || undefined : name == null ? undefined : String(name)
}
const exists = (path: string) => stat(path).then(() => true, () => false)
const isDirectory = (path: string) => stat(path).then(info => info.isDirectory(), () => false)
const readJson = async (path: string) => jsonParse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')) as unknown

// A component the manifest names replaces its default folder, as the loader has it.
async function componentPaths(root: string, declared: unknown, folder: string): Promise<string[]> {
  if (!declared) return (await exists(join(root, folder))) ? [join(root, folder)] : []
  const paths = [declared].flat().filter((path): path is string => typeof path === 'string').map(path => join(root, path))
  const found = await Promise.all(paths.map(exists))
  return paths.filter((_, index) => found[index])
}

function mergeHooks(base: HooksSettings | undefined, more: HooksSettings): HooksSettings {
  const merged: Record<string, unknown[]> = { ...(base as Record<string, unknown[]>) }
  for (const [event, matchers] of Object.entries(more as Record<string, unknown[]>)) merged[event] = [...(merged[event] ?? []), ...matchers]
  return merged as HooksSettings
}

async function readComponents(root: string): Promise<Components> {
  const manifestPath = join(root, '.claude-plugin', 'plugin.json')
  const raw = (await readJson(manifestPath)) as Record<string, unknown>
  const manifest = PluginManifestSchema().parse(raw)
  const commandsMetadata: Components['commandsMetadata'] = {}
  let commands: string[]
  const mapping = manifest.commands && typeof manifest.commands === 'object' && !Array.isArray(manifest.commands) ? Object.entries(manifest.commands) : undefined
  if (mapping && mapping[0]?.[1] && typeof mapping[0][1] === 'object' && ('source' in mapping[0][1] || 'content' in mapping[0][1])) {
    commands = []
    for (const [name, metadata] of mapping as [string, { source?: string; content?: string }][]) {
      if (metadata?.source && (await exists(join(root, metadata.source)))) {
        commands.push(join(root, metadata.source))
        commandsMetadata[name] = metadata
      } else if (metadata && !metadata.source && metadata.content) commandsMetadata[name] = metadata
    }
  } else commands = await componentPaths(root, manifest.commands, 'commands')

  let hooksConfig: HooksSettings | undefined
  const modules: string[] = []
  const seen = new Set<string>()
  const hookFile = async (path: string) => {
    const real = await realpath(path).catch(() => path)
    if (seen.has(real)) return
    seen.add(real)
    const config = PluginHooksSchema().parse(await readJson(path))
    if (config.hooks) hooksConfig = mergeHooks(hooksConfig, config.hooks as HooksSettings)
    for (const module of config.modules ?? []) modules.push(isAbsolute(module) ? module : join(dirname(path), module))
  }
  if (await exists(join(root, 'hooks', 'hooks.json'))) await hookFile(join(root, 'hooks', 'hooks.json'))
  for (const spec of [manifest.hooks ?? []].flat()) {
    if (typeof spec === 'string') {
      if (await exists(join(root, spec))) await hookFile(join(root, spec))
    } else if (spec && typeof spec === 'object') hooksConfig = mergeHooks(hooksConfig, spec as HooksSettings)
  }

  return {
    name: manifest.name, path: root, manifest, network: raw.network,
    skills: await componentPaths(root, manifest.skills, 'skills'),
    commands, commandsMetadata,
    agents: await componentPaths(root, manifest.agents, 'agents'),
    outputStyles: await componentPaths(root, manifest.outputStyles, 'output-styles'),
    hooksConfig, modules,
  }
}

async function markdownFiles(root: string): Promise<{ file: string; namespace: string[] }[]> {
  if (!(await isDirectory(root))) return root.endsWith('.md') ? [{ file: root, namespace: [] }] : []
  const found: { file: string; namespace: string[] }[] = []
  const walk = async (directory: string, namespace: string[]) => {
    const entries: Dirent[] = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path, [...namespace, entry.name])
      else if (entry.isFile() && entry.name.endsWith('.md')) found.push({ file: path, namespace })
    }
  }
  await walk(root, [])
  return found
}

async function skills(plugin: Components): Promise<Entry[]> {
  const listed = await Promise.all(plugin.skills.map(async path => {
    const own = join(path, 'SKILL.md')
    if (await stat(own).then(info => info.isFile(), () => false)) {
      const name = (await frontmatterName(own)) ?? ''
      return [named(plugin.name, (name.startsWith(`${plugin.name}:`) ? name.slice(plugin.name.length + 1) : name) || basename(path))]
    }
    const entries: Dirent[] = await readdir(path, { withFileTypes: true }).catch(() => [])
    const found = await Promise.all(entries.filter(entry => !entry.name.startsWith('.')).map(async entry =>
      (await stat(join(path, entry.name, 'SKILL.md')).then(info => info.isFile(), () => false)) ? [named(plugin.name, entry.name)] : []))
    return found.flat()
  }))
  return listed.flat()
}

async function commands(plugin: Components): Promise<Entry[]> {
  const listed = await Promise.all(plugin.commands.map(async root => {
    const files = await markdownFiles(root)
    const folder = await isDirectory(root)
    // A folder holding SKILL.md is one command named after the folder.
    const skillFolders = new Set(files.filter(({ file }) => /^skill\.md$/i.test(basename(file))).map(({ file }) => dirname(file)))
    return files.filter(({ file }) => !skillFolders.has(dirname(file)) || /^skill\.md$/i.test(basename(file))).map(({ file, namespace }) => {
      if (!folder) {
        const metadata = Object.entries(plugin.commandsMetadata).find(([, { source }]) => source && join(plugin.path, source) === file)
        return `${plugin.name}:${metadata?.[0] ?? basename(file).replace(/\.md$/, '')}`
      }
      const skill = skillFolders.has(dirname(file))
      const parts = skill ? namespace.slice(0, -1) : namespace
      const leaf = skill ? basename(dirname(file)) : basename(file).replace(/\.md$/, '')
      return [plugin.name, ...parts, leaf].join(':')
    })
  }))
  const inline = Object.entries(plugin.commandsMetadata).filter(([, { content, source }]) => content && !source).map(([name]) => `${plugin.name}:${name}`)
  return [...listed.flat(), ...inline]
}
// A listed URL keeps its scheme, host and path; credentials, query and fragment stay out.
function listedUrl(url: string): string {
  const slot = url.indexOf('${')
  if (slot !== -1) {
    const at = url.lastIndexOf('@')
    const scheme = /^(?:http|ws)s?:\/\//i.exec(url)?.[0] ?? ''
    return (at === -1 ? url : scheme + url.slice(at + 1)).replace(/[?#].*$/s, '')
  }
  const parsed = URL.parse(url)
  if (parsed === null || !/^(?:http|ws)s?:$/.test(parsed.protocol)) return url
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/%7B/g, '{').replace(/%7D/g, '}')}`
}

function hooks(plugin: Components): Entry[] {
  return Object.entries(plugin.hooksConfig ?? {}).flatMap(([event, matchers]) => (matchers ?? []).flatMap(({ matcher, hooks }) => hooks.map(hook => {
    const base = { event, ...(matcher !== undefined && { matcher }) }
    const raw = hook as Record<string, unknown>
    switch (hook.type) {
      case 'command': return { ...base, type: hook.type, command: hook.command, ...(raw.args !== undefined && { args: raw.args }) }
      case 'http': return { ...base, type: hook.type, url: listedUrl(String(raw.url)) }
      case 'prompt': case 'agent': return { ...base, type: hook.type, prompt: raw.prompt }
      default: return { ...base, type: String(raw.type), ...(raw.server !== undefined && { server: raw.server }), ...(raw.tool !== undefined && { tool: raw.tool }) }
    }
  })))
}

// The MCP and LSP readers take only the plugin's name, path and manifest, which contract discovery has.
const asPlugin = (plugin: Components) => ({ name: plugin.name, path: plugin.path, manifest: plugin.manifest }) as LoadedPlugin

async function mcpServers(plugin: Components): Promise<Entry[]> {
  const specs: (string | Record<string, unknown>)[] = ['.mcp.json', ...[plugin.manifest.mcpServers ?? []].flat() as (string | Record<string, unknown>)[]]
  const loaded = await Promise.all(specs.map(spec => typeof spec !== 'string' ? spec : isMcpbSource(spec) ? null : loadMcpServersFromFile(asPlugin(plugin), spec, [])))
  const servers = loaded.flatMap(config => Object.entries(config ?? {})) as [string, Record<string, unknown>][]
  const bundles = specs.filter((spec): spec is string => typeof spec === 'string' && isMcpbSource(spec)).map(spec => {
    const target = /^https?:\/\//.test(spec) ? listedUrl(spec) : spec.replace(/^(?!\.\/)/, './')
    return { name: target, type: 'mcpb', target }
  })
  return [...servers.map(([name, config]) => 'command' in config
    ? { name, type: 'stdio', target: config.command, ...(config.args !== undefined && { args: config.args }) }
    : { name, type: config.type === 'sse' || config.type === 'ws' ? config.type : 'http', target: typeof config.url === 'string' ? listedUrl(config.url) : '' }), ...bundles]
}

async function lspServers(plugin: Components): Promise<Entry[]> {
  return Object.entries(await loadPluginLspServers(asPlugin(plugin), []) ?? {}).map(([name, config]) => ({ name, command: config.command, ...(config.args !== undefined && { args: config.args }) }))
}

async function agents(plugin: Components): Promise<Entry[]> {
  const files = (await Promise.all(plugin.agents.map(markdownFiles))).flat()
  return Promise.all(files.map(async ({ file, namespace }) => [plugin.name, ...namespace, (await frontmatterName(file)) || basename(file).replace(/\.md$/, '')].join(':')))
}

async function outputStyles(plugin: Components): Promise<Entry[]> {
  const files = (await Promise.all(plugin.outputStyles.map(markdownFiles))).flat()
  return Promise.all(files.map(async ({ file }) => `${plugin.name}:${(await frontmatterName(file)) || basename(file, '.md')}`))
}

const modulePath = (plugin: Components, module: string) => relative(plugin.path, module).split(sep).join('/')

function declaredHosts(network: unknown): string[] | undefined {
  const hosts = (network as { hosts?: unknown } | undefined)?.hosts
  if (!Array.isArray(hosts)) return undefined
  const valid = hosts.flatMap(entry => {
    if (typeof entry !== 'string' || entry.length > 261) return []
    const lower = entry.toLowerCase()
    const port = /:(\d{1,5})$/.exec(lower)
    const host = (port ? lower.slice(0, port.index) : lower).replace(/^\*\./, '')
    return urlHost(`http://${host}`) === host ? [lower] : []
  })
  return valid.length === 0 && hosts.length !== 0 ? undefined : valid
}

type Uses = { calls: readonly string[]; events: readonly string[]; hosts?: { named: readonly string[]; unread: readonly string[] } }
type Part = { kind: string; name: string; reason: 'process' | 'url' | 'unlisted' }
const PROCESS = ['process.run', 'process.spawn']
const REACHING = [...PROCESS, 'agent.call', 'agent.register', 'command.run', 'tool.call']
const URL_CALLS = ['audio.play', 'http.fetch']
const matches = (pattern: string, event: string) => {
  const negated = pattern.startsWith('!')
  const body = negated ? pattern.slice(1) : pattern
  const hit = body === '*' || (body.endsWith('.*') ? event.startsWith(body.slice(0, -1)) : body === event)
  return negated ? !hit : hit
}

// The "Hosts" lines official 2.1.329 prints under the listing (its jYr and ze).
function hostLines(provides: PluginProvides, uses: Uses | null, declared: string[] | undefined): string[] {
  const modules = provides.modules as { path: string }[]
  const hookList = provides.hooks as { event: string; type: string; url?: string; matcher?: string }[]
  const servers = provides.mcpServers as { name: string; type: string; target: string }[]
  const reaches = (uses?.calls ?? []).some(call => REACHING.includes(call)) || (uses?.events ?? []).some(event => PROCESS.some(name => matches(event, name)))
  // A module names the hosts its literal URLs reach; each other URL call, and each hook on one, is a part whose host is not read.
  const urlHosts = uses?.hosts ?? { named: [], unread: (uses?.calls ?? []).filter(call => URL_CALLS.includes(call)) }
  const urlUses = [...urlHosts.named, ...[...urlHosts.unread, ...(uses?.events ?? []).filter(event => URL_CALLS.some(name => matches(event, name)))].map(() => undefined)]
  const reached: { host?: string; declared: boolean; part?: Part }[] = [
    ...modules.flatMap(({ path }) => urlUses.map(host => ({ host, declared: false, part: { kind: 'modules', name: path, reason: 'url' as const } }))),
    ...hookList.flatMap(hook => hook.type === 'http' ? [{ host: urlHost(hook.url ?? ''), declared: false, part: { kind: 'hooks', name: hook.event, reason: 'url' as const } }] : []),
    ...servers.filter(({ type, target }) => type === 'mcpb' ? !target.startsWith('./') : type !== 'stdio')
      .map(({ name, target }) => ({ host: urlHost(target), declared: false, part: { kind: 'mcpServers', name, reason: 'url' as const } })),
    ...(declared ?? []).map(host => ({ host, declared: true })),
  ]
  const process: [string, string[]][] = [
    ['modules', reaches ? modules.map(({ path }) => path) : []],
    ['hooks', hookList.flatMap(hook => hook.type === 'command' ? [hook.event] : [])],
    ['mcpServers', servers.flatMap(({ name, type }) => type === 'stdio' || type === 'mcpb' ? [name] : [])],
    ['lspServers', (provides.lspServers as { name: string }[]).map(({ name }) => name)],
    ['skills', provides.skills as string[]],
    ['commands', provides.commands as string[]],
  ]
  const unread = uniqueByJson<Part>([
    ...process.flatMap(([kind, names]) => names.map(name => ({ kind, name, reason: 'process' as const }))),
    ...reached.flatMap(({ host, part }) => host === undefined && part ? [part] : []),
    ...(uses === null ? modules.map(({ path }) => ({ kind: 'modules', name: path, reason: 'unlisted' as const })) : []),
  ])
  const hosts = [...new Set(reached.flatMap(({ host }) => host ?? []))].sort()
  const counts = new Map<string, number>()
  for (const { kind } of uniqueByJson(unread.map(({ kind, name }) => `${kind} ${name}`)).map(key => ({ kind: key.split(' ')[0]! }))) counts.set(kind, (counts.get(kind) ?? 0) + 1)
  const lines: [string, string[]][] = [
    ['Hosts', hosts.map(host => reached.filter(entry => entry.host === host).every(entry => entry.declared) ? `${host} (declared)` : host)],
    ['Hosts not read for', [...counts].map(([kind, count]) => `${kind} (${count})`)],
    ['Hosts not declared', declared === undefined && unread.some(({ kind, reason }) => reason === 'process' && kind !== 'skills' && kind !== 'commands')
      ? ['list what these parts reach under "network.hosts" in plugin.json'] : []],
  ]
  return lines.flatMap(([label, values]) => values.length === 0 ? [] : [`${label}: ${values.join(', ')}`])
}

/**
 * What a plugin folder provides and the hosts its parts reach, or null when a
 * part of it could not be read. `results` are the folder's validation results,
 * whose hooks entries carry each module's scan.
 */
export async function listPluginProvides(pluginRoot: string, results: readonly ValidationResult[]): Promise<{ provides: PluginProvides; hosts: string[] } | null> {
  try {
    const plugin = await readComponents(pluginRoot)
    const listed = async (kind: string, list: () => Entry[] | Promise<Entry[]>) => {
      try { return byJson(await list()) } catch (error) {
        throw new Error(`Could not list the ${kind} of plugin ${plugin.name}: ${errorMessage(error)}`)
      }
    }
    const [mcp, lsp, skillList, commandList, agentList, styleList] = await Promise.all([
      listed('mcpServers', () => mcpServers(plugin)), listed('lspServers', () => lspServers(plugin)),
      listed('skills', () => skills(plugin)), listed('commands', () => commands(plugin)),
      listed('agents', () => agents(plugin)), listed('outputStyles', () => outputStyles(plugin)),
    ])
    const first = plugin.modules[0]
    const provides: PluginProvides = {
      modules: first === undefined ? [] : [{ path: modulePath(plugin, first) }], hooks: uniqueByJson(hooks(plugin)), mcpServers: uniqueByJson(mcp), lspServers: lsp,
      skills: skillList, commands: commandList, agents: agentList, outputStyles: styleList,
    }
    const scanned = results.flatMap(result => result.modules ?? []).find(module => first !== undefined && module.path === modulePath(plugin, first))
    return { provides, hosts: hostLines(provides, scanned ?? null, declaredHosts(plugin.network)) }
  } catch (error) {
    logForDebugging(`Could not list what the plugin provides: ${errorMessage(error)}`, { level: 'error' })
    return null
  }
}

/** One "<kind>: <values>" line per entry; a value that is a plain word is shown without JSON quotes. */
export function formatPluginProvides(provides: PluginProvides): string[] {
  return Object.entries(provides).flatMap(([kind, entries]) => entries.map(entry => {
    const values = (typeof entry === 'string' ? [entry] : Object.values(entry)).map(value => {
      const json = JSON.stringify(value)
      return /^"[^\s\\[\]]+"$/.test(json) ? json.slice(1, -1) : json
    })
    return `${kind}: ${values.join(' ')}`
  }))
}
