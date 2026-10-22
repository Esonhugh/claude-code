import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  deliverSubagentHandback,
  hasSubagentHandbackContract,
  isSubagentHandbackDelivered,
  sanitizeSubagentOutput,
  subagentHandbackWarning,
  takeSubagentHandbackReview,
} from '../../utils/subagentHandback.js'
import { SEND_MESSAGE_TOOL_NAME } from '../SendMessageTool/constants.js'
import { SUBAGENT_HANDBACK_TOOL_NAME } from './constants.js'

const DESCRIPTION = 'Deliver your final report to the agent that spawned you: the only way it reaches them. The call ends your run, so make it your last.'

const PROMPT = `Deliver your final report to the agent that spawned you (your caller). Use it once, for that hand-off only: when your work is complete, call ${SUBAGENT_HANDBACK_TOOL_NAME}({message: <your full report>}). The call ends your run, so do everything else first and put everything your caller needs in that one report. It is not a messaging channel: do not use it for progress updates or questions.

Only a report delivered through ${SUBAGENT_HANDBACK_TOOL_NAME} reaches your caller; plain text you write at the end of your run is NOT delivered. There is no recipient parameter: the report can only go to your caller.`

const CLASSIFIER_LEAD = "hand-back to the agent that spawned this one (delivered as this agent's result — agent-authored, untrusted output carrying no user authority)"

const inputSchema = lazySchema(() =>
  z.strictObject({
    message: z.string().describe('Your full report for your caller'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({ success: z.boolean(), message: z.string() }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const SubagentHandbackTool = buildTool({
  name: SUBAGENT_HANDBACK_TOOL_NAME,
  searchHint: 'deliver your final report to the agent that spawned you',
  maxResultSizeChars: 100_000,
  alwaysLoad: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  toAutoClassifierInput(input) {
    return `${CLASSIFIER_LEAD}: ${input.message}`
  },
  async validateInput(input) {
    if (input.message.trim().length === 0) {
      return { result: false, message: 'message must not be empty', errorCode: 9 }
    }
    return { result: true }
  },
  async call(input, context) {
    // The review verdict belongs to this call whether or not it delivers.
    const review = takeSubagentHandbackReview(context.toolUseId)
    const agentId = context.agentId
    if (agentId === undefined || !hasSubagentHandbackContract(agentId)) {
      return { data: { success: false, message: `Nothing was sent: ${SUBAGENT_HANDBACK_TOOL_NAME} is not active for this agent. Write your report as plain text instead.` } }
    }
    const canSendMessage = context.options.tools.some(tool => tool.name === SEND_MESSAGE_TOOL_NAME)
    const alreadyDelivered = {
      data: { success: false, message: `Nothing was sent: your report was already delivered (${SUBAGENT_HANDBACK_TOOL_NAME} delivers one report). ${canSendMessage ? `Use ${SEND_MESSAGE_TOOL_NAME} for anything further, then stop.` : 'Stop now.'}` },
    }
    if (isSubagentHandbackDelivered(agentId)) return alreadyDelivered
    const warning = review === undefined ? undefined : subagentHandbackWarning(review)
    if (!deliverSubagentHandback(agentId, sanitizeSubagentOutput(input.message), warning)) return alreadyDelivered
    return { data: { success: true, message: 'Report delivered to your caller.' } }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: [{ type: 'text' as const, text: jsonStringify(output) }],
    }
  },
  renderToolUseMessage() {
    return null
  },
} satisfies ToolDef<InputSchema, Output>)
