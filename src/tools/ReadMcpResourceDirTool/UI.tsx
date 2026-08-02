import * as React from 'react'
import type { z } from 'zod/v4'
import { MessageResponse } from '../../components/MessageResponse.js'
import { OutputLine } from '../../components/shell/OutputLine.js'
import { Text } from '../../ink.js'
import type { ToolProgressData } from '../../Tool.js'
import type { ProgressMessage } from '../../types/message.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import type { inputSchema, Output } from './ReadMcpResourceDirTool.js'

export function renderToolUseMessage(
  input: Partial<z.infer<ReturnType<typeof inputSchema>>>,
): React.ReactNode {
  if (!input.uri || !input.server) {
    return null
  }
  return `List directory resource "${input.uri}" from server "${input.server}"`
}

export function userFacingName(): string {
  return 'readMcpResourceDir'
}

export function renderToolResultMessage(
  output: Output,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (output?.error) {
    return <OutputLine content={output.error} verbose={verbose} />
  }

  if (!output || output.resources.length === 0) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>(Empty directory)</Text>
      </MessageResponse>
    )
  }

  // eslint-disable-next-line no-restricted-syntax -- human-facing UI, not tool_result
  const formattedOutput = jsonStringify(output, null, 2)

  return <OutputLine content={formattedOutput} verbose={verbose} />
}
