import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type { Command } from '../commands.js'
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'

const goalStopHookPrompt = `
You are the /goal StopHook verifier. Inspect the current conversation and transcript to decide whether the active /goal objective is fully completed.

Hook input JSON:
$ARGUMENTS

Decision rules:
- Return ok: true only if the latest /goal objective has a verified final result and no unresolved required work remains.
- Return ok: true if there is no active /goal objective in the transcript.
- Return ok: true if stop_hook_active is true and the last assistant message is still genuinely blocked by permissions, missing credentials, or a user-only decision.
- Return ok: false when the objective is partially complete, unverified, has failing checks, still has in-progress tasks, or can be continued autonomously with available tools.
- When returning ok: false, the reason must be a concrete continuation instruction for the main assistant. Include what remains, what to do next, and any checks to run. The main assistant will receive this reason as hidden Stop hook feedback and continue without human intervention.
`

const goalPrompt = (args: string) => `
You are running in /goal mode. The user's goal is:

${args.trim() || '(no goal provided)'}

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
  argumentHint: '<goal>',
  progressMessage: 'working toward goal',
  contentLength: 0,
  source: 'builtin',
  allowedTools: [AGENT_TOOL_NAME],
  hooks: {
    Stop: [
      {
        matcher: '',
        hooks: [
          {
            type: 'agent',
            prompt: goalStopHookPrompt,
            statusMessage: 'verifying goal completion',
          },
        ],
      },
    ],
  },
  async getPromptForCommand(args): Promise<ContentBlockParam[]> {
    return [{ type: 'text', text: goalPrompt(args) }]
  },
}

export default goal
