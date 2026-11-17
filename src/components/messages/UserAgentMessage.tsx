import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { MessageOrigin } from '../../types/message.js'
import { formatPeerPrompt } from '../../utils/peerProtocol.js'
import { escapeXmlAttr } from '../../utils/xml.js'

type AgentMessage = { sender: string; body: string }

export function parseAgentMessage(text: string, origin?: MessageOrigin): AgentMessage | undefined {
  if (origin?.kind !== 'peer' || !origin.senderTaskId) return
  const opening = `<agent-message from="${escapeXmlAttr(origin.from)}">\n`
  const closing = '\n</agent-message>'
  const start = text.indexOf(opening)
  const end = text.lastIndexOf(closing)
  if (start < 0 || end < start + opening.length) return
  const raw = text.slice(start, end + closing.length)
  const body = text.slice(start + opening.length, end)
  if (body.includes('</agent-message>')) return
  const framed = [formatPeerPrompt(raw, false, true), formatPeerPrompt(raw, true, true)]
  if (text !== raw && !framed.some(value => text === value || text === `<system-reminder>\n${value}\n</system-reminder>`)) return
  return { sender: origin.name || origin.from, body }
}

export function UserAgentMessage({ addMargin, message }: { addMargin: boolean; message: AgentMessage }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      <Text dimColor>Agent · {message.sender}</Text>
      <Text>{message.body}</Text>
    </Box>
  )
}
