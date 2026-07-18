type TerminalToolUseInput = {
  action?: string
  cols?: number
  cwd?: string
  args?: string[]
  command?: string
  key?: string
  rows?: number
  target?: string
  signal?: string
  text?: string
  enter?: boolean
}

function appendIfPresent(parts: string[], label: string, value: unknown): void {
  if (value === undefined || value === null || value === '') {
    return
  }
  parts.push(`${label}=${String(value)}`)
}

export function formatToolUseMessage(
  input: TerminalToolUseInput,
): string {
  const action = input.action ?? 'unknown'
  const parts = [`action=${action}`]

  switch (action) {
    case 'new-session':
      appendIfPresent(parts, 'command', input.command ?? '<default-shell>')
      appendIfPresent(parts, 'args', input.args ? JSON.stringify(input.args) : undefined)
      appendIfPresent(parts, 'cwd', input.cwd)
      appendIfPresent(parts, 'cols', input.cols)
      appendIfPresent(parts, 'rows', input.rows)
      break
    case 'send-keys':
      appendIfPresent(parts, 'target', input.target)
      appendIfPresent(parts, 'text', input.text ? JSON.stringify(input.text) : undefined)
      appendIfPresent(parts, 'key', input.key)
      appendIfPresent(parts, 'enter', input.enter)
      break
    case 'resize-pane':
      appendIfPresent(parts, 'target', input.target)
      appendIfPresent(parts, 'cols', input.cols)
      appendIfPresent(parts, 'rows', input.rows)
      break
    case 'send-signal':
      appendIfPresent(parts, 'target', input.target)
      appendIfPresent(parts, 'signal', input.signal)
      break
    case 'list-panes':
      break
    case 'capture-pane':
    case 'display-message':
    case 'kill-pane':
      appendIfPresent(parts, 'target', input.target)
      break
    default:
      appendIfPresent(parts, 'target', input.target)
      break
  }

  return parts.join(' ')
}
