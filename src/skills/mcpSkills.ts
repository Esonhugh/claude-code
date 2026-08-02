import type { Command } from '../commands.js'
import { isDeepStrictEqual } from 'node:util'
import {
  CODEX_APPS_PLUGIN_RUNTIME_SERVER_NAME,
  CODEX_APPS_SERVER_NAME,
} from '../services/apps/types.js'
import { isHostOwnedCodexAppsConfig } from '../services/apps/trust.js'
import { serverDeclaresDirectoryRead } from '../services/mcp/directoryRead.js'
import type { ConnectedMCPServer } from '../services/mcp/types.js'
import { logForDebugging } from '../utils/debug.js'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { partiallySanitizeUnicode } from '../utils/sanitization.js'
import { withTimeout } from '../utils/sleep.js'
import { z } from 'zod/v4'
import { getMCPSkillBuilders } from './mcpSkillBuilders.js'
import { createMcpSkillResourceRules } from './mcpSkillResourceGrant.js'
import {
  hashMcpSkillContent,
  MAX_MCP_SKILL_CONTENT_BYTES,
  readMcpSkillDiskCache,
  writeMcpSkillDiskCache,
} from './mcpSkillDiskCache.js'

const SKILL_MIME_TYPE = 'mcp/skill'
const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills'
const DISCOVERY_TIMEOUT_MS = 10_000
const READ_TIMEOUT_MS = 10_000
const MAX_CODEX_APP_RESOURCE_PAGES = 10
const MAX_SKILL_LIST_PAGES = 20
const MAX_SKILLS = 100
const MAX_SKILL_RESOURCES = 1_000
const MAX_SKILL_NAME_CHARS = 64
const MAX_QUALIFIED_NAME_CHARS = 128
const MAX_PACKAGE_URI_CHARS = 1_024
const MAX_RESOURCE_URI_CHARS = 2_048
const MAX_SKILL_ENTRY_FIELD_CHARS = 4_096
const MAX_CACHED_SERVERS = 20
const CACHE_TTL_MS = 30_000

const SkillResourceSchema = z.object({
  uri: z.string(),
  digest: z.string(),
})

const SkillsListEntrySchema = z.object({
  uri: z.string(),
  digest: z.string().nullish(),
  frontmatter: z.record(z.string(), z.unknown()),
  resources: z.array(SkillResourceSchema).optional(),
})

const SkillsListResultSchema = z.object({
  skills: z.array(z.unknown()),
  nextCursor: z.string().optional(),
})

const SkillsGetResultSchema = z.object({
  skill: z.unknown(),
})

type SkillResource = {
  uri: string
  digest: string
}

type SkillDescriptor = {
  name: string
  description: string
  resourceUri: string
  loadedFrom: 'mcp' | 'codex_app'
  digest?: string
  frontmatter?: Record<string, unknown>
  resources?: SkillResource[]
}

export type McpSkillUriReference = {
  server: string
  uri: string
  commandName: string
}

type SkillCacheEntry = {
  client: ConnectedMCPServer['client']
  expiresAt: number
  promise: Promise<Command[]>
}

type DirectSkillCacheEntry = {
  client: ConnectedMCPServer['client']
  expiresAt: number
  promise: Promise<Command | null>
}

const directSkillCache = new Map<string, DirectSkillCacheEntry>()

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

export function clearMcpSkillUriCache(): void {
  directSkillCache.clear()
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
      url.protocol === 'file:' ||
      url.href !== value ||
      !url.hostname ||
      url.username ||
      url.password ||
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

function skillPathFromUri(uri: string): string | null {
  const parsed = validatedSkillUrl(uri, MAX_RESOURCE_URI_CHARS)
  if (!parsed || !parsed.pathname.endsWith('/SKILL.md')) return null
  return [
    parsed.host,
    ...parsed.pathname.split('/').filter(Boolean).slice(0, -1),
  ].join('/')
}

function skillNameFromUri(uri: string): string | null {
  const skillPath = skillPathFromUri(uri)
  const skillSegment = skillPath?.split('/').at(-1)
  if (!skillSegment) return null

  try {
    return decodeURIComponent(skillSegment)
  } catch {
    return null
  }
}

function validatedSkillResourceUri(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    charCount(value) > MAX_RESOURCE_URI_CHARS ||
    /[\s<>]/u.test(value) ||
    [...value].some(char => /\p{Cc}/u.test(char))
  ) {
    return null
  }
  return skillNameFromUri(value) ? value : null
}

