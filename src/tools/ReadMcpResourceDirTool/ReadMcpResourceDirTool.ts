import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod/v4'
import { getHostOwnedCodexAppsKind } from '../../services/apps/trust.js'
import { ensureConnectedClient } from '../../services/mcp/client.js'
import { readMcpSkillResourceRules } from '../../skills/mcpSkillResourceGrant.js'
import {
  DIRECTORY_READ_MIME_TYPE,
  readMcpDirectory,
  serverDeclaresDirectoryRead,
} from '../../services/mcp/directoryRead.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logMCPError } from '../../utils/log.js'
import { recursivelySanitizeUnicode } from '../../utils/sanitization.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { plural } from '../../utils/stringUtils.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'
import { DESCRIPTION, PROMPT, READ_MCP_RESOURCE_DIR_TOOL_NAME } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

export const inputSchema = lazySchema(() =>
  z.object({
    server: z.string().describe('The MCP server name'),
    uri: z.string().describe('The directory resource URI to list'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const outputSchema = lazySchema(() =>
  z.object({
    resources: z
      .array(
        z.object({
          uri: z.string().describe('Child resource URI'),
          name: z.string().describe('Child resource name'),
          mimeType: z.string().optional().describe('Child MIME type'),
        }),
      )
      .describe(
        `Direct children of the directory resource. Subdirectories appear with mimeType "${DIRECTORY_READ_MIME_TYPE}".`,
      ),
    error: z
      .string()
      .optional()
      .describe('Human-readable error when the server could not list the directory'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

type McpSkillManifest = ReturnType<typeof readMcpSkillResourceRules>

function activeMcpSkillManifest(context: {
  getAppState?: () => {
    toolPermissionContext: {
      alwaysAllowRules: { command?: readonly string[] }
    }
  }
}): McpSkillManifest {
  if (typeof context.getAppState !== 'function') {
    return { scoped: false, scopes: [], grants: [] }
  }
  return readMcpSkillResourceRules(
    context.getAppState().toolPermissionContext.alwaysAllowRules.command ?? [],
  )
}

function canonicalScopedUri(value: string): URL | null {
  try {
    const url = new URL(value)
    if (
      url.href !== value ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null
    }
    return url
  } catch {
    return null
  }
}

function uriIsInDirectory(uri: string, directoryUri: string): boolean {
  const resource = canonicalScopedUri(uri)
  const directory = canonicalScopedUri(directoryUri)
  if (!resource || !directory) return false
  const directoryPath = directory.pathname.endsWith('/')
    ? directory.pathname
    : `${directory.pathname}/`
  return (
    resource.protocol === directory.protocol &&
    resource.host === directory.host &&
    resource.pathname.startsWith(directoryPath)
  )
}

function directoryIsWithinSkillRoot(
  directoryUri: string,
  skillUri: string,
): boolean {
  const directory = canonicalScopedUri(directoryUri)
  const skill = canonicalScopedUri(skillUri)
  if (!directory || !skill || !skill.pathname.endsWith('/SKILL.md')) return false
  const skillRoot = skill.pathname.slice(0, -'/SKILL.md'.length)
  return (
    directory.protocol === skill.protocol &&
    directory.host === skill.host &&
    (directory.pathname === skillRoot ||
      directory.pathname.startsWith(`${skillRoot}/`))
  )
}

function manifestAllowsDirectory(
  server: string,
  directoryUri: string,
  manifest: McpSkillManifest,
): boolean {
  return manifest.scopes.some(
    scope =>
      scope.server === server &&
      directoryIsWithinSkillRoot(directoryUri, scope.skillUri) &&
      manifest.grants.some(
        grant =>
          grant.server === server &&
          grant.skillUri === scope.skillUri &&
          uriIsInDirectory(grant.uri, directoryUri),
      ),
  )
}

function manifestDirectoryResources(
  server: string,
  directoryUri: string,
  manifest: McpSkillManifest,
): Map<string, Output['resources'][number]> {
  const directory = canonicalScopedUri(directoryUri)
  if (!directory) return new Map()
  const directoryPath = directory.pathname.endsWith('/')
    ? directory.pathname
    : `${directory.pathname}/`
  const resources = new Map<string, Output['resources'][number]>()

  for (const grant of manifest.grants) {
    if (
      grant.server !== server ||
      !manifest.scopes.some(
        scope =>
          scope.server === server &&
          scope.skillUri === grant.skillUri &&
          directoryIsWithinSkillRoot(directoryUri, scope.skillUri),
      )
    ) {
      continue
    }
    const resource = canonicalScopedUri(grant.uri)
    if (
      !resource ||
      resource.protocol !== directory.protocol ||
      resource.host !== directory.host ||
      !resource.pathname.startsWith(directoryPath)
    ) {
      continue
    }

    const relativePath = resource.pathname.slice(directoryPath.length)
    if (!relativePath) continue
    const slash = relativePath.indexOf('/')
    const name = slash === -1 ? relativePath : relativePath.slice(0, slash)
    const child = new URL(directory.href)
    child.pathname = `${directoryPath}${name}`
    resources.set(child.href, {
      uri: child.href,
      name,
      ...(slash === -1 ? {} : { mimeType: DIRECTORY_READ_MIME_TYPE }),
    })
  }

  return resources
}

export const ReadMcpResourceDirTool = buildTool({
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return `${input.server} ${input.uri}`
  },
  shouldDefer: true,
  name: READ_MCP_RESOURCE_DIR_TOOL_NAME,
  aliases: ['ReadMcpResourceDir'],
  searchHint: 'list the children of an MCP directory resource',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async checkPermissions(input, context) {
    const manifest = activeMcpSkillManifest(context)
    if (!manifest.scoped) return { behavior: 'allow', updatedInput: input }
    if (manifestAllowsDirectory(input.server, input.uri, manifest)) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: {
          type: 'other',
          reason: 'Directory contains resources in the active MCP skill manifest',
        },
      }
    }
    return {
      behavior: 'deny',
      message:
        'Directory is outside the originating server and active MCP skill manifest.',
      decisionReason: {
        type: 'other',
        reason: 'Directory is outside the active MCP skill manifest',
      },
    }
  },
  async call(input, context) {
    const { mcpClients } = context.options
    const { server: serverName, uri } = input
    const manifest = activeMcpSkillManifest(context)
    if (
      manifest.scoped &&
      !manifestAllowsDirectory(serverName, uri, manifest)
    ) {
      throw new Error(
        'Directory is outside the originating server and active MCP skill manifest.',
      )
    }

    const client = mcpClients.find(client => client.name === serverName)

    if (!client) {
      throw new Error(
        `Server "${serverName}" not found. Available servers: ${mcpClients.map(c => c.name).join(', ')}`,
      )
    }

    if (client.type !== 'connected') {
      throw new Error(`Server "${serverName}" is not connected`)
    }

    if (!client.capabilities?.resources) {
      throw new Error(`Server "${serverName}" does not support resources`)
    }

    if (getHostOwnedCodexAppsKind(client.config) === 'plugins') {
      throw new Error(
        `Server "${serverName}" does not expose generic MCP resources`,
      )
    }

    if (!serverDeclaresDirectoryRead(client.capabilities)) {
      return {
        data: {
          resources: [],
          error: `Server "${client.name}" does not support directory listing.`,
        },
      }
    }

    const connectedClient = await ensureConnectedClient(client)

    try {
      const resources = await readMcpDirectory(connectedClient, uri)
      const scopedResources = manifest.scoped
        ? manifestDirectoryResources(serverName, uri, manifest)
        : null
      let visibleResources: Output['resources']
      if (scopedResources) {
        const returnedUris = new Set<string>()
        visibleResources = resources.map(resource => {
          const manifestResource = scopedResources.get(resource.uri)
          if (!manifestResource) {
            throw new Error(
              `MCP skill directory returned resource not listed in the active MCP skill manifest: ${resource.uri}`,
            )
          }
          returnedUris.add(resource.uri)
          return manifestResource
        })
        const missingUri = [...scopedResources.keys()].find(
          resourceUri => !returnedUris.has(resourceUri),
        )
        if (missingUri) {
          throw new Error(
            `MCP skill directory did not return resource listed in the active MCP skill manifest: ${missingUri}`,
          )
        }
      } else {
        visibleResources = resources.map(resource => ({
          uri: resource.uri,
          name: resource.name,
          mimeType: resource.mimeType,
        }))
      }
      return {
        data: {
          resources: recursivelySanitizeUnicode(visibleResources),
        },
      }
    } catch (error) {
      if (error instanceof McpError && error.code === ErrorCode.InvalidParams) {
        logMCPError(
          connectedClient.name,
          `resources/directory/read returned ${error.code} — not a directory`,
        )
        return {
          data: {
            resources: [],
            error: `Not a directory resource: ${uri}. If it is a file resource, use ReadMcpResourceTool instead.`,
          },
        }
      }
      throw error
    }
  },
  renderToolUseMessage,
  userFacingName,
  renderToolResultMessage,
  isResultTruncated(output: Output): boolean {
    if (output.error) {
      return isOutputLineTruncated(output.error)
    }
    return isOutputLineTruncated(jsonStringify(output, null, 2))
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    if (content.error) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: content.error,
      }
    }

    const summary =
      content.resources.length > 0
        ? `Directory listing (${content.resources.length} ${plural(content.resources.length, 'entry', 'entries')}):\n${content.resources
            .map(
              resource =>
                `${resource.name}${resource.mimeType === DIRECTORY_READ_MIME_TYPE ? '/' : ''}`,
            )
            .join('\n')}`
        : 'Directory is empty.'

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `${summary}\n\n${jsonStringify(content)}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
