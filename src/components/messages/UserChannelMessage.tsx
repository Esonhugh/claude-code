import * as React from 'react'
import { CHANNEL_ARROW } from '../../constants/figures.js'
import { CHANNEL_TAG } from '../../constants/xml.js'
import { Box, Text } from '../../ink.js'
import { truncateToWidth } from '../../utils/format.js'

export type ChannelMessage = { source: string; user?: string; content: string }

type Props = {
  addMargin: boolean
  message: ChannelMessage
}

// <channel source="..." user="..." chat_id="...">content</channel>
// source is always first (wrapChannelMessage writes it), user is optional.
// The whole text must be one wrapper so a prompt that merely mentions the tag
// still renders as the person's own message.
const CHANNEL_RE = new RegExp(
  `^<${CHANNEL_TAG}\\s+source="([^"]+)"([^>]*)>\\n?([\\s\\S]*?)\\n?</${CHANNEL_TAG}>\\s*$`,
)
const USER_ATTR_RE = /\buser="([^"]+)"/

// Reverses escapeXmlAttr for display.
function unescapeXmlAttr(value: string): string {
  return value.replace(/&(quot|apos|lt|gt|amp);/g, (_, name: string) =>
    ({ quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' })[name]!,
  )
}

export function parseChannelMessage(text: string): ChannelMessage | undefined {
  const m = CHANNEL_RE.exec(text)
  if (!m) return undefined
  const user = USER_ATTR_RE.exec(m[2] ?? '')?.[1]
  return {
    source: unescapeXmlAttr(m[1]!),
    ...(user !== undefined && { user: unescapeXmlAttr(user) }),
    content: m[3] ?? '',
  }
}

// Plugin-provided servers get names like plugin:slack-channel:slack via
// addPluginScopeToServers — show just the leaf. Matches the suffix-match
// logic in isServerInChannels.
function displayServerName(name: string): string {
  const i = name.lastIndexOf(':')
  return i === -1 ? name : name.slice(i + 1)
}

const TRUNCATE_AT = 60

export function UserChannelMessage({
  addMargin,
  message: { source, user, content },
}: Props): React.ReactNode {
  const body = content.trim().replace(/\s+/g, ' ')
  const truncated = truncateToWidth(body, TRUNCATE_AT)
  return (
    <Box marginTop={addMargin ? 1 : 0}>
      <Text>
        <Text color="suggestion">{CHANNEL_ARROW}</Text>{' '}
        <Text dimColor>
          {displayServerName(source)}
          {user ? ` \u00b7 ${user}` : ''}:
        </Text>{' '}
        {truncated}
      </Text>
    </Box>
  )
}
