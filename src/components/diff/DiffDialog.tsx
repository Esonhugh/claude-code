import React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { useRegisterOverlay } from '../../context/overlayContext.js'
import type { DiffController } from '../../services/diff/controller.js'
import type { Message } from '../../types/message.js'
import { DiffView } from './DiffView.js'

type Props = {
  messages: Message[]
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  controller?: DiffController
  keyboardEnabled?: boolean
}

export function DiffDialog({
  messages,
  onDone,
  controller,
  keyboardEnabled = true,
}: Props): React.ReactNode {
  useRegisterOverlay('diff-dialog')
  return (
    <DiffView
      messages={messages}
      controller={controller}
      presentation="dialog"
      keyboardEnabled={keyboardEnabled}
      onClose={() => onDone('Diff dialog dismissed', { display: 'system' })}
    />
  )
}
