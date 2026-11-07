import * as React from 'react'
import { FileEditToolUpdatedMessage } from '../../components/FileEditToolUpdatedMessage.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Box, Text } from '../../ink.js'
import type { ProgressMessage } from '../../types/message.js'
import { getDisplayPath } from '../../utils/file.js'
import type { ApplyPatchOutput } from './ApplyPatchTool.js'

const FILE_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm

export function patchedPaths(patch: string | undefined): string[] {
  if (!patch) return []
  return [...patch.matchAll(FILE_HEADER)].map(m => m[1]!.trim())
}

export function userFacingName(): string {
  return 'Patch'
}

export function getToolUseSummary(input: Partial<{ input: string }> | undefined): string | null {
  const paths = patchedPaths(input?.input)
  if (paths.length === 0) return null
  return paths.map(p => getDisplayPath(p)).join(', ')
}

export function renderToolUseMessage(
  input: Partial<{ input: string }>,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  const paths = patchedPaths(input.input)
  if (paths.length === 0) return null
  if (verbose || paths.length <= 3) return paths.map(p => getDisplayPath(p)).join(', ')
  return `${paths.slice(0, 3).map(p => getDisplayPath(p)).join(', ')} and ${paths.length - 3} more`
}

export function renderToolResultMessage(
  { files }: ApplyPatchOutput,
  _progressMessagesForMessage: ProgressMessage[],
  { style, verbose }: { style?: 'condensed'; verbose: boolean },
): React.ReactNode {
  return (
    <Box flexDirection="column">
      {files.map(file =>
        file.type === 'delete' ? (
          <MessageResponse key={file.filePath}>
            <Text>
              Deleted <Text bold>{getDisplayPath(file.filePath)}</Text>
            </Text>
          </MessageResponse>
        ) : (
          <FileEditToolUpdatedMessage
            key={file.filePath}
            filePath={file.movePath ?? file.filePath}
            structuredPatch={file.structuredPatch}
            firstLine={file.originalFile.split('\n')[0] ?? null}
            fileContent={file.originalFile}
            style={style}
            verbose={verbose}
          />
        ),
      )}
    </Box>
  )
}
