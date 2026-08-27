import { z } from 'zod/v4'

import { getSessionId } from '../../bootstrap/state.js'
import { clearGoal } from '../../commands/goal/hooks.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { CLEAR_GOAL_TOOL_NAME } from './constants.js'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    cleared: z.boolean().describe('Whether an active goal was cleared'),
    goal: z.string().optional().describe('The cleared goal'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

const AGENT_CONTEXT_ERROR = 'ClearGoal cannot be used in agent contexts'

export const ClearGoalTool = buildTool({
  name: CLEAR_GOAL_TOOL_NAME,
  searchHint: 'cancel the active autonomous completion objective',
  maxResultSizeChars: 100_000,
  strict: true,
  alwaysLoad: true,
  async description() {
    return 'Clears the active main session goal and stops autonomous goal completion'
  },
  async prompt() {
    return `Use this tool to cancel the active main session goal.

This clears the same state as /goal clear and removes the Goal StopHook. It is available only in the main session and cannot be used by Agent subagents.`
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return CLEAR_GOAL_TOOL_NAME
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage() {
    return null
  },
  isEnabled() {
    return true
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  async validateInput(_input, context) {
    if (context.agentId) {
      return { result: false, message: AGENT_CONTEXT_ERROR, errorCode: 1 }
    }
    return { result: true }
  },
  async checkPermissions(input) {
    return { behavior: 'allow', updatedInput: input }
  },
  async call(_input, context) {
    if (context.agentId) {
      throw new Error(AGENT_CONTEXT_ERROR)
    }

    const { clearedGoal, attachment } = clearGoal(
      context.setAppState,
      getSessionId(),
    )

    return {
      data: {
        cleared: clearedGoal !== undefined,
        ...(clearedGoal === undefined ? {} : { goal: clearedGoal }),
      },
      ...(attachment === undefined
        ? {}
        : { newMessages: [createAttachmentMessage(attachment)] }),
    }
  },
  mapToolResultToToolResultBlockParam({ cleared, goal }, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: cleared ? `Goal cleared: ${goal}` : 'No goal set',
    }
  },
} satisfies ToolDef<InputSchema, Output>)
