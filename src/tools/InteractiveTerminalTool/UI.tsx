import * as React from 'react'
import { Text } from '../../ink.js'

export function renderToolUseMessage(input: { action?: string }): React.ReactNode {
  return <Text>InteractiveTerminal({input.action ?? 'unknown'})</Text>
}

export function renderToolResultMessage(output: Record<string, unknown>): React.ReactNode {
  if ('error' in output) {
    const error = output.error as { code?: string; message?: string }
    return <Text color="red">{error.code ?? 'ERROR'}: {error.message ?? 'unknown error'}</Text>
  }

  if ('sessionId' in output && 'text' in output) {
    return <Text>read {String(output.sessionId)} → {String(output.text)}</Text>
  }

  if ('sessionId' in output) {
    return <Text>session {String(output.sessionId)}</Text>
  }

  return <Text>InteractiveTerminal ok</Text>
}

export function renderToolUseRejectedMessage(): null {
  return null
}
