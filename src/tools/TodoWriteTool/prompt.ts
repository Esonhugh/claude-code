export const PROMPT = `Write the session's whole todo list (it replaces the previous one) to track multi-step work. The user sees the list.

- Use it for work with 3 or more distinct steps or actions, when the user gives several tasks (numbered or comma-separated) or asks for a todo list.
- Skip it for a single, straightforward task, anything doable in under 3 trivial steps, or a purely conversational or informational request.
- Each item has \`content\` (imperative: "Run tests"), \`activeForm\` (present continuous, shown while running: "Running tests") and \`status\`: pending, in_progress or completed.
- Keep exactly ONE item in_progress: set it BEFORE starting the work, and mark it completed IMMEDIATELY when done (don't batch). Remove items that no longer apply; add follow-ups you discover.
- Mark completed only when the work is FULLY done. Keep it in_progress if tests fail, the implementation is partial, or errors are unresolved; when blocked, add an item for the blocker.

Example: "add a dark mode toggle, then run the tests and build" → [{"content": "Add dark mode toggle to settings", "activeForm": "Adding dark mode toggle", "status": "in_progress"}, {"content": "Run tests and build", "activeForm": "Running tests and build", "status": "pending"}]`

export const DESCRIPTION =
  'Update the todo list for the current session. Keep exactly one task in_progress while working, and give each task both content (imperative) and activeForm (present continuous).'
