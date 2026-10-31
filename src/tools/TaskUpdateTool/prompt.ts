export const DESCRIPTION = 'Update a task in the task list'

export const PROMPT = `Update one task in the task list. Read its latest state with TaskGet first.

- \`status\`: \`pending\` → \`in_progress\` (set it BEFORE starting the work) → \`completed\`; \`deleted\` removes the task permanently (created in error or no longer relevant).
- Mark \`completed\` only when the work is FULLY done. Keep \`in_progress\` if tests fail, the implementation is partial, or errors are unresolved; when blocked, create a new task for the blocker.
- Always resolve the tasks assigned to you, then call TaskList for the next one.
- Other fields: \`subject\` (imperative, e.g. "Run tests"), \`description\`, \`activeForm\` (spinner text, e.g. "Running tests"), \`owner\` (agent name, claims the task), \`metadata\` (merged; null deletes a key), \`addBlocks\` / \`addBlockedBy\` (task IDs).

Example: {"taskId": "2", "status": "in_progress"}; dependency: {"taskId": "2", "addBlockedBy": ["1"]}`