export function parseMcpSkillUriReference(
  value: string,
  clients: readonly ConnectedMCPServer[],
): McpSkillUriReference | null {
  for (const client of [...clients].sort((a, b) => b.name.length - a.name.length)) {
    const prefix = `${client.name}:`
    if (!value.startsWith(prefix)) continue
    const uri = validatedSkillResourceUri(value.slice(prefix.length))
    const skillPath = uri ? skillPathFromUri(uri) : null
    if (
      !uri ||
      !skillPath ||
      isCodexAppsClient(client) ||
      !isSkillExtensionSupported(client)
    ) {
      return null
    }
    const commandName = `${client.name}:${skillPath}`
    if (charCount(commandName) > MAX_QUALIFIED_NAME_CHARS) return null
    return { server: client.name, uri, commandName }
  }
  return null
}

function isSkillExtensionSupported(client: ConnectedMCPServer): boolean {
  return client.capabilities.extensions?.[SKILLS_EXTENSION] !== undefined
}

function isCodexAppsClient(client: ConnectedMCPServer): boolean {
  return (
    (client.name === CODEX_APPS_SERVER_NAME ||
      client.name === CODEX_APPS_PLUGIN_RUNTIME_SERVER_NAME) &&
    isHostOwnedCodexAppsConfig(client.config)
  )
}

