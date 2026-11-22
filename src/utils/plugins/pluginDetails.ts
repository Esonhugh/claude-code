import { open, readdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import {
  BUILTIN_MARKETPLACE_NAME,
  getBuiltinPluginDefinition,
} from '../../plugins/builtinPlugins.js'
import { roughTokenCountEstimation } from '../../services/tokenEstimation.js'
import type { LoadedPlugin } from '../../types/plugin.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { formatTokens } from '../format.js'
import {
  coerceDescriptionToString,
  parseFrontmatter,
} from '../frontmatterParser.js'
import { safeParseJSON } from '../json.js'
import { extractDescriptionFromMarkdown } from '../markdownConfigLoader.js'
import { containsPathTraversal } from '../path.js'
import { getInPlaceEscapeError } from './managedPlugins.js'
import { getPluginById } from './marketplaceManager.js'
import { isMcpbSource } from './mcpbHandler.js'
import { pluginDisplayName, printable } from './pluginConfigure.js'
import { parsePluginIdentifier } from './pluginIdentifier.js'

type TokenCost = { always_on: number; on_invoke: number }
type PluginComponent = { name: string; path?: string; chars?: TokenCost }
export type PluginInventory = {
  commands: PluginComponent[]
  agents: PluginComponent[]
  skills: PluginComponent[]
  hooks: string[]
  mcpServers: string[]
  lspServers: string[]
}

const MAX_COMPONENT_BYTES = 1024 * 1024

async function readHead(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const length = Math.min((await handle.stat()).size, MAX_COMPONENT_BYTES)
    const { bytesRead, buffer } = await handle.read(
      Buffer.alloc(length),
      0,
      length,
      0,
    )
    return buffer.toString('utf8', 0, bytesRead)
  } finally {
    await handle.close()
  }
}

const unreadable = (path: string, error: unknown) =>
  logForDebugging(
    `Failed to read plugin components from ${path}: ${errorMessage(error)}`,
    { level: 'error' },
  )

async function eachDirectory(
  directories: (string | undefined)[],
  visit: (directory: string) => Promise<void>,
): Promise<void> {
  for (const directory of directories) {
    if (!directory) continue
    try {
      await visit(directory)
    } catch (error) {
      unreadable(directory, error)
    }
  }
}

async function markdownFiles(
  directories: (string | undefined)[],
): Promise<PluginComponent[]> {
  const found = new Map<string, PluginComponent>()
  await eachDirectory(directories, async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const path = join(directory, entry.name)
      if (!found.has(resolve(path))) {
        found.set(resolve(path), { name: basename(entry.name, '.md'), path })
      }
    }
  })
  return [...found.values()]
}

/** Whether a plugin loaded in place must not read a file: it is outside its marketplace. */
const escapes = async (plugin: LoadedPlugin, path: string) =>
  (await getInPlaceEscapeError(plugin, path, 'details')) !== undefined

async function skillDirectories(
  directories: (string | undefined)[],
  plugin: LoadedPlugin,
): Promise<PluginComponent[]> {
  const pluginName = plugin.name
  const hasSkillFile = async (directory: string) => {
    const path = join(directory, 'SKILL.md')
    const isFile = await stat(path).then(
      file => file.isFile(),
      () => false,
    )
    return isFile && !(await escapes(plugin, path))
  }
  const found = new Map<string, PluginComponent>()
  const add = (name: string, path: string) => {
    if (!found.has(resolve(path))) found.set(resolve(path), { name, path })
  }
  await eachDirectory(directories, async directory => {
    if (await hasSkillFile(directory)) {
      let name = ''
      try {
        const declared = parseFrontmatter(
          await readHead(join(directory, 'SKILL.md')),
        ).frontmatter.name
        name = typeof declared === 'string' ? declared.trim() : ''
        if (name.startsWith(`${pluginName}:`)) {
          name = name.slice(pluginName.length + 1)
        }
      } catch {
        // An unreadable SKILL.md is listed under its directory name.
      }
      add(name || basename(directory), directory)
      return
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const path = join(directory, entry.name)
      if (await hasSkillFile(path)) add(entry.name, path)
    }
  })
  return [...found.values()]
}

const keysOf = (value: unknown): string[] =>
  [value]
    .flat()
    .filter(item => item != null && typeof item === 'object')
    .flatMap(item => Object.keys(item as object))

async function keysInFile(
  plugin: LoadedPlugin,
  file: string,
  wrapper?: string,
): Promise<string[]> {
  const path = join(plugin.path, file)
  if (await escapes(plugin, path)) return []
  try {
    const parsed = safeParseJSON(await readHead(path), false)
    if (parsed == null || typeof parsed !== 'object') return []
    const record = parsed as Record<string, unknown>
    const servers =
      wrapper && typeof record[wrapper] === 'object' ? record[wrapper] : record
    return servers == null ? [] : Object.keys(servers)
  } catch {
    return []
  }
}

