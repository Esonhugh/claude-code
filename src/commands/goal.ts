import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import { randomUUID } from 'crypto'
import { getSessionId } from '../bootstrap/state.js'
import type { Command } from '../commands.js'
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import { goalStopHook, removeGoalStopHook } from './goal/hooks.js'
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

const goalPrompt = (condition: string) => `
You are running in /goal mode. The user's goal is:

${condition}

Work autonomously toward this goal under the current Claude Code permission mode and available tools.

Rules:
- Do not ask clarifying questions unless the goal is impossible to interpret or you are blocked by a decision only the user can make.
- Break down non-trivial work with the task/todo tools when useful, and keep those tasks up to date.
- Continue taking useful actions until the goal is achieved, proven impossible, or blocked by permissions/user input.
- Verify the result before reporting success. Do not claim completion with failing checks or unresolved implementation work.
- If the goal is not achieved and another agent could continue productively, start an Agent with a self-contained continuation prompt that includes the original goal, current state, completed work, blockers, and exact next steps.
- If a continuation agent returns useful results, incorporate them and continue until the goal is complete or clearly blocked.
- A /goal StopHook will verify completion when you try to stop. If it reports unfinished work, treat that feedback as authoritative continuation instructions and keep working without asking the user.

When finished, report the verified result and any remaining blockers concisely.
`

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
    return [{ type: 'text', text: goalPrompt(prompt) }]
  },
}

export default goal
