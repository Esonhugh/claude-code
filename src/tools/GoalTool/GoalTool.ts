import { randomUUID } from 'node:crypto'
import { createElement } from 'react'
import { z } from 'zod/v4'

import { getSessionId, getTotalOutputTokens } from '../../bootstrap/state.js'
import {
  clearGoal,
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
import { Text } from '../../ink.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import { recordTranscript } from '../../utils/sessionStorage.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { truncate } from '../../utils/truncate.js'
import { GOAL_TOOL_NAME } from './constants.js'

const MAX_GOAL_DISPLAY_WIDTH = 160

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['set', 'clear'])
      .describe('"set" sets or replaces the goal; "clear" cancels it'),
    goal: z
      .string()
      .optional()
      .describe('The goal to work autonomously toward (required for "set")'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    action: z.enum(['set', 'clear']),
    goal: z.string().optional().describe('The active or cleared goal'),
    cleared: z
      .boolean()
      .optional()
      .describe('Whether an active goal was cleared'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

const AGENT_CONTEXT_ERROR = 'Goal cannot be used in agent contexts'

export const GoalTool = buildTool({
  name: GOAL_TOOL_NAME,
  searchHint: 'set or cancel an autonomous completion objective for this session',
  maxResultSizeChars: 100_000,
  strict: true,
  shouldDefer: true,
  async description() {
    return 'Sets, replaces or clears the main session goal'
  },
  async prompt() {
    return `Use this tool to set, replace or clear the main session goal.

"set" activates the same behavior as /goal: work autonomously, verify the result before reporting success, and continue if the Goal StopHook reports unfinished work. "clear" clears the same state as /goal clear and removes the Goal StopHook. This tool is available only in the main session and cannot be used by Agent subagents.`
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return GOAL_TOOL_NAME
  },
  renderToolUseMessage({ action, goal }, { verbose }) {
    if (action === 'clear') return 'Clear active goal'
    if (!goal) return null
    const prompt = getGoalPromptForState(goal)
    return verbose ? prompt : truncate(prompt, MAX_GOAL_DISPLAY_WIDTH, true)
  },
  renderToolResultMessage({ action, cleared, goal }) {
    if (action === 'set') return null
    return createElement(Text, null, cleared ? `Goal cleared: ${goal}` : 'No goal set')
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
  toAutoClassifierInput({ action, goal }) {
    return action === 'clear' ? 'clear' : (goal ?? '')
  },
  async validateInput({ action, goal }, context) {
    if (context.agentId) {
      return { result: false, message: AGENT_CONTEXT_ERROR, errorCode: 3 }
    }
    if (action === 'clear') return { result: true }
    if (!goal || goal.trim().length === 0) {
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
  async call({ action, goal }, context) {
    if (context.agentId) {
      throw new Error(AGENT_CONTEXT_ERROR)
    }

    if (action === 'clear') {
      const { clearedGoal, attachment } = clearGoal(
        context.setAppState,
        getSessionId(),
      )
      return {
        data: {
          action,
          cleared: clearedGoal !== undefined,
          ...(clearedGoal === undefined ? {} : { goal: clearedGoal }),
        },
        ...(attachment === undefined
          ? {}
          : { newMessages: [createAttachmentMessage(attachment)] }),
      }
    }

    const unavailableMessage = getGoalUnavailableMessage()
    if (unavailableMessage) {
      throw new Error(unavailableMessage)
    }
    const prompt = getGoalPromptForState(goal ?? '')
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
      data: { action, goal: prompt },
      newMessages: [createAttachmentMessage(attachment)],
    }
  },
  mapToolResultToToolResultBlockParam({ action, cleared, goal }, toolUseID) {
    const content =
      action === 'set'
        ? `Goal set: ${goal}\n\n${getGoalModePrompt(goal ?? '')}`
        : cleared
          ? `Goal cleared: ${goal}`
          : 'No goal set'
    return { type: 'tool_result', tool_use_id: toolUseID, content }
  },
} satisfies ToolDef<InputSchema, Output>)