async function mcpServerNames(plugin: LoadedPlugin): Promise<string[]> {
  const names = [await keysInFile(plugin, '.mcp.json', 'mcpServers')]
  for (const declared of [plugin.manifest.mcpServers ?? []].flat()) {
    if (typeof declared !== 'string') {
      names.push(keysOf(declared))
    } else if (!isMcpbSource(declared) && !containsPathTraversal(declared)) {
      names.push(await keysInFile(plugin, declared, 'mcpServers'))
    }
  }
  return names.flat()
}

/** The components a plugin ships, read from its files without loading them. */
export async function getPluginInventory(
  plugin: LoadedPlugin,
): Promise<PluginInventory> {
  const { name, marketplace } = parsePluginIdentifier(plugin.source)
  if (marketplace === BUILTIN_MARKETPLACE_NAME) {
    const builtin = getBuiltinPluginDefinition(plugin.name)
    if (!builtin) throw new Error(`Built-in plugin ${plugin.name} not found`)
    return {
      commands: [],
      agents: [],
      skills: builtin.skills?.map(skill => ({ name: skill.name })) ?? [],
      hooks: builtin.hooks ? Object.keys(builtin.hooks) : [],
      mcpServers: builtin.mcpServers ? Object.keys(builtin.mcpServers) : [],
      lspServers: [],
    }
  }
  // A marketplace entry can declare hooks and servers for a plugin whose own
  // files declare none.
  const entry =
    marketplace && marketplace !== 'inline'
      ? (await getPluginById(`${name || plugin.name}@${marketplace}`))?.entry
      : undefined
  if (!entry && marketplace !== 'inline') {
    throw new Error(
      `Plugin ${name || plugin.name} not found in marketplace ${marketplace}`,
    )
  }
  const [commands, agents, skills] = await Promise.all([
    markdownFiles([plugin.commandsPath, ...(plugin.commandsPaths ?? [])]),
    markdownFiles([plugin.agentsPath, ...(plugin.agentsPaths ?? [])]),
    skillDirectories(
      [plugin.skillsPath, ...(plugin.skillsPaths ?? [])],
      plugin,
    ),
  ])
  const orDeclared = (names: string[], declared: unknown) =>
    names.length > 0 ? [...new Set(names)] : keysOf(declared)
  return {
    commands,
    agents,
    skills,
    hooks: plugin.hooksConfig
      ? Object.keys(plugin.hooksConfig)
      : keysOf(entry?.hooks),
    mcpServers: orDeclared(
      plugin.mcpServers
        ? Object.keys(plugin.mcpServers)
        : await mcpServerNames(plugin),
      entry?.mcpServers,
    ),
    lspServers: orDeclared(
      plugin.lspServers
        ? Object.keys(plugin.lspServers)
        : [
            ...(await keysInFile(plugin, '.lsp.json')),
            ...keysOf(plugin.manifest.lspServers),
          ],
      entry?.lspServers,
    ),
  }
}

/** What a component adds to every session, and what it adds when it runs. */
async function componentText(
  path: string | undefined,
  name: string,
): Promise<{ alwaysOn: string; onInvoke: string }> {
  if (!path) return { alwaysOn: '', onInvoke: '' }
  let markdown: string
  try {
    markdown = await readHead(path)
  } catch (error) {
    unreadable(path, error)
    return { alwaysOn: '', onInvoke: '' }
  }
  const { frontmatter, content } = parseFrontmatter(markdown, path)
  const whenToUse = frontmatter.when_to_use ?? frontmatter['when-to-use']
  return {
    alwaysOn: [
      name,
      coerceDescriptionToString(frontmatter.description, name) ??
        extractDescriptionFromMarkdown(content, 'Skill'),
      whenToUse != null ? String(whenToUse) : undefined,
    ]
      .filter(Boolean)
      .join(' '),
    onInvoke: content.trim(),
  }
}

const invocationName = (pluginName: string, name: string) =>
  `${pluginName}:${name.replace(/[^a-zA-Z0-9_-]/g, '-')}`

/**
 * Add each skill, agent and command's size in characters, and return the two
 * texts whose tokens the API can count.
 */
