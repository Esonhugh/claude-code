import type { Command } from '../commands.js'
import {
  CODEX_APPS_PLUGIN_RUNTIME_SERVER_NAME,
  CODEX_APPS_SERVER_NAME,
} from '../services/apps/types.js'
import { isHostOwnedCodexAppsConfig } from '../services/apps/trust.js'
import type { ConnectedMCPServer } from '../services/mcp/types.js'
import { logForDebugging } from '../utils/debug.js'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { withTimeout } from '../utils/sleep.js'
import { getMCPSkillBuilders } from './mcpSkillBuilders.js'

const SKILL_MIME_TYPE = 'mcp/skill'
const DISCOVERY_TIMEOUT_MS = 10_000
const READ_TIMEOUT_MS = 10_000
const MAX_RESOURCE_PAGES = 10
const MAX_SKILLS = 100
const MAX_SKILL_NAME_CHARS = 64
const MAX_QUALIFIED_NAME_CHARS = 128
const MAX_PACKAGE_URI_CHARS = 1_024
const MAX_RESOURCE_URI_CHARS = 2_048
const MAX_RESOURCE_CONTENT_BYTES = 1024 * 1024
const MAX_CACHED_SERVERS = 20
const CACHE_TTL_MS = 30_000

type SkillDescriptor = {
  name: string
  description: string
  resourceUri: string
}

type SkillCacheEntry = {
  client: ConnectedMCPServer['client']
  expiresAt: number
  promise: Promise<Command[]>
}

type FetchMcpSkillsForClient = ((
  client: ConnectedMCPServer,
) => Promise<Command[]>) & {
  cache: Map<string, SkillCacheEntry>
  clearCacheForServer: (name: string) => void
}

type McpSkillClientResolver = (
  client: ConnectedMCPServer,
) => Promise<ConnectedMCPServer>

let resolveMcpSkillClient: McpSkillClientResolver = async client => client

export function registerMcpSkillClientResolver(
  resolver: McpSkillClientResolver,
): void {
  resolveMcpSkillClient = resolver
}

function charCount(value: string): number {
  return [...value].length
}

function normalizedLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.split(/\s+/u).filter(Boolean).join(' ')
  if (
    normalized.length === 0 ||
    charCount(normalized) > MAX_SKILL_NAME_CHARS ||
    /[&<>\p{Cc}]/u.test(normalized)
  ) {
    return null
  }
  return normalized
}

function normalizedDescription(value: unknown): string | null {
  if (typeof value !== 'string') return ''
  const normalized = value.split(/\s+/u).filter(Boolean).join(' ')
  if (/\p{Cc}/u.test(normalized)) return null
  return normalized
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
}

function validatedSkillUrl(value: string, maxChars: number): URL | null {
  if (
    charCount(value) > maxChars ||
    /[\s<>]/u.test(value) ||
    [...value].some(char => /\p{Cc}/u.test(char))
  ) {
    return null
  }

  try {
    const url = new URL(value)
    const segments = url.pathname.split('/').slice(1)
    if (
      url.protocol !== 'skill:' ||
      url.href !== value ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      segments.length === 0 ||
      segments.some(segment => segment.length === 0)
    ) {
      return null
    }
    return url
  } catch {
    return null
  }
}

function descriptorFromResource(resource: {
  uri: string
  description?: string
  mimeType?: string
  _meta?: Record<string, unknown>
}): SkillDescriptor | null {
  if (resource.mimeType !== SKILL_MIME_TYPE) return null
  const packageUrl = validatedSkillUrl(resource.uri, MAX_PACKAGE_URI_CHARS)
  if (!packageUrl) return null

  const skillName = normalizedLabel(resource._meta?.skill_name)
  if (!skillName) return null

  let name = skillName
  if (resource._meta?.source !== 'user') {
    const pluginName = normalizedLabel(resource._meta?.plugin_name)
    if (!pluginName) return null
    name = `${pluginName}:${skillName}`
    if (charCount(name) > MAX_QUALIFIED_NAME_CHARS) return null
  }

  const description = normalizedDescription(resource.description)
  if (description === null) return null

  const resourceUri = `${packageUrl.href.replace(/\/$/u, '')}/SKILL.md`
  if (!validatedSkillUrl(resourceUri, MAX_RESOURCE_URI_CHARS)) return null

  return {
    name,
    description,
    resourceUri,
  }
}

async function discoverSkillDescriptors(
  client: ConnectedMCPServer,
): Promise<SkillDescriptor[] | null> {
  const descriptors: SkillDescriptor[] = []
  const seenNames = new Set<string>()
  const seenCursors = new Set<string>()
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS
  let skillResourcesSeen = 0
  let cursor: string | undefined

  for (let page = 0; page < MAX_RESOURCE_PAGES; page++) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break

    let result: Awaited<ReturnType<typeof client.client.listResources>>
    try {
      result = await withTimeout(
        client.client.listResources(cursor ? { cursor } : undefined),
        remaining,
        'Codex Apps skill discovery timed out',
      )
    } catch (error) {
      logForDebugging(
        `[mcp-skills] Failed to list Codex Apps skill resources: ${error}`,
        { level: 'warn' },
      )
      if (page === 0) return null
      break
    }

    for (const resource of result.resources) {
      if (resource.mimeType !== SKILL_MIME_TYPE) continue
      if (skillResourcesSeen >= MAX_SKILLS) break
      skillResourcesSeen++
      const descriptor = descriptorFromResource(resource)
      if (!descriptor || seenNames.has(descriptor.name)) continue
      seenNames.add(descriptor.name)
      descriptors.push(descriptor)
    }

    if (skillResourcesSeen >= MAX_SKILLS || !result.nextCursor) break
    if (seenCursors.has(result.nextCursor)) break
    seenCursors.add(result.nextCursor)
    cursor = result.nextCursor
  }

  return descriptors
}

