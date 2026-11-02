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
]

export function toolSummary(name: string, input: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    return input
  }
  if (typeof parsed !== 'object' || parsed === null) return input
  const fields = parsed as Record<string, unknown>
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
