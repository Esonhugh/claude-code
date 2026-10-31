import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { isPlanModeAvailable } from '../../utils/planModeV2.js'

export const DESCRIPTION = 'Create a new task in the task list'

export function getPrompt(): string {
  const teammateContext = isAgentSwarmsEnabled()
    ? ' and potentially assigned to teammates'
    : ''

  const teammateTips = isAgentSwarmsEnabled()
    ? `
- New tasks have no owner; assign one with TaskUpdate \`owner\`, and write the description so another agent can do the task.`
    : ''

  return `Create a task in the session's task list to track progress on multi-step work${teammateContext}. The user sees the list.

- Use it for work with 3 or more distinct steps or actions, when the user gives several tasks (numbered or comma-separated) or asks for a todo list${isPlanModeAvailable() ? ', or to track the work in plan mode' : ''}.
- Skip it for a single, straightforward task, anything doable in under 3 trivial steps, or a purely conversational or informational request.
- \`subject\`: short imperative title ("Fix auth bug in login flow"); \`description\`: what needs to be done; \`activeForm\` (optional): spinner text while in_progress ("Fixing auth bug").
- Tasks start as \`pending\`. Mark one \`in_progress\` with TaskUpdate before starting it and \`completed\` when done, adding follow-up tasks you discover. Set dependencies with TaskUpdate (addBlocks/addBlockedBy).
- Check TaskList first to avoid duplicates.${teammateTips}`
}