async function readSkillContent(
  client: ConnectedMCPServer,
  descriptor: SkillDescriptor,
): Promise<string> {
  const connectedClient = await resolveMcpSkillClient(client)
  const result = await withTimeout(
    connectedClient.client.readResource({ uri: descriptor.resourceUri }),
    READ_TIMEOUT_MS,
    'Codex Apps skill read timed out',
  )
  const text = result.contents.find(
    (content): content is Extract<typeof content, { text: string }> =>
      content.uri === descriptor.resourceUri &&
      'text' in content &&
      typeof content.text === 'string',
  )
  if (!text) {
    throw new Error('Codex Apps skill did not return matching text content')
  }
  if (
    new TextEncoder().encode(text.text).byteLength > MAX_RESOURCE_CONTENT_BYTES
  ) {
    throw new Error('Codex Apps skill exceeds the resource content limit')
  }
  return text.text
}

function buildSkillCommand(
  client: ConnectedMCPServer,
  descriptor: SkillDescriptor,
): Command {
  const { createSkillCommand, parseSkillFrontmatterFields } =
    getMCPSkillBuilders()

  type PromptCommand = Extract<Command, { type: 'prompt' }>
  const createSafeCommand = (markdown: string): PromptCommand => {
    const { frontmatter, content: markdownContent } = parseFrontmatter(
      markdown,
      descriptor.resourceUri,
    )
    const parsed = parseSkillFrontmatterFields(
      frontmatter,
      markdownContent,
      descriptor.name,
    )
    const command = createSkillCommand({
      ...parsed,
      // Resource metadata is the trusted catalog surface. SKILL.md frontmatter
      // is prompt content, not authority over listing or execution behavior.
      displayName: undefined,
      description: descriptor.description,
      hasUserSpecifiedDescription: true,
      whenToUse: undefined,
      version: undefined,
      allowedTools: [],
      model: undefined,
      disableModelInvocation: false,
      userInvocable: true,
      hooks: undefined,
      executionContext: undefined,
      agent: undefined,
      effort: undefined,
      shell: undefined,
      skillName: descriptor.name,
      markdownContent,
      source: 'mcp',
      baseDir: undefined,
      loadedFrom: 'mcp',
      paths: undefined,
    }) as PromptCommand
    return { ...command, mcpServerName: client.name }
  }

  const command = createSafeCommand('')
  return {
    ...command,
    contentLength: 0,
    async getPromptForCommand(args, context) {
      try {
        const markdown = await readSkillContent(client, descriptor)
        return createSafeCommand(markdown).getPromptForCommand(args, context)
      } catch (error) {
        logForDebugging(
          `[mcp-skills] Failed to read Codex Apps skill ${descriptor.name}: ${error}`,
          { level: 'warn' },
        )
        throw error
      }
    },
  }
}

async function loadSkills(
  client: ConnectedMCPServer,
): Promise<Command[] | null> {
  if (
    (client.name !== CODEX_APPS_SERVER_NAME &&
      client.name !== CODEX_APPS_PLUGIN_RUNTIME_SERVER_NAME) ||
    !client.capabilities.resources ||
    !isHostOwnedCodexAppsConfig(client.config)
  ) {
    return []
  }

  const descriptors = await discoverSkillDescriptors(client)
  if (!descriptors) return null
  return descriptors.map(descriptor => buildSkillCommand(client, descriptor))
}

const fetchImpl = (async (client: ConnectedMCPServer) => {
  const cached = fetchImpl.cache.get(client.name)
  if (
    cached &&
    cached.client === client.client &&
    cached.expiresAt > Date.now()
  ) {
    fetchImpl.cache.delete(client.name)
    fetchImpl.cache.set(client.name, cached)
    return cached.promise
  }
  if (cached) {
    fetchImpl.cache.delete(client.name)
  }

  const clientIdentity = client.client
  const promise = loadSkills(client).then(skills => {
    if (skills) return skills
    if (fetchImpl.cache.get(client.name)?.client === clientIdentity) {
      fetchImpl.cache.delete(client.name)
    }
    return []
  })
  if (fetchImpl.cache.size >= MAX_CACHED_SERVERS) {
    const oldest = fetchImpl.cache.keys().next().value
    if (oldest !== undefined) fetchImpl.cache.delete(oldest)
  }
  fetchImpl.cache.set(client.name, {
    client: client.client,
    expiresAt: Date.now() + CACHE_TTL_MS,
    promise,
  })
  return promise
}) as FetchMcpSkillsForClient

fetchImpl.cache = new Map()
fetchImpl.clearCacheForServer = (name: string) => {
  fetchImpl.cache.delete(name)
}

export const fetchMcpSkillsForClient = fetchImpl
