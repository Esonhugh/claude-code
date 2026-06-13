export const INTERACTIVE_TERMINAL_TOOL_NAME = 'InteractiveTerminal'

export const DESCRIPTION =
  'Open and control a persistent interactive terminal session'

export const PROMPT = `Use this tool to manage persistent interactive terminal sessions.
Actions: open, list, write, read, send_key, resize, signal, status, close.
Use action=open to create a new session, action=list to enumerate unreaped sessions, then use the returned sessionId for later calls.
Use action=read to capture the current visible terminal screen snapshot; cursor is accepted for compatibility but does not change the snapshot.`
