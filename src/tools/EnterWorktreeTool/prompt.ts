export function getEnterWorktreeToolPrompt(): string {
  return `Create an isolated git worktree and switch the session into it. Use ONLY when the user explicitly mentions a worktree; for branches, bug fixes or features use the normal git workflow.

- \`name\` (optional): create a new worktree under \`.claude/worktrees/\` on a new branch (random name if omitted). The base is set by \`worktree.baseRef\`: \`fresh\` (default) branches from origin/<default-branch>, \`head\` from local HEAD. Not allowed while already in a worktree session.
- \`path\` (optional, exclusive with \`name\`): switch into an existing worktree listed by \`git worktree list\`; from inside a worktree session it must be under \`.claude/worktrees/\` of the same repository. ExitWorktree will not remove a worktree entered this way.
- Outside a git repository it uses WorktreeCreate/WorktreeRemove hooks instead; without them the tool fails.

Leave with ExitWorktree (keep or remove). If the session ends inside the worktree, the user is asked whether to keep it.
`
}
