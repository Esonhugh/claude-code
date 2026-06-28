import { registerBundledSkill } from '../bundledSkills.js'

const INTERACTIVE_TERMINAL_PROMPT = `# InteractiveTerminal Skill

Use this model-internal skill to decide when and how to use the InteractiveTerminal tool.

## Core rule

Use InteractiveTerminal for persistent terminal sessions. Use Bash for one-shot commands.

## Use InteractiveTerminal for

- REPL sessions
- TUI or curses-style programs
- CLI programs that need multiple inputs over time
- Processes where you must send special keys
- Programs that depend on terminal size
- Long-lived sessions where you need status, signals, or cleanup

## Do not use InteractiveTerminal for

Do not use InteractiveTerminal for file reads, edits, or searches. Use Read, Edit, Write, Grep, or Glob instead. For one-shot shell commands that simply run and exit, use Bash.

## Lifecycle

1. open: create a session and capture the returned sessionId.
2. read: inspect the visible terminal screen before deciding what to type.
3. write: send normal text input.
4. send_key: send Enter, Tab, Escape, arrows, Ctrl+C, Ctrl+D, and other supported special keys.
5. resize: change rows and columns when layout matters.
6. status: check whether the process is still running.
7. signal: send SIGINT or SIGTERM when the running process needs a signal.
8. list: enumerate unreaped sessions when you need to recover a sessionId.
9. close: close sessions when finished.

## Operating guidance

- Prefer read/status checks over arbitrary sleep loops.
- Use send_key for special keys instead of embedding control characters in write text.
- Keep track of sessionId explicitly.
- Close sessions when finished.
- If a nested Claude session stalls, report the stall and avoid blind retries.
`

export function registerInteractiveTerminalSkill(): void {
  registerBundledSkill({
    name: 'interactive-terminal',
    description:
      'Use when a persistent terminal, REPL, TUI, curses-style program, multi-step CLI session, special key input, resize, signal, status, or close lifecycle is needed',
    whenToUse:
      'Use for persistent terminal sessions, REPLs, TUIs, curses-style programs, multi-step CLI interaction, special keys, resize-sensitive programs, process status checks, signals, or terminal cleanup. Do not use for one-shot commands or file read/edit/search tasks.',
    userInvocable: false,
    async getPromptForCommand() {
      return [{ type: 'text', text: INTERACTIVE_TERMINAL_PROMPT }]
    },
  })
}