export async function measurePluginComponents(
  inventory: PluginInventory,
  pluginName: string,
): Promise<PluginInventory & { alwaysOnText: string; onInvokeText: string }> {
  const read = (
    components: PluginComponent[],
    text: (component: PluginComponent) => ReturnType<typeof componentText>,
  ) => Promise.all(components.map(text))
  const [skills, agents, commands] = await Promise.all([
    read(inventory.skills, skill =>
      componentText(
        skill.path && join(skill.path, 'SKILL.md'),
        invocationName(pluginName, skill.name),
      ),
    ),
    read(inventory.agents, agent => componentText(agent.path, agent.name)),
    read(inventory.commands, command =>
      componentText(command.path, invocationName(pluginName, command.name)),
    ),
  ])
  const measured = (
    components: PluginComponent[],
    texts: Awaited<ReturnType<typeof componentText>>[],
  ) =>
    components.map((component, index) => ({
      ...component,
      chars: {
        always_on: texts[index]!.alwaysOn.length,
        on_invoke: texts[index]!.onInvoke.length,
      },
    }))
  const all = [...skills, ...agents, ...commands]
  return {
    ...inventory,
    skills: measured(inventory.skills, skills),
    agents: measured(inventory.agents, agents),
    commands: measured(inventory.commands, commands),
    alwaysOnText: all
      .map(text => text.alwaysOn)
      .filter(Boolean)
      .join('\n'),
    onInvokeText: all
      .map(text => text.onInvoke)
      .filter(Boolean)
      .join('\n\n'),
  }
}

/** A component's share of the counted tokens, or an estimate from its size. */
function scaleCharsToTokens(
  chars: number,
  totalChars: number,
  totalTokens: number | undefined,
): number {
  return totalTokens !== undefined && totalChars > 0
    ? Math.round((chars / totalChars) * totalTokens)
    : roughTokenCountEstimation(' '.repeat(chars))
}

const formatTokenEstimate = (tokens: number) =>
  tokens < 20 ? '< 20' : `~${formatTokens(Math.round(tokens / 10) * 10)}`

/** The text `claude plugin details <name>` prints. */
export function formatPluginDetails(
  plugin: LoadedPlugin,
  inventory: PluginInventory,
  tokens: TokenCost | undefined,
): string {
  const displayName = pluginDisplayName(plugin.manifest)
  const title =
    displayName === plugin.name
      ? plugin.name
      : `${displayName} (${plugin.name})`
  const lines = [`${title} ${plugin.manifest.version ?? ''}`.trimEnd()]
  if (plugin.manifest.description) {
    const [first, ...rest] = plugin.manifest.description.split('\n')
    lines.push(`  Description: ${first}`, ...rest.map(line => `      ${line}`))
  }
  lines.push(`  Source: ${plugin.source}`, '', 'Component inventory')
  const rows: [string, string[], string][] = [
    [
      'Skills',
      [...inventory.skills, ...inventory.commands].map(c => c.name).sort(),
      '',
    ],
    ['Agents', inventory.agents.map(agent => agent.name), ''],
    ['Hooks', inventory.hooks, '  (harness-only — no model context cost)'],
    [
      'MCP servers',
      inventory.mcpServers,
      '  (tool schemas resolved at runtime; not counted)',
    ],
    ['LSP servers', inventory.lspServers, '  (no model context cost)'],
  ]
  for (const [label, names, note] of rows) {
    lines.push(
      `  ${label} (${names.length})${names.length > 0 ? `  ${names.join(', ')}${note}` : ''}`,
    )
  }
  const measured = [
    ...inventory.skills,
    ...inventory.agents,
    ...inventory.commands,
  ].flatMap(component =>
    component.chars ? [{ name: component.name, chars: component.chars }] : [],
  )
  const total = {
    always_on: measured.reduce((sum, c) => sum + c.chars.always_on, 0),
    on_invoke: measured.reduce((sum, c) => sum + c.chars.on_invoke, 0),
  }
  const alwaysOn =
    tokens?.always_on ??
    scaleCharsToTokens(total.always_on, total.always_on, undefined)
  lines.push(
    '',
    'Projected token cost',
    `  Always-on:   ~${alwaysOn.toLocaleString()} tok   added to every session`,
  )
  if (measured.length > 0) {
    const width = Math.max(...measured.map(c => c.name.length), 9)
    const cell = (kind: keyof TokenCost, chars: TokenCost) =>
      formatTokenEstimate(
        scaleCharsToTokens(chars[kind], total[kind], tokens?.[kind]),
      ).padStart(9)
    lines.push(
      '',
      'Per-component (rounded)',
      `  ${'component'.padEnd(width)}  always-on  on-invoke`,
      ...measured.map(
        c =>
          `  ${c.name.padEnd(width)}  ${cell('always_on', c.chars)}  ${cell('on_invoke', c.chars)}`,
      ),
      '',
      '  On-invoke cost is paid each time a skill or agent fires.',
      '  Token counts are estimates and may differ from actual usage.',
    )
  }
  return lines.map(printable).join('\n')
}