function skillUrisFromInstructions(instructions: string | undefined): string[] {
  if (!instructions) return []
  const matches = instructions.matchAll(
    /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`]+?\/SKILL\.md/gu,
  )
  const uris = new Set<string>()
  for (const match of matches) {
    const uri = match[0]
    if (validatedSkillResourceUri(uri)) uris.add(uri)
    if (uris.size >= MAX_SKILLS) break
  }
  return [...uris]
}

function validatedSkillEntryDigest(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (charCount(value) > MAX_SKILL_ENTRY_FIELD_CHARS) return undefined
  const match = /^(?:sha256:)?([0-9a-fA-F]{64})$/u.exec(value.trim())
  return match?.[1]?.toLowerCase()
}

function validatedManifestDigest(value: string): string | null {
  if (charCount(value) > MAX_SKILL_ENTRY_FIELD_CHARS) return null
  return /^sha256:([0-9a-f]{64})$/u.exec(value)?.[1] ?? null
}

function validatedSkillResources(
  skillUri: string,
  resources: Array<{ uri: string; digest: string }>,
): SkillResource[] | null {
  if (resources.length === 0 || resources.length > MAX_SKILL_RESOURCES) {
    return null
  }

  const skillUrl = validatedSkillUrl(skillUri, MAX_RESOURCE_URI_CHARS)
  if (!skillUrl) return null
  const directoryPath = skillUrl.pathname.slice(0, -'SKILL.md'.length)
  const seenUris = new Set<string>()
  const validated: SkillResource[] = []

  for (const resource of resources) {
    const url = validatedSkillUrl(resource.uri, MAX_RESOURCE_URI_CHARS)
    const digest = validatedManifestDigest(resource.digest)
    if (
      !url ||
      !digest ||
      url.protocol !== skillUrl.protocol ||
      url.host !== skillUrl.host ||
      !url.pathname.startsWith(directoryPath) ||
      seenUris.has(resource.uri)
    ) {
      return null
    }
    seenUris.add(resource.uri)
    validated.push({ uri: resource.uri, digest })
  }

  return seenUris.has(skillUri) ? validated : null
}

function descriptorFromSkillEntry(
  entry: {
    uri: string
    digest?: string | null
    frontmatter: Record<string, unknown>
    resources?: Array<{ uri: string; digest: string }>
  },
  serverName: string,
): SkillDescriptor | null {
  if (charCount(entry.uri) > MAX_SKILL_ENTRY_FIELD_CHARS) return null
  if (
    entry.digest !== undefined &&
    entry.digest !== null &&
    !validatedSkillEntryDigest(entry.digest)
  ) {
    return null
  }

  const resourceUri = validatedSkillResourceUri(entry.uri)
  const skillName = normalizedLabel(entry.frontmatter.name)
  const uriSkillName = resourceUri ? skillNameFromUri(resourceUri) : null
  if (!resourceUri || !skillName || skillName !== uriSkillName) return null

  const description = normalizedDescription(entry.frontmatter.description)
  if (description === null) return null

  const name = `${serverName}:${skillName}`
  if (charCount(name) > MAX_QUALIFIED_NAME_CHARS) return null

  const resources = entry.resources
    ? validatedSkillResources(resourceUri, entry.resources)
    : undefined
  if (entry.resources && !resources) return null
  const skillResource = resources?.find(resource => resource.uri === resourceUri)

  return {
    name,
    description,
    resourceUri,
    loadedFrom: 'mcp',
    digest: skillResource?.digest ?? validatedSkillEntryDigest(entry.digest),
    frontmatter: entry.frontmatter,
    resources,
  }
}

function disambiguateSkillDescriptorNames(
  descriptors: SkillDescriptor[],
  serverName: string,
): SkillDescriptor[] {
  const duplicateNames = new Set(
    descriptors
      .map(descriptor => descriptor.name)
      .filter(
        (name, index, names) =>
          names.indexOf(name) !== index,
      ),
  )
  if (duplicateNames.size === 0) return descriptors

  const names = new Map<SkillDescriptor, string>()
  for (const duplicateName of duplicateNames) {
    const group = descriptors.filter(
      descriptor => descriptor.name === duplicateName,
    )
    const paths = group.map(descriptor => {
      const url = validatedSkillUrl(
        descriptor.resourceUri,
        MAX_RESOURCE_URI_CHARS,
      )!
      return [
        url.host,
        ...url.pathname.split('/').filter(Boolean).slice(0, -1),
      ]
    })
    const maxSegments = Math.max(...paths.map(path => path.length))
    let suffixes: string[] | null = null

    for (let length = 2; length <= maxSegments; length++) {
      const candidates = paths.map(path => path.slice(-length).join('/'))
      if (new Set(candidates).size === candidates.length) {
        suffixes = candidates
        break
      }
    }

    group.forEach((descriptor, index) => {
      names.set(
        descriptor,
        suffixes
          ? `${serverName}:${suffixes[index]}`
          : `${serverName}:${descriptor.resourceUri}`,
      )
    })
  }

  return descriptors.map(descriptor =>
    names.has(descriptor)
      ? { ...descriptor, name: names.get(descriptor)! }
      : descriptor,
  )
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
    loadedFrom: 'codex_app',
  }
}

async function getSkillDescriptorByUri(
  client: ConnectedMCPServer,
  uri: string,
  timeoutMs = READ_TIMEOUT_MS,
): Promise<SkillDescriptor | null> {
  if (
    isCodexAppsClient(client) ||
    !isSkillExtensionSupported(client) ||
    !validatedSkillResourceUri(uri)
  ) {
    return null
  }

  try {
    const result = await withTimeout(
      client.client.request(
        { method: 'skills/get', params: { uri } },
        SkillsGetResultSchema,
      ),
      timeoutMs,
      'MCP skill retrieval timed out',
    )
    const parsedEntry = SkillsListEntrySchema.safeParse(result.skill)
    if (!parsedEntry.success || parsedEntry.data.uri !== uri) return null
    return descriptorFromSkillEntry(parsedEntry.data, client.name)
  } catch (error) {
    logForDebugging(
      `[mcp-skills] Failed to get skill ${uri} from ${client.name}: ${error}`,
      { level: 'warn' },
    )
    return null
  }
}

async function discoverSkillDescriptorsFromExtension(
  client: ConnectedMCPServer,
): Promise<SkillDescriptor[] | null> {
  const descriptors: SkillDescriptor[] = []
  const seenUris = new Set<string>()
  const seenCursors = new Set<string>()
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS
  let cursor: string | undefined

  for (let page = 0; page < MAX_SKILL_LIST_PAGES; page++) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break

    let result: z.output<typeof SkillsListResultSchema>
    try {
      result = await withTimeout(
        client.client.request(
          {
            method: 'skills/list',
            params: cursor ? { cursor } : {},
          },
          SkillsListResultSchema,
        ),
        remaining,
        'MCP skill discovery timed out',
      )
    } catch (error) {
      logForDebugging(
        `[mcp-skills] Failed to list skills from ${client.name}: ${error}`,
        { level: 'warn' },
      )
      if (page === 0) return null
      break
    }

    for (const candidate of result.skills) {
      if (descriptors.length >= MAX_SKILLS) break
      const parsedEntry = SkillsListEntrySchema.safeParse(candidate)
      if (!parsedEntry.success) continue
      const descriptor = descriptorFromSkillEntry(parsedEntry.data, client.name)
      if (!descriptor || seenUris.has(descriptor.resourceUri)) continue
      seenUris.add(descriptor.resourceUri)
      descriptors.push(descriptor)
    }

    if (descriptors.length >= MAX_SKILLS || !result.nextCursor) break
    if (seenCursors.has(result.nextCursor)) break
    seenCursors.add(result.nextCursor)
    cursor = result.nextCursor
  }

  for (const uri of skillUrisFromInstructions(client.instructions)) {
    if (descriptors.length >= MAX_SKILLS || seenUris.has(uri)) continue
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const descriptor = await getSkillDescriptorByUri(client, uri, remaining)
    if (!descriptor) continue
    seenUris.add(descriptor.resourceUri)
    descriptors.push(descriptor)
  }

  return disambiguateSkillDescriptorNames(descriptors, client.name)
}

async function discoverCodexAppSkillDescriptors(
  client: ConnectedMCPServer,
): Promise<SkillDescriptor[] | null> {
  const descriptors: SkillDescriptor[] = []
  const seenNames = new Set<string>()
  const seenCursors = new Set<string>()
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS
  let skillResourcesSeen = 0
  let cursor: string | undefined

  for (let page = 0; page < MAX_CODEX_APP_RESOURCE_PAGES; page++) {
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
    'MCP skill read timed out',
  )
  const text = result.contents.find(
    (content): content is Extract<typeof content, { text: string }> =>
      content.uri === descriptor.resourceUri &&
      'text' in content &&
      typeof content.text === 'string',
  )
  if (!text) {
    throw new Error('MCP skill did not return matching text content')
  }
  if (
    Buffer.byteLength(text.text, 'utf8') > MAX_MCP_SKILL_CONTENT_BYTES
  ) {
    throw new Error('MCP skill exceeds the resource content limit')
  }
  return text.text
}

function sanitizeMcpSkillPromptText(text: string): string {
  return text
    .replace(/\p{Cc}/gu, character =>
      character === '\t' || character === '\n' || character === '\r'
        ? character
        : '',
    )
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
}

function verifySkillFrontmatter(
  descriptor: SkillDescriptor,
  markdown: string,
): void {
  if (!descriptor.frontmatter) return
  const { frontmatter } = parseFrontmatter(
    partiallySanitizeUnicode(markdown),
    descriptor.resourceUri,
  )
  if (!isDeepStrictEqual(frontmatter, descriptor.frontmatter)) {
    throw new Error('MCP skill frontmatter mismatch')
  }
}

function buildSkillCommand(
  client: ConnectedMCPServer,
  descriptor: SkillDescriptor,
  markdown: string,
): Command {
  const { createSkillCommand, parseSkillFrontmatterFields } =
    getMCPSkillBuilders()

  type PromptCommand = Extract<Command, { type: 'prompt' }>
  const sanitizedMarkdown = partiallySanitizeUnicode(markdown)
  const { frontmatter, content } = parseFrontmatter(
    sanitizedMarkdown,
    descriptor.resourceUri,
  )
  const markdownContent = sanitizeMcpSkillPromptText(content)
  const parsed = parseSkillFrontmatterFields(
    frontmatter,
    markdownContent,
    descriptor.name,
  )
  const sanitizedParsed = {
    ...parsed,
    argumentHint:
      parsed.argumentHint === undefined
        ? undefined
        : sanitizeMcpSkillPromptText(parsed.argumentHint),
    argumentNames: parsed.argumentNames.map(sanitizeMcpSkillPromptText),
  }
  const command = createSkillCommand({
    ...sanitizedParsed,
    // Catalog metadata is trusted for listing; SKILL.md frontmatter is prompt content.
    displayName: undefined,
    description: descriptor.description,
    hasUserSpecifiedDescription: true,
    whenToUse: undefined,
    version: undefined,
    allowedTools:
      descriptor.loadedFrom === 'mcp'
        ? createMcpSkillResourceRules(
            client.name,
            descriptor.resourceUri,
            descriptor.resources ?? [],
          )
        : [],
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
    mcpResourceRoot:
      descriptor.loadedFrom === 'mcp'
        ? {
            server: client.name,
            uri: descriptor.resourceUri.slice(0, -'/SKILL.md'.length),
            directoryRead: serverDeclaresDirectoryRead(client.capabilities),
          }
        : undefined,
    loadedFrom: descriptor.loadedFrom,
    paths: undefined,
  }) as PromptCommand
  return { ...command, mcpServerName: client.name }
}

function buildLazySkillCommand(
  client: ConnectedMCPServer,
  descriptor: SkillDescriptor,
): Extract<Command, { type: 'prompt' }> {
  const command = buildSkillCommand(
    client,
    descriptor,
    '',
  ) as Extract<Command, { type: 'prompt' }>
  return {
    ...command,
    contentLength: 0,
    async getPromptForCommand(args, context) {
      try {
        const markdown = await readSkillContent(client, descriptor)
        const resolvedCommand = buildSkillCommand(
          client,
          descriptor,
          markdown,
        ) as Extract<Command, { type: 'prompt' }>
        return resolvedCommand.getPromptForCommand(args, context)
      } catch (error) {
        logForDebugging(
          `[mcp-skills] Failed to read MCP skill ${descriptor.name}: ${error}`,
          { level: 'warn' },
        )
        throw error
      }
    },
  }
}

async function buildEagerSkillCommand(
  client: ConnectedMCPServer,
  descriptor: SkillDescriptor,
): Promise<Command | null> {
  try {
    const cached = descriptor.resources || descriptor.digest
      ? await readMcpSkillDiskCache(client.name, descriptor)
      : null
    const markdown = cached?.skillMd ?? (await readSkillContent(client, descriptor))
    const contentHash = hashMcpSkillContent(markdown)
    if (descriptor.digest && descriptor.digest !== contentHash) {
      throw new Error('MCP skill digest mismatch')
    }
    verifySkillFrontmatter(descriptor, markdown)
    if (!cached && (descriptor.resources || descriptor.digest)) {
      await writeMcpSkillDiskCache(client.name, descriptor, markdown).catch(
        error => {
          logForDebugging(
            `[mcp-skills] Failed to cache MCP skill ${descriptor.name}: ${error}`,
            { level: 'warn' },
          )
        },
      )
    }
    return buildSkillCommand(client, descriptor, markdown)
  } catch (error) {
    logForDebugging(
      `[mcp-skills] Failed to load MCP skill ${descriptor.name}: ${error}`,
      { level: 'warn' },
    )
    return null
  }
}

export async function fetchMcpSkillCommandByUri(
  client: ConnectedMCPServer,
  uri: string,
): Promise<Command | null> {
  const key = `${client.name}\0${uri}`
  const cached = directSkillCache.get(key)
  if (
    cached &&
    cached.client === client.client &&
    cached.expiresAt > Date.now()
  ) {
    return cached.promise
  }
  const promise = getSkillDescriptorByUri(client, uri).then(descriptor => {
    if (!descriptor) return null
    const skillPath = skillPathFromUri(uri)
    if (!skillPath) return null
    const name = `${client.name}:${skillPath}`
    if (charCount(name) > MAX_QUALIFIED_NAME_CHARS) return null
    return buildEagerSkillCommand(client, { ...descriptor, name })
  })
  directSkillCache.set(key, {
    client: client.client,
    expiresAt: Date.now() + CACHE_TTL_MS,
    promise,
  })
  return promise
}

async function loadSkills(
  client: ConnectedMCPServer,
): Promise<Command[] | null> {
  if (isCodexAppsClient(client)) {
    if (!client.capabilities.resources) return []
    const descriptors = await discoverCodexAppSkillDescriptors(client)
    if (!descriptors) return null
    return descriptors.map(descriptor => buildLazySkillCommand(client, descriptor))
  }

  if (!isSkillExtensionSupported(client)) return []
  const descriptors = await discoverSkillDescriptorsFromExtension(client)
  if (!descriptors) return null
  const commands = await Promise.all(
    descriptors.map(descriptor => buildEagerSkillCommand(client, descriptor)),
  )
  return commands.filter(command => command !== null)
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
  for (const key of directSkillCache.keys()) {
    if (key.startsWith(`${name}\0`)) directSkillCache.delete(key)
  }
}

export const fetchMcpSkillsForClient = fetchImpl
