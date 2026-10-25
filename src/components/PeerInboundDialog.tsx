import React from 'react'
import { Box, Text } from '../ink.js'
import type { HeldPeerMessageInfo } from '../utils/udsMessaging.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'

type Props = {
  message: HeldPeerMessageInfo
  onDone: (decision: 'approve' | 'deny') => void
}

const OPTIONS = [
  { value: 'deny' as const, label: 'Deny — drop it and tell the sender it was declined' },
  { value: 'approve' as const, label: 'Deliver this message to Claude' },
]

export function PeerInboundDialog({ message, onDone }: Props): React.ReactNode {
  return (
    <Dialog color="warning" title="Held message from another session" onCancel={() => onDone('deny')}>
      <Box flexDirection="column">
        <Text>
          Another Claude session sent a message: from {message.from}
          {message.claimedName ? ` (peer claims name: ${message.claimedName})` : ''}
        </Text>
        <Box marginTop={1}>
          <Text color="inactive">
            {message.cause === 'no-mode-asserted'
              ? 'The sender did not attest its permission mode, and this session bypasses permission prompts.'
              : "The sending session's permission mode class doesn't match this session's, so it wasn't delivered automatically."}
          </Text>
        </Box>
        {message.preview !== '' && (
          <>
            <Box marginTop={1}>
              <Text color="inactive">Message body (this is what will be delivered):</Text>
            </Box>
            <Box borderStyle="single" borderLeft borderTop={false} borderRight={false} borderBottom={false} paddingLeft={1}>
              <Text>{message.preview}</Text>
            </Box>
          </>
        )}
      </Box>
      <Select options={OPTIONS} defaultFocusValue="deny" hideIndexes onChange={onDone} />
    </Dialog>
  )
}
