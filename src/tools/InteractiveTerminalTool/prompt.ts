export const INTERACTIVE_TERMINAL_TOOL_NAME = 'InteractiveTerminal'

export const DESCRIPTION =
  'Open and control a persistent interactive terminal session'

export const PROMPT = `Use this tool to manage a persistent interactive terminal session.
Actions: open, write, read, send_key, resize, signal, status, close.
Use action=open to create a new session, then use the returned sessionId for later calls.`
