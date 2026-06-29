import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import { getSessionId } from '../bootstrap/state.js'
import type { Command } from '../commands.js'
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import { removeSessionHook } from '../utils/hooks/sessionHooks.js'

const goalStopHookPrompt = `
You are the /goal StopHook verifier. Inspect the current conversation and transcript to decide whether the active /goal objective is fully completed.

Hook input JSON:
$ARGUMENTS

Decision rules:
- Return ok: true only if the latest /goal objective has a verified final result and no unresolved required work remains.
- Return ok: true if there is no active /goal objective in the transcript.
- Return ok: true if the latest /goal command is clear, because that explicitly clears any active objective.
- Return ok: true if stop_hook_active is true and the last assistant message is still genuinely blocked by permissions, missing credentials, or a user-only decision.
- Return ok: false when the objective is partially complete, unverified, has failing checks, still has in-progress tasks, or can be continued autonomously with available tools.
- When returning ok: false, the reason must be a concrete continuation instruction for the main assistant. Include what remains, what to do next, and any checks to run. The main assistant will receive this reason as hidden Stop hook feedback and continue without human intervention.
`

const GOAL_NO_PROMPT_PLACEHOLDER = '(no goal provided)'

export const getGoalPromptForState = (args: string): string =>
  args.trim() || GOAL_NO_PROMPT_PLACEHOLDER

const goalPrompt = (args: string) => `
You are running in /goal mode. The user's goal is:

${getGoalPromptForState(args)}

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

const isGoalClear = (args: string): boolean => args.trim().toLowerCase() === 'clear'

const goalClearPrompt = 'Goal is clear'

const goalStopHook = {
  type: 'agent' as const,
  prompt: goalStopHookPrompt,
  statusMessage: 'verifying goal completion',
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
    return !isGoalClear(args)
  },
  shouldQueryForCommand(args): boolean {
    return !isGoalClear(args)
  },
  async getPromptForCommand(args, context): Promise<ContentBlockParam[]> {
    const clearGoal = isGoalClear(args)
    context.setAppState(prev => {
      if (clearGoal) {
        if (!prev.goalStatus.active) return prev
        return { ...prev, goalStatus: { active: false } }
      }
      const prompt = getGoalPromptForState(args)
      if (prev.goalStatus.active && prev.goalStatus.prompt === prompt) return prev
      return { ...prev, goalStatus: { active: true, prompt } }
    })
    // /goal clear must also unregister the Stop hook that /goal <task> installed.
    // Otherwise the verifier keeps running on every turn even after the user
    // explicitly cleared the goal.
    if (clearGoal) {
      removeSessionHook(context.setAppState, getSessionId(), 'Stop', goalStopHook)
    }
    return [{ type: 'text', text: clearGoal ? goalClearPrompt : goalPrompt(args) }]
  },
}

export default goal
