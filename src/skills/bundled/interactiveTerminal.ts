import { registerBundledSkill } from '../bundledSkills.js'

const INTERACTIVE_TERMINAL_PROMPT = `# InteractiveTerminal Skill

Use this model-internal skill to decide when and how to use the InteractiveTerminal tool.

## Core rule

Use InteractiveTerminal for persistent terminal sessions. Use Bash for one-shot commands. Do not use InteractiveTerminal for file reads, edits, or searches; use Read, Edit, Write, Grep, or Glob instead.

## Use InteractiveTerminal for

- REPL sessions.
- TUI or curses-style programs.
- CLI programs that need multiple inputs over time.
- Processes where you must send special keys.
- Programs that depend on terminal size.
- Long-lived sessions where you need status, signals, or cleanup.
- Interactive verification of local CLI behavior.

## Do not use InteractiveTerminal for

Do not use InteractiveTerminal for file reads, edits, or searches. Use Read, Edit, Write, Grep, or Glob instead.

Use Bash for one-shot commands that simply run and exit. Bash is not suitable for multi-step interaction because Bash can block, lose interactive state, or fail to represent a real TTY/TUI screen.

## Lifecycle

1. open: create a session and capture the returned sessionId.
2. read: inspect the visible terminal screen before deciding what to type.
3. write: send normal text input.
4. send_key: send Enter, Tab, Escape, arrows, Ctrl+C, Ctrl+D, and other supported special keys.
5. resize: change rows and columns when layout matters.
6. status: check whether the process is still running before assuming it can receive input.
7. signal: send SIGINT or SIGTERM when the running process needs a signal.
8. list: enumerate unreaped sessions when you need to recover a sessionId.
9. close: Close sessions when finished.

## Operating guidance

- Always read before deciding what to type next.
- Use write for ordinary text and send_key for special keys.
- Do not embed control characters in write text when send_key can express the key.
- Track sessionId explicitly; losing it means losing control of the process.
- Use resize before interacting with layout-sensitive TUIs.
- Prefer read/status checks over arbitrary sleep loops.
- Use signal for interruption or termination instead of sending text that looks like a signal.
- Close sessions when finished.
- If a nested Claude session or complex TUI stalls, report the stall and avoid blind retries.

## Common failure modes without this skill

- Bash can block on a program that expects ongoing input.
- Bash is not suitable for multi-step interaction with changing screen state.
- TUI layout can break when the terminal size is wrong.
- Direction keys, Escape, Ctrl+C, and Ctrl+D can be misinterpreted if sent as plain text.
- Acting without a fresh read can target the wrong prompt, menu item, or focused control.
- Writing after the process exits silently fails or sends input to the wrong place.
- Forgetting close can leave sessions or child processes running.
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
