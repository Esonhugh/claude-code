import React from 'react'
import { Text } from '../../ink.js'
import type { Output } from './REPLTool.js'

const SHOWN_LINES = 6

/** REPL is a transparent wrapper: the calls its script makes render as their own tool messages. */
export function renderToolUseMessage(): React.ReactNode {
  return ''
}

function shortened(text: string): string {
  const lines = text.split('\n')
  return lines.length <= SHOWN_LINES
    ? text
    : `${lines.slice(0, SHOWN_LINES).join('\n')}\n\u2026 +${lines.length - SHOWN_LINES} lines`
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  if (output.error !== undefined) return <Text color="error">{shortened(output.error)}</Text>
  const text = [output.stdout, typeof output.result === 'string' ? output.result : ''].filter(Boolean).join('\n')
  if (!text) return null
  return <Text dimColor>{shortened(text)}</Text>
}
