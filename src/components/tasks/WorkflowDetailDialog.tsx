import * as React from 'react'
import { Byline } from '../../components/design-system/Byline.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { formatWorkflowDetailSnapshot } from './workflowDetailSnapshot.js'

type Props = {
  workflow?: LocalWorkflowTaskState
  onBack?: () => void
  onKill?: () => void
  onSkipAgent?: (agentId: string) => void
  onRetryAgent?: (agentId: string) => void
}

export function WorkflowDetailDialog({
  workflow,
  onBack,
  onKill,
}: Props): React.JSX.Element {
  const close = onBack ?? (() => undefined)
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'left' && onBack) {
      e.preventDefault()
      onBack()
    } else if (e.key === 'x' && workflow?.status === 'running' && onKill) {
      e.preventDefault()
      onKill()
    }
  }

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog
        title="Dynamic workflow"
        subtitle={workflow ? workflow.workflowName ?? workflow.description : undefined}
        onCancel={close}
        color="suggestion"
        inputGuide={exitState =>
          exitState.pending ? (
            <Text>Press {exitState.keyName} again to exit</Text>
          ) : (
            <Byline>
              {onBack && <KeyboardShortcutHint shortcut="Esc/←" action="back" />}
              {workflow?.status === 'running' && onKill && (
                <KeyboardShortcutHint shortcut="x" action="cancel workflow" />
              )}
            </Byline>
          )
        }
      >
        <Text>{workflow ? formatWorkflowDetailSnapshot(workflow) : 'Workflow details unavailable in this recovery build.'}</Text>
      </Dialog>
    </Box>
  )
}
