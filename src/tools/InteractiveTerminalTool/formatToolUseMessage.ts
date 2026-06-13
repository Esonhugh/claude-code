type InteractiveTerminalToolUseInput = {
  action?: string
  cols?: number
  cwd?: string
  key?: string
  rows?: number
  sessionId?: string
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
  input: InteractiveTerminalToolUseInput,
): string {
  const action = input.action ?? 'unknown'
  const parts = [`action=${action}`]

  switch (action) {
    case 'open':
      appendIfPresent(parts, 'cwd', input.cwd)
      appendIfPresent(parts, 'cols', input.cols)
      appendIfPresent(parts, 'rows', input.rows)
      break
    case 'send_key':
      appendIfPresent(parts, 'session', input.sessionId)
      appendIfPresent(parts, 'key', input.key)
      break
    case 'resize':
      appendIfPresent(parts, 'session', input.sessionId)
      appendIfPresent(parts, 'cols', input.cols)
      appendIfPresent(parts, 'rows', input.rows)
      break
    case 'signal':
      appendIfPresent(parts, 'session', input.sessionId)
      appendIfPresent(parts, 'signal', input.signal)
      break
    case 'write':
      appendIfPresent(parts, 'session', input.sessionId)
      appendIfPresent(parts, 'text', input.text ? JSON.stringify(input.text) : undefined)
      appendIfPresent(parts, 'enter', input.enter)
      break
    case 'read':
    case 'status':
    case 'close':
      appendIfPresent(parts, 'session', input.sessionId)
      break
    default:
      appendIfPresent(parts, 'session', input.sessionId)
      break
  }

  return parts.join(' ')
}
