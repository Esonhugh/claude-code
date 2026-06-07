# Project Instructions

## Dynamic workflow compatibility work

- Use `tmux send-keys` to interact with both the official Claude Code binary and the current project build when debugging workflow compatibility. Explicitly compare and record both UI behavior differences and workflow execution logic differences before and after fixes.
- For local workflow debugging, compile with `CLAUDE_CODE_VERSION=2.1.165-dev pnpm build` and launch with `pnpm start`; use tmux for interaction rather than direct internal function calls.
- Use analysis techniques, including reverse engineering and deobfuscation, to inspect JavaScript saved by the official binary and understand related workflow and agent orchestration logic. Do not blindly copy proprietary official script bodies; reconstruct behavior clean-room unless explicitly authorized.
- Preserve the existing project code style. For interactive UI, write React Ink-style components and prefer existing UI/layout libraries or structured `Box`/`Text` layouts over fixed-width string construction.
- Periodically inspect code you have written, remove invalid or dead snippets, and verify authorship before cleanup when uncertain. Use `git blame` when needed to distinguish your changes from code written by Esonhugh.
