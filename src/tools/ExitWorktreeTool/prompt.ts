export function getExitWorktreeToolPrompt(): string {
  return `Leave the worktree session created by EnterWorktree in this session and return to the original working directory. Call it only when the user asks to exit or leave the worktree, never proactively.

It never touches worktrees made with \`git worktree add\`, worktrees from earlier sessions, or anything when no EnterWorktree session is active (then it reports that and does nothing).

- \`action\` (required): \`"keep"\` leaves the worktree directory and branch on disk (use when the user may come back or there are changes to keep); \`"remove"\` deletes both (use when the work is done or abandoned).
- \`discard_changes\` (default false, only with \`"remove"\`): with uncommitted files or commits not on the original branch, removal is refused unless this is true. If the tool lists such changes, confirm with the user before retrying with \`discard_changes: true\`.

Exiting restores the working directory, clears directory-dependent caches (system prompt sections, memory files, plans directory), and kills an attached tmux session on \`remove\` (on \`keep\` it stays running and its name is returned). EnterWorktree can be called again afterwards.
`
}
