import {
  ErrorCode,
  McpError,
  type ServerCapabilities,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import { logMCPDebug } from '../../utils/log.js'
import type { ConnectedMCPServer } from './types.js'

export const MCP_SKILLS_EXTENSION = 'io.modelcontextprotocol/skills'
export const DIRECTORY_READ_MIME_TYPE = 'inode/directory'

const MAX_DIRECTORY_READ_PAGES = 20
const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 30_000

function mcpRequestTimeoutMs(): number {
  const timeout = Number.parseInt(process.env.MCP_TIMEOUT ?? '', 10)
  return timeout > 0 ? timeout : DEFAULT_MCP_REQUEST_TIMEOUT_MS
}

const DirectoryReadResultSchema = lazySchema(() =>
  z.object({
    resources: z.array(
      z.object({
        uri: z.string(),
        name: z.string(),
        mimeType: z.string().optional(),
      }),
    ),
    nextCursor: z.string().optional(),
  }),
)

type DirectoryReadResult = z.infer<ReturnType<typeof DirectoryReadResultSchema>>
export type DirectoryReadResource = DirectoryReadResult['resources'][number]

export function serverDeclaresDirectoryRead(
  capabilities: ServerCapabilities | undefined,
): boolean {
  const extension = capabilities?.extensions?.[MCP_SKILLS_EXTENSION]
  return (
    extension !== null &&
    typeof extension === 'object' &&
    'directoryRead' in extension &&
    extension.directoryRead === true
  )
}

export async function readMcpDirectory(
  client: ConnectedMCPServer,
  uri: string,
): Promise<DirectoryReadResource[]> {
  if (!serverDeclaresDirectoryRead(client.capabilities)) {
    throw new Error(
      'readMcpDirectory called on a server without directoryRead capability',
    )
  }

  const resources: DirectoryReadResource[] = []
  let cursor: string | undefined
  let page = 0

  do {
    let result: DirectoryReadResult
    try {
      result = (await client.client.request(
        {
          method: 'resources/directory/read',
          params: cursor ? { uri, cursor } : { uri },
        },
        DirectoryReadResultSchema(),
        { timeout: mcpRequestTimeoutMs() },
      )) as DirectoryReadResult
    } catch (error) {
      if (
        page === 0 ||
        !(error instanceof McpError) ||
        error.code !== ErrorCode.InvalidParams
      ) {
        throw error
      }

      logMCPDebug(
        client.name,
        `resources/directory/read ${uri}: page ${page + 1} returned InvalidParams on cursor; returning ${resources.length} entries from prior pages`,
      )
      return resources
    }

    resources.push(...result.resources)
    cursor = result.nextCursor
    page++
  } while (cursor && page < MAX_DIRECTORY_READ_PAGES)

  if (cursor) {
    logMCPDebug(
      client.name,
      `resources/directory/read ${uri}: stopped at ${MAX_DIRECTORY_READ_PAGES} pages with more pending`,
    )
  }

  return resources
}
