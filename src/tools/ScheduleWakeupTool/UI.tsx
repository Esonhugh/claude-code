import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import type { Output } from './ScheduleWakeupTool.js'

export function renderToolUseMessage(
  input: Partial<{ delaySeconds: number; reason: string; stop: boolean }>,
): React.ReactNode {
  if (input.stop === true) return 'stop'
  return input.reason ?? ''
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  if (output.stopped === true) {
    return (
      <MessageResponse>
        <Text dimColor>Loop stopped</Text>
      </MessageResponse>
    )
  }
  if (output.scheduledFor === 0) {
    return (
      <MessageResponse>
        <Text dimColor>Loop reached its maximum duration</Text>
      </MessageResponse>
    )
  }
  const time = new Date(output.scheduledFor).toTimeString().slice(0, 8)
  return (
    <MessageResponse>
      <Text dimColor>
        Next wakeup at {time} (in {output.clampedDelaySeconds}s)
      </Text>
    </MessageResponse>
  )
}
