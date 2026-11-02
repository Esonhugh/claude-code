import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'

export const DESCRIPTION = 'List all tasks in the task list'

export function getPrompt(): string {
  const teammateWorkflow = isAgentSwarmsEnabled()
    ? `

As a teammate: after finishing a task, call TaskList, claim an available task (pending, no owner, empty blockedBy) by setting \`owner\` to your name with TaskUpdate, or wait for the leader to assign one. If everything is blocked, work on unblocking it or tell the team lead.`
    : ''

  return `List all tasks: id, subject, status (pending / in_progress / completed), owner (empty if available) and blockedBy (open task IDs that must finish first; a blocked task cannot be claimed).

Use it to find available work (pending, no owner, not blocked), check progress, or pick the next task after finishing one. Prefer the lowest ID first, since earlier tasks often set up later ones. Use TaskGet for a task's full description.${teammateWorkflow}`
}
