import figures from 'figures'
import * as React from 'react'
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { Box, Text } from '../../ink.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import { cleanPeerName, parsePeerMessage } from '../../utils/peerProtocol.js'
import { truncateToWidth } from '../../utils/truncate.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'

type Props = {
  addMargin: boolean
  param: TextBlockParam
  verbose?: boolean
  isTranscriptMode?: boolean
}

const NAME_MAX = 20
const SUMMARY_WIDTH = 120

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

// Official labels a peer by its from-name, else its socket's basename, capped at 20 characters.
function senderName(fromName: string | undefined, from: string | undefined): string {
  const address = from?.startsWith('uds:') ? decode(from.slice(4)).split(/[/\\]/).pop()?.replace(/\.sock$/, '') : undefined
  const name = cleanPeerName(fromName || address || '').replace(/\s+/g, '-')
  const chars = [...name]
  return chars.length > NAME_MAX ? `${chars.slice(0, NAME_MAX).join('')}…` : name || 'peer'
}

/** First non-empty line of the body, on one line and capped at 120 columns. */
export function peerMessageSummary(body: string): string {
  for (const line of body.split('\n')) {
    const text = line.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()
    if (text) return truncateToWidth(text, SUMMARY_WIDTH)
  }
  return ''
}

export function UserCrossSessionMessage({ addMargin, param: { text }, verbose = false, isTranscriptMode = false }: Props): React.JSX.Element {
  const expandShortcut = useShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')
  const start = text.indexOf('<cross-session-message')
  const end = text.lastIndexOf('</cross-session-message>')
  const peer = start >= 0 && end >= start
    ? parsePeerMessage(text.slice(start, end + '</cross-session-message>'.length))
    : undefined
  const name = senderName(peer?.fromName, peer?.from)
  const body = peer?.body ?? text
  if (!verbose && !isTranscriptMode) {
    const summary = peerMessageSummary(body)
    return (
      <Box flexDirection="row" marginTop={addMargin ? 1 : 0}>
        <Box minWidth={2}><Text dimColor>{figures.pointerSmall}</Text></Box>
        <Text dimColor>
          Message from @{name}
          {summary ? <Text italic>: {summary}</Text> : ''}{' '}
          <KeyboardShortcutHint shortcut={expandShortcut} action="expand" parens />
        </Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      <Text>@ {name}{figures.pointer}</Text>
      <Box paddingLeft={2}><Text>{body}</Text></Box>
    </Box>
  )
}
