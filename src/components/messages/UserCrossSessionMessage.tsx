import * as React from 'react'
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { Box, Text } from '../../ink.js'
import { parsePeerMessage } from '../../utils/peerProtocol.js'

type Props = {
  addMargin: boolean
  param: TextBlockParam
}

export function UserCrossSessionMessage({ addMargin, param: { text } }: Props): React.JSX.Element {
  const start = text.indexOf('<cross-session-message')
  const end = text.lastIndexOf('</cross-session-message>')
  const peer = start >= 0 && end >= start
    ? parsePeerMessage(text.slice(start, end + '</cross-session-message>'.length))
    : undefined
  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      <Text dimColor>Peer · {peer?.fromName ?? peer?.from ?? 'another session'}</Text>
      <Text>{peer?.body ?? text}</Text>
    </Box>
  )
}
