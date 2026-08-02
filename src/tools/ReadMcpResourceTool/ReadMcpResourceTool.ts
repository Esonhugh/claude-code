import {
  type ReadResourceResult,
  ReadResourceResultSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { Buffer } from 'node:buffer'
import { z } from 'zod/v4'
import { getHostOwnedCodexAppsKind } from '../../services/apps/trust.js'
import { ensureConnectedClient } from '../../services/mcp/client.js'
import { hashMcpSkillContent } from '../../skills/mcpSkillDiskCache.js'
import { readMcpSkillResourceRules } from '../../skills/mcpSkillResourceGrant.js'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  getBinaryBlobSavedMessage,
  persistBinaryContent,
} from '../../utils/mcpOutputStorage.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'
import { DESCRIPTION, PROMPT } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

export const inputSchema = lazySchema(() =>
  z.object({
    server: z.string().describe('The MCP server name'),
    uri: z.string().describe('The resource URI to read'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const outputSchema = lazySchema(() =>
  z.object({
    contents: z.array(
      z.object({
        uri: z.string().describe('Resource URI'),
        mimeType: z.string().optional().describe('MIME type of the content'),
        text: z.string().optional().describe('Text content of the resource'),
        blobSavedTo: z
          .string()
          .optional()
          .describe('Path where binary blob content was saved'),
      }),
    ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

type ManifestGrant = {
  server: string
  skillUri: string
  uri: string
  digest: string
}

function activeMcpSkillManifest(context: ToolUseContext): {
  scoped: boolean
  scopes: Array<{ server: string; skillUri: string }>
  grants: ManifestGrant[]
} {
  if (typeof context.getAppState !== 'function') {
    return { scoped: false, scopes: [], grants: [] }
  }
  return readMcpSkillResourceRules(
    context.getAppState().toolPermissionContext.alwaysAllowRules.command ?? [],
  )
}

function grantedResource(
  context: ToolUseContext,
  server: string,
  uri: string,
): ManifestGrant | undefined {
  const { scopes, grants } = activeMcpSkillManifest(context)
  return grants.find(
    grant =>
      grant.server === server &&
      grant.uri === uri &&
      scopes.some(
        scope =>
          scope.server === server && scope.skillUri === grant.skillUri,
      ),
  )
}

function verifyResourceContent(
  grant: ManifestGrant,
  content: { text?: string; blob?: string },
): Buffer | undefined {
  let bytes: Buffer | undefined
  if (typeof content.text === 'string') {
    bytes = Buffer.from(content.text, 'utf8')
  } else if (typeof content.blob === 'string') {
    const unpadded = content.blob.replace(/=+$/u, '')
    if (
      content.blob.length - unpadded.length > 2 ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(content.blob) ||
      unpadded.length % 4 === 1
    ) {
      throw new Error(`Invalid MCP skill resource blob encoding for ${grant.uri}`)
    }
    bytes = Buffer.from(content.blob, 'base64')
    if (bytes.toString('base64').replace(/=+$/u, '') !== unpadded) {
      throw new Error(`Invalid MCP skill resource blob encoding for ${grant.uri}`)
    }
  }

  if (!bytes || hashMcpSkillContent(bytes) !== grant.digest) {
    throw new Error(`MCP skill resource digest mismatch for ${grant.uri}`)
  }
  return typeof content.blob === 'string' ? bytes : undefined
}

export const ReadMcpResourceTool = buildTool({
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
  name: 'ReadMcpResourceTool',
  searchHint: 'read a specific MCP resource by URI',
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
    const { scoped } = activeMcpSkillManifest(context)
    if (!scoped) {
      return { behavior: 'allow', updatedInput: input }
    }
    if (grantedResource(context, input.server, input.uri)) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: {
          type: 'other',
          reason: 'Resource is listed in the active MCP skill manifest',
        },
      }
    }
    return {
      behavior: 'deny',
      message: 'Resource is not listed in the active MCP skill manifest.',
      decisionReason: {
        type: 'other',
        reason: 'Resource is outside the active MCP skill manifest',
      },
    }
  },
  async call(input, context) {
    const { mcpClients } = context.options
    const { server: serverName, uri } = input
    const manifest = activeMcpSkillManifest(context)
    const requestedGrant = manifest.scoped
      ? grantedResource(context, serverName, uri)
      : undefined
    if (manifest.scoped && !requestedGrant) {
      throw new Error('Resource is not listed in the active MCP skill manifest')
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

    const connectedClient = await ensureConnectedClient(client)
    const result = (await connectedClient.client.request(
      {
        method: 'resources/read',
        params: { uri },
      },
      ReadResourceResultSchema,
    )) as ReadResourceResult

    const verifiedBlobBytes = new Map<number, Buffer>()
    if (manifest.scoped) {
      if (!result.contents.some(content => content.uri === uri)) {
        throw new Error(`MCP server did not return requested resource ${uri}`)
      }
      for (const [index, content] of result.contents.entries()) {
        const grant = grantedResource(context, serverName, content.uri)
        if (!grant) {
          throw new Error(
            `MCP resource ${content.uri} is not listed in the active MCP skill manifest`,
          )
        }
        const bytes = verifyResourceContent(grant, content)
        if (bytes) verifiedBlobBytes.set(index, bytes)
      }
    }

    // Intercept any blob fields: decode, write raw bytes to disk with a
    // mime-derived extension, and replace with a path. Otherwise the base64
    // would be stringified straight into the context.
    const contents = await Promise.all(
      result.contents.map(async (c, i) => {
        if ('text' in c) {
          return { uri: c.uri, mimeType: c.mimeType, text: c.text }
        }
        if (!('blob' in c) || typeof c.blob !== 'string') {
          return { uri: c.uri, mimeType: c.mimeType }
        }
        const persistId = `mcp-resource-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`
        const persisted = await persistBinaryContent(
          verifiedBlobBytes.get(i) ?? Buffer.from(c.blob, 'base64'),
          c.mimeType,
          persistId,
        )
        if ('error' in persisted) {
          return {
            uri: c.uri,
            mimeType: c.mimeType,
            text: `Binary content could not be saved to disk: ${persisted.error}`,
          }
        }
        return {
          uri: c.uri,
          mimeType: c.mimeType,
          blobSavedTo: persisted.filepath,
          text: getBinaryBlobSavedMessage(
            persisted.filepath,
            c.mimeType,
            persisted.size,
            `[Resource from ${serverName} at ${c.uri}] `,
          ),
        }
      }),
    )

    return {
      data: { contents },
    }
  },
  renderToolUseMessage,
  userFacingName,
  renderToolResultMessage,
  isResultTruncated(output: Output): boolean {
    return isOutputLineTruncated(jsonStringify(output))
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(content),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
