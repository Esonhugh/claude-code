// One-line summary of a tool call for its collapsed card and the approval prompt.
const KEY_FIELDS = [
  'command',
  'file_path',
  'notebook_path',
  'pattern',
  'path',
  'url',
  'query',
  'description',
  'prompt',
  'summary',
  'message',
]

/** The text a message tool carries (a worker's report, a message to an agent), when it has one. */
export function toolMessage(name: string, input: string): string | undefined {
  if (name !== 'SubagentHandback' && name !== 'SendMessage') return undefined
  try {
    const message = (JSON.parse(input) as { message?: unknown }).message
    return typeof message === 'string' && message.trim() ? message : undefined
  } catch {
    return undefined
  }
}

export function toolSummary(name: string, input: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    return input
  }
  if (typeof parsed !== 'object' || parsed === null) return input
  const fields = parsed as Record<string, unknown>
  if (name === 'SendMessage' && typeof fields.to === 'string') {
    const about = [fields.summary, fields.message].find(v => typeof v === 'string' && v.trim()) as string | undefined
    return about ? `→ ${fields.to} · ${about.split('\n')[0]}` : `→ ${fields.to}`
  }
  for (const key of KEY_FIELDS) {
    const value = fields[key]
    if (typeof value === 'string' && value) {
      const line = value.split('\n')[0]!
      return name === 'Grep' && typeof fields.path === 'string' && key === 'pattern'
        ? `${line} in ${fields.path}`
        : line
    }
  }
  return input
}

// CSI, OSC and other escape sequences terminal tools may print.
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '').replace(/\r\n?/g, '\n')
}
