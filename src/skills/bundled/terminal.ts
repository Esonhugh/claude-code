import { registerBundledSkill } from '../bundledSkills.js'

const TERMINAL_PROMPT = `# Terminal Skill

Use this model-internal skill to decide when and how to use the Terminal tool.

## Core rule

Use Terminal for persistent terminal sessions. Use Bash for one-shot commands. Do not use Terminal for file reads, edits, or searches; use Read, Edit, Write, Grep, or Glob instead.

## Use Terminal for

- REPL sessions.
- TUI or curses-style programs.
- CLI programs that need multiple inputs over time.
- Processes where you must send special keys.
- Programs that depend on terminal size.
- Long-lived sessions where you need status, signals, or cleanup.
- Interactive verification of local CLI behavior.

## Do not use Terminal for

Do not use Terminal for file reads, edits, or searches. Use Read, Edit, Write, Grep, or Glob instead.

Use Bash for one-shot commands that simply run and exit. Bash is not suitable for multi-step interaction because Bash can block, lose interactive state, or fail to represent a real TTY/TUI screen.

## Lifecycle

1. new-session: create a session and capture the returned target.
2. capture-pane: inspect the visible terminal screen before deciding what to type.
3. send-keys: send normal text, supported special keys, and/or Enter.
4. resize-pane: change rows and columns when layout matters.
5. display-message: check whether the process is still running before assuming it can receive input.
6. send-signal: send SIGINT or SIGTERM when the running process needs a signal.
7. list-panes: enumerate unreaped panes when you need to recover a target.
8. kill-pane: close sessions when finished.

## Starting commands

- new-session accepts command as one executable and args as its argv array.
- Never combine an executable and its arguments into command, and never use shell command strings when command plus args can express the invocation.
- Bare executable names are resolved through PATH.
- Relative executable paths such as ./built-claude are resolved from cwd.
- Omit command or pass an empty string to start the current user's default SHELL.
- Omit args to use default shell arguments; pass an empty args array to explicitly start it without arguments.

## Operating guidance

- Always capture-pane before deciding what to type next.
- Use send-keys for ordinary text, special keys, and Enter; keep text/key/enter as structured fields.
- Do not embed control characters in text when key can express the key.
- Track target explicitly; losing it means losing control of the process.
- Use resize-pane before interacting with layout-sensitive TUIs.
- Prefer capture-pane/display-message checks over arbitrary sleep loops.
- Use send-signal for interruption or termination instead of sending text that looks like a signal.
- Close sessions with kill-pane when finished.
- If a nested Claude session or complex TUI stalls, report the stall and avoid blind retries.

## Common failure modes without this skill

- Bash can block on a program that expects ongoing input.
- Bash is not suitable for multi-step interaction with changing screen state.
- TUI layout can break when the terminal size is wrong.
- Direction keys, Escape, Ctrl+C, and Ctrl+D can be misinterpreted if sent as plain text.
- Acting without a fresh capture-pane can target the wrong prompt, menu item, or focused control.
- Sending keys after the process exits fails or sends input to the wrong place.
- Forgetting kill-pane can leave sessions or child processes running.
`

export function registerTerminalSkill(): void {
  registerBundledSkill({
    name: 'terminal',
    description:
      'Use when a persistent terminal, REPL, TUI, curses-style program, multi-step CLI session, special key input, resize, signal, status, or close lifecycle is needed',
    whenToUse:
      'Use for persistent terminal sessions, REPLs, TUIs, curses-style programs, multi-step CLI interaction, special keys, resize-sensitive programs, process status checks, signals, or terminal cleanup. Do not use for one-shot commands or file read/edit/search tasks.',
    userInvocable: false,
    async getPromptForCommand() {
      return [{ type: 'text', text: TERMINAL_PROMPT }]
    },
  })
}
