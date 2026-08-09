import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import { randomUUID } from 'crypto'
import { getSessionId } from '../bootstrap/state.js'
import type { Command } from '../commands.js'
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import { goalStopHook, removeGoalStopHook } from './goal/hooks.js'
import { getGoalModePrompt } from './goal/prompt.js'
import {
  createActiveGoalStatus,
  createGoalStatusAttachment,
  formatGoalStatusText,
  getGoalPromptForState,
} from './goal/state.js'
import {
  GOAL_MAX_LENGTH,
  isGoalClear,
  isGoalTooLong,
  type GoalStatusAttachment,
} from './goal/types.js'

export {
  createActiveGoalStatus,
  createGoalStatusAttachment,
  finishGoalStatus,
  formatGoalStatusText,
  getGoalPromptForState,
} from './goal/state.js'

let lastGoalCommandAttachment: GoalStatusAttachment | null = null
let lastGoalHookRegistration: { id: string; condition: string } | null = null

export function consumeLastGoalCommandAttachment(): GoalStatusAttachment | null {
  const attachment = lastGoalCommandAttachment
  lastGoalCommandAttachment = null
  return attachment
}

export function consumeLastGoalHookRegistration(): {
  id: string
  condition: string
} | null {
  const registration = lastGoalHookRegistration
  lastGoalHookRegistration = null
  return registration
}

const goal: Command = {
  type: 'prompt',
  name: 'goal',
  description: 'Work autonomously toward a goal',
  argumentHint: '[ <condition> | clear ]',
  progressMessage: 'Set a goal — keep working until the condition is met',
  contentLength: 0,
  source: 'builtin',
  allowedTools: [AGENT_TOOL_NAME],
  hooks: {
    Stop: [
      {
        matcher: '',
        hooks: [goalStopHook],
      },
    ],
  },
  shouldRegisterHooksForCommand(args): boolean {
    return args.trim().length > 0 && !isGoalClear(args) && !isGoalTooLong(args)
  },
  shouldQueryForCommand(args): boolean {
    return args.trim().length > 0 && !isGoalClear(args) && !isGoalTooLong(args)
  },
  async getPromptForCommand(args, context): Promise<ContentBlockParam[]> {
    lastGoalCommandAttachment = null
    lastGoalHookRegistration = null

    if (isGoalTooLong(args)) {
      return [
        {
          type: 'text',
          text: `Goal condition is limited to ${GOAL_MAX_LENGTH} characters (got ${args.trim().length})`,
        },
      ]
    }

    if (args.trim().length === 0) {
      return [
        { type: 'text', text: formatGoalStatusText(context.getAppState().goalStatus) },
      ]
    }

    if (isGoalClear(args)) {
      let clearedPrompt: string | null = null
      context.setAppState(prev => {
        if (!prev.goalStatus.active) return prev
        clearedPrompt = prev.goalStatus.prompt
        const activeGoal = prev.goalStatus
        lastGoalCommandAttachment = createGoalStatusAttachment(
          activeGoal,
          'cleared',
        )
        return { ...prev, goalStatus: { active: false } }
      })
      removeGoalStopHook(context.setAppState, getSessionId())
      return [
        {
          type: 'text',
          text: clearedPrompt ? `Goal cleared: ${clearedPrompt}` : 'No goal set',
        },
      ]
    }

    const prompt = getGoalPromptForState(args)
    const goalId = randomUUID()
    const activeGoal = createActiveGoalStatus(goalId, prompt, Date.now())
    context.setAppState(prev => ({
      ...prev,
      goalStatus: activeGoal,
    }))
    lastGoalCommandAttachment = createGoalStatusAttachment(activeGoal, 'active')
    lastGoalHookRegistration = { id: goalId, condition: prompt }
    return [{ type: 'text', text: getGoalModePrompt(prompt) }]
  },
}

export default goal
