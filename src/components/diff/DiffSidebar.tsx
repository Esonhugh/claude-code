import React from 'react'
import { Box } from '../../ink.js'
import type { DiffController } from '../../services/diff/controller.js'
import type { Message } from '../../types/message.js'
import { DiffView } from './DiffView.js'

type Props = {
  messages: Message[]
  onClose: () => void
  controller?: DiffController
  keyboardEnabled?: boolean
}

export function DiffSidebar({
  messages,
  onClose,
  controller,
  keyboardEnabled = false,
}: Props): React.ReactNode {
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      minHeight={0}
      overflow="hidden"
      borderStyle="single"
      borderLeft
      borderRight={false}
      borderTop={false}
      borderBottom={false}
      paddingX={1}
    >
      <DiffView
        messages={messages}
        controller={controller}
        keyboardEnabled={keyboardEnabled}
        presentation="sidebar"
        onClose={onClose}
      />
    </Box>
  )
}
