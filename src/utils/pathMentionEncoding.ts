const SAFE_UNQUOTED_PATH_RE = /^[\p{L}\p{N}\p{M}_\-./\\()[\]~:]+$/u

function encodeQuotedContent(path: string): string {
  return JSON.stringify(path).slice(1, -1)
}

export function needsQuotedPathMention(path: string): boolean {
  return !SAFE_UNQUOTED_PATH_RE.test(path)
}

export function encodePathMention(path: string, complete: boolean): string {
  if (!needsQuotedPathMention(path)) {
    return `@${path}${complete ? ' ' : ''}`
  }

  return `@"${encodeQuotedContent(path)}${complete ? '" ' : ''}`
}

function hasUnescapedClosingQuote(value: string): boolean {
  if (!value.endsWith('"')) return false
  let precedingBackslashes = 0
  for (let index = value.length - 2; index >= 0 && value[index] === '\\'; index--) {
    precedingBackslashes += 1
  }
  return precedingBackslashes % 2 === 0
}

export function decodePathMentionToken(token: string): string {
  const withoutAt = token.startsWith('@') ? token.slice(1) : token
  if (!withoutAt.startsWith('"')) return withoutAt

  const encoded = withoutAt.slice(
    1,
    hasUnescapedClosingQuote(withoutAt) ? -1 : undefined,
  )
  try {
    return JSON.parse(`"${encoded}"`) as string
  } catch {
    return encoded
  }
}

export function extractPathMentions(content: string): string[] {
  const mentions: string[] = []

  for (let index = 0; index < content.length; index += 1) {
    if (
      content[index] !== '@' ||
      (index > 0 && !/\s/.test(content[index - 1]!))
    ) {
      continue
    }

    if (content[index + 1] === '"') {
      let cursor = index + 2
      let escaped = false
      while (cursor < content.length) {
        const char = content[cursor]!
        if (!escaped && char === '"') break
        escaped = !escaped && char === '\\'
        if (char !== '\\') escaped = false
        cursor += 1
      }
      if (cursor >= content.length) continue
      const value = decodePathMentionToken(content.slice(index, cursor + 1))
      if (!value.endsWith(' (agent)') && !value.startsWith('codex-app:')) {
        mentions.push(value)
      }
      index = cursor
      continue
    }

    let cursor = index + 1
    while (cursor < content.length && !/\s/.test(content[cursor]!)) cursor += 1
    const value = content
      .slice(index + 1, cursor)
      .replace(/[.,;:!?]+$/u, '')
    if (value && !value.startsWith('codex-app:')) mentions.push(value)
    index = cursor - 1
  }

  return mentions
}
