export const TERMINAL_TOOL_NAME = 'Terminal'

export const DESCRIPTION =
  'Open and control a persistent terminal session'

export const PROMPT = `Use this tool to manage persistent terminal sessions.
Actions: new-session, list-panes, send-keys, capture-pane, resize-pane, send-signal, display-message, kill-pane.
Use action=new-session to create a new session, action=list-panes to enumerate unreaped panes, then use the returned target for later calls.
Use action=send-keys with text and/or key; text is sent literally without parsing control characters.
Use action=capture-pane to capture the current visible terminal screen snapshot; cursor is accepted for compatibility but does not change the snapshot.`
