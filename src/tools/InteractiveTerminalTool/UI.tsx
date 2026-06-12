import * as React from 'react'
import { Text } from '../../ink.js'
import { formatToolResultMessage } from './formatToolResultMessage.js'
import { formatToolUseMessage } from './formatToolUseMessage.js'

export function renderToolUseMessage(input: Parameters<typeof formatToolUseMessage>[0]): React.ReactNode {
  return <Text>{formatToolUseMessage(input)}</Text>
}

export function renderToolResultMessage(output: Record<string, unknown>): React.ReactNode {
  const message = formatToolResultMessage(output)
  if (!message) {
    return null
  }
  return <Text color={'error' in output ? 'error' : undefined}>{message}</Text>
}

export function renderToolUseRejectedMessage(): null {
  return null
}
