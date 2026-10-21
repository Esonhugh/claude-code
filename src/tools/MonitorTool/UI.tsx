import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import { formatDuration } from '../../utils/format.js'
import type { Output } from './MonitorTool.js'

export function renderToolUseMessage(
  input: { description?: string; command?: string },
  { verbose }: { verbose: boolean },
): React.ReactNode {
  // Verbose (also used by the permission dialog) shows the actual command so
  // an approval is never granted on the description alone.
  if (verbose && input.command) {
    return input.description
      ? `${input.description}: ${input.command}`
      : input.command
  }
  return input.description ?? ''
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  return (
    <MessageResponse>
      <Text dimColor>
        Monitor started · {output.taskId} · expires in{' '}
        {formatDuration(output.timeoutMs, { hideTrailingZeros: true })}
      </Text>
    </MessageResponse>
  )
}
