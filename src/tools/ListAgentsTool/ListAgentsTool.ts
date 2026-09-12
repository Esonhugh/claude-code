import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  listAllLiveSessions,
  type LiveSessionInfo,
} from '../../utils/udsClient.js'
import { getUdsMessagingSocketPath } from '../../utils/udsMessaging.js'
import { renderToolResultMessage } from './UI.js'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>
type Output = { agents: LiveSessionInfo[] }

export const ListAgentsTool = buildTool({
  name: 'ListAgents',
  searchHint: 'discover local Claude sessions for SendMessage',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  isEnabled() {
    return feature('UDS_INBOX') ? getUdsMessagingSocketPath() !== null : false
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  async description() {
    return 'List other live local Claude sessions'
  },
  async prompt() {
    return 'Discover other live Claude sessions on this machine. Use SendMessage with a listed name, "name [ref]", or sessionId to send plain text. Discovery does not guarantee that a message will be accepted or processed.'
  },
  async call() {
    return { data: { agents: await listAllLiveSessions() } }
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage,
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content:
        data.agents.length > 0
          ? jsonStringify(data)
          : 'No other live local Claude sessions found.',
    }
  },
} satisfies ToolDef<InputSchema, Output>)
