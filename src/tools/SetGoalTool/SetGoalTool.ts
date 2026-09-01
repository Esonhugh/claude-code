import { randomUUID } from 'node:crypto'
import { z } from 'zod/v4'

import { getSessionId, getTotalOutputTokens } from '../../bootstrap/state.js'
import {
  getGoalUnavailableMessage,
  registerGoalStopHook,
} from '../../commands/goal/hooks.js'
import { getGoalModePrompt } from '../../commands/goal/prompt.js'
import {
  createActiveGoalStatus,
  createGoalStatusAttachment,
  getGoalPromptForState,
} from '../../commands/goal/state.js'
import { GOAL_MAX_LENGTH, isGoalTooLong } from '../../commands/goal/types.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import { recordTranscript } from '../../utils/sessionStorage.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { truncate } from '../../utils/truncate.js'
import { SET_GOAL_TOOL_NAME } from './constants.js'

const MAX_GOAL_DISPLAY_WIDTH = 160

const inputSchema = lazySchema(() =>
  z.strictObject({
    goal: z.string().describe('The goal to work autonomously toward'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    goal: z.string().describe('The active goal'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

const AGENT_CONTEXT_ERROR = 'SetGoal cannot be used in agent contexts'

export const SetGoalTool = buildTool({
  name: SET_GOAL_TOOL_NAME,
  searchHint: 'set an autonomous completion objective for this session',
  maxResultSizeChars: 100_000,
  strict: true,
  alwaysLoad: true,
  async description() {
    return 'Sets or replaces the main session goal and keeps working until it is verified complete'
  },
  async prompt() {
    return `Use this tool to set or replace the main session goal.

The goal activates the same behavior as /goal: work autonomously, verify the result before reporting success, and continue if the Goal StopHook reports unfinished work. This tool is available only in the main session and cannot be used by Agent subagents.`
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return SET_GOAL_TOOL_NAME
  },
  renderToolUseMessage({ goal }, { verbose }) {
    if (!goal) return null
    const prompt = getGoalPromptForState(goal)
    return verbose ? prompt : truncate(prompt, MAX_GOAL_DISPLAY_WIDTH, true)
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
  toAutoClassifierInput({ goal }) {
    return goal
  },
  async validateInput({ goal }, context) {
    if (context.agentId) {
      return { result: false, message: AGENT_CONTEXT_ERROR, errorCode: 3 }
    }
    if (goal.trim().length === 0) {
      return { result: false, message: 'Goal must not be empty', errorCode: 1 }
    }
    if (isGoalTooLong(goal)) {
      return {
        result: false,
        message: `Goal condition is limited to ${GOAL_MAX_LENGTH} characters (got ${goal.trim().length})`,
        errorCode: 2,
      }
    }
    const unavailableMessage = getGoalUnavailableMessage()
    if (unavailableMessage) {
      return { result: false, message: unavailableMessage, errorCode: 4 }
    }
    return { result: true }
  },
  async checkPermissions(input) {
    return { behavior: 'allow', updatedInput: input }
  },
  async call({ goal }, context) {
    if (context.agentId) {
      throw new Error(AGENT_CONTEXT_ERROR)
    }
    const unavailableMessage = getGoalUnavailableMessage()
    if (unavailableMessage) {
      throw new Error(unavailableMessage)
    }

    const prompt = getGoalPromptForState(goal)
    const activeGoal = createActiveGoalStatus(
      randomUUID(),
      prompt,
      Date.now(),
      getTotalOutputTokens(),
    )
    const attachment = createGoalStatusAttachment(activeGoal, 'active')

    context.setAppState((prev) => ({
      ...prev,
      goalStatus: activeGoal,
    }))
    registerGoalStopHook({
      setAppState: context.setAppState,
      sessionId: getSessionId(),
      goalId: activeGoal.id,
      condition: prompt,
      appendGoalStatusAttachment: (completedAttachment) => {
        void recordTranscript([createAttachmentMessage(completedAttachment)])
      },
    })

    return {
      data: { goal: prompt },
      newMessages: [createAttachmentMessage(attachment)],
    }
  },
  mapToolResultToToolResultBlockParam({ goal }, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: `Goal set: ${goal}\n\n${getGoalModePrompt(goal)}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
