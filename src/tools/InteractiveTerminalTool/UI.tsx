import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { renderAnsiPreviewLine, renderAnsiPreviewLines } from '../../components/tasks/ansiPreviewRenderer.js'
import {
  interactiveTerminalPreviewHeight,
  interactiveTerminalPreviewLines,
} from '../../components/tasks/interactiveTerminalPreview.js'
import { formatToolResultMessage } from './formatToolResultMessage.js'
import { formatToolUseMessage } from './formatToolUseMessage.js'

export function renderToolUseMessage(input: Parameters<typeof formatToolUseMessage>[0]): React.ReactNode {
  return <Text>{formatToolUseMessage(input)}</Text>
}

export function renderToolResultMessage(output: Record<string, unknown>): React.ReactNode {
  if ('sessionId' in output && 'text' in output) {
    const rows =
      typeof output.rows === 'number' && Number.isFinite(output.rows)
        ? output.rows
        : 6
    const text = String(output.text ?? '')
    return (
      <Box flexDirection="column">
        <Text dimColor>{`read ${String(output.sessionId)}`}</Text>
        <Box
          borderStyle="round"
          paddingX={1}
          flexDirection="column"
          height={interactiveTerminalPreviewHeight(rows)}
        >
          {renderAnsiPreviewLines(
            interactiveTerminalPreviewLines(text, rows, 10).join('\n'),
            typeof output.cols === 'number' && Number.isFinite(output.cols)
              ? output.cols
              : 80,
          ).map(renderAnsiPreviewLine)}
        </Box>
      </Box>
    )
  }

  const message = formatToolResultMessage(output)
  if (!message) {
    return null
  }
  return <Text color={'error' in output ? 'error' : undefined}>{message}</Text>
}

export function renderToolUseRejectedMessage(): null {
  return null
}
