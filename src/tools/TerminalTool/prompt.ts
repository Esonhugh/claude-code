export const TERMINAL_TOOL_NAME = 'Tmux'
export const LEGACY_TERMINAL_TOOL_NAME = 'Terminal'

export const DESCRIPTION =
  'Open and control a persistent terminal session'

export const PROMPT = `Manage persistent terminal panes for REPLs, TUIs, ssh and prompts instead of tmux/screen via Bash. Actions except new-session and list-panes need \`target\` (e.g. "term-1").
- new-session: \`command\` is one executable, arguments in \`args\`; omit for the default shell. Optional cwd, env, cols, rows.
- new-session \`inputMode: "interactive"\`: requires human approval even in bypass. All later session input, including shell escapes, skips Bash command deny checks. Grant ends on close; other sessions are unaffected. Omit for shell checks.
- send-keys: literal \`text\`, special \`key\` (ENTER, CTRL_C, ...), \`enter: true\` submits.
- capture-pane: current screen; \`mode\` "compact" (default, elided), "full" (raw text), "save_file" (whole screen to \`filePath\` plus preview). maxBytes/maxLines limit output.
- display-message: isRunning, exitCode, pid, size. resize-pane: cols/rows. send-signal: SIGINT/SIGTERM. kill-pane: close without later notification. list-panes: list sessions.
- new-session uses the Bash sandbox when enabled; dangerouslyDisableSandbox=true requests running outside it.`
