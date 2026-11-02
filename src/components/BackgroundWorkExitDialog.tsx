import React from 'react'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, Text } from '../ink.js'
import { logEvent } from '../services/analytics/index.js'
import type { BackgroundWorkItem } from '../tasks/backgroundWorkOnExit.js'
import { Select } from './CustomSelect/select.js'
import { Dialog } from './design-system/Dialog.js'

type Props = {
  items: BackgroundWorkItem[]
  onExit: () => void
  onCancel: () => void
}

// Official 2.1.311: /exit with background work asks first and lists what stops.
export function BackgroundWorkExitDialog({
  items,
  onExit,
  onCancel,
}: Props): React.ReactNode {
  const { rows } = useTerminalSize()
  const shown = items.slice(0, Math.max(1, rows - 12))
  const hidden = items.length - shown.length

  function choose(value: string) {
    logEvent('tengu_exit_background_work_prompt', {
      item_count: items.length,
      chose_exit: value === 'exit',
      chose_background: false,
    })
    if (value === 'exit') onExit()
    else onCancel()
  }

  return (
    <Dialog
      title="Background work is running"
      subtitle="The following will stop when you exit:"
      onCancel={() => choose('stay')}
    >
      <Box flexDirection="column">
        {shown.map((item, i) => (
          <Box key={i} flexDirection="row">
            <Text bold>{item.label}</Text>
            {item.detail ? <Text dimColor> · {item.detail}</Text> : null}
          </Box>
        ))}
        {hidden > 0 ? (
          <Text dimColor>
            +{hidden} more {hidden === 1 ? 'item' : 'items'}
          </Text>
        ) : null}
      </Box>
      <Select
        options={[
          { label: 'Exit and stop tasks', value: 'exit' },
          { label: 'Stay', value: 'stay' },
        ]}
        onChange={choose}
      />
    </Dialog>
  )
}
