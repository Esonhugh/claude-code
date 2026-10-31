export const TERMINAL_TOOL_NAME = 'Terminal'

export const DESCRIPTION =
  'Open and control a persistent terminal session'

export const PROMPT = `Manage persistent terminal sessions (panes). Every action except new-session and list-panes needs \`target\`, the pane id returned by new-session or list-panes (e.g. "term-1").
- new-session: \`command\` is one executable and its arguments go in \`args\` (command="ssh", args=["-o","ConnectTimeout=15","host"]); omit command for the default shell. Optional cwd, env, cols, rows.
- send-keys: \`text\` is typed literally (no escape parsing); \`key\` sends one special key (ENTER, CTRL_C, ...); \`enter: true\` presses Enter after the text.
- capture-pane: returns the current screen. \`mode\`: "compact" (default; long output is elided to maxLines=80 / maxBytes=8192), "full" (raw text up to maxBytes), "save_file" (writes the whole screen to a file and returns \`filePath\` plus a short preview; use it when the user wants the output saved).
- display-message: pane status (isRunning, exitCode, pid, size). resize-pane: cols and rows. send-signal: SIGINT or SIGTERM. kill-pane: closes the pane; you will not get a later notification for it.
- When the Bash sandbox is enabled, new-session runs inside it; set dangerouslyDisableSandbox=true only when the session must run outside it.`
