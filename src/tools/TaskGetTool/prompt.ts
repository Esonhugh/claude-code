export const DESCRIPTION = 'Get a task by ID from the task list'

export const PROMPT = `Get one task by ID: subject, description, status (pending / in_progress / completed), blocks (tasks waiting on it) and blockedBy (tasks that must finish first).

Use it for the full requirements before starting or after being assigned a task. Start work only when blockedBy is empty. TaskList shows all tasks in summary form.`
