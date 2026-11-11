import * as React from 'react'
import { FileEditToolUpdatedMessage } from '../../components/FileEditToolUpdatedMessage.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { BLACK_CIRCLE } from '../../constants/figures.js'
import { Box, Text } from '../../ink.js'
import type { ProgressMessage } from '../../types/message.js'
import { getDisplayPath } from '../../utils/file.js'
import type { ApplyPatchOutput } from './ApplyPatchTool.js'

const FILE_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm

function patchedFiles(patch: string | undefined): { action: string; path: string }[] {
  if (!patch) return []
  return [...patch.matchAll(FILE_HEADER)].map(m => ({ action: m[1]!, path: m[2]!.trim() }))
}

export function patchedPaths(patch: string | undefined): string[] {
  return patchedFiles(patch).map(f => f.path)
}

// Each file reads like the Edit and Write rows: Write for a new file, Update
// for a changed one, Delete for a removed one.
const ROW_NAME: Record<string, string> = { Add: 'Write', add: 'Write', Update: 'Update', update: 'Update', Delete: 'Delete', delete: 'Delete' }

export function userFacingName(input?: Partial<{ input: string }>): string {
  const first = patchedFiles(input?.input)[0]
  return first ? ROW_NAME[first.action]! : 'Patch'
}

export function getToolUseSummary(input: Partial<{ input: string }> | undefined): string | null {
  const paths = patchedPaths(input?.input)
  if (paths.length === 0) return null
  return paths.map(p => getDisplayPath(p)).join(', ')
}

// The row names the first file; the result adds a row for each other file.
export function renderToolUseMessage(input: Partial<{ input: string }>): React.ReactNode {
  const first = patchedPaths(input.input)[0]
  return first ? getDisplayPath(first) : null
}

function FileRow({ name, path, error }: { name: string; path: string; error?: boolean }): React.ReactNode {
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box minWidth={2}>
        <Text color={error ? 'error' : 'success'}>{BLACK_CIRCLE}</Text>
      </Box>
      <Text bold>{name}</Text>
      <Text>({getDisplayPath(path)})</Text>
    </Box>
  )
}

export function renderToolResultMessage(
  { files, failure }: ApplyPatchOutput,
  _progressMessagesForMessage: ProgressMessage[],
  { style, verbose }: { style?: 'condensed'; verbose: boolean },
): React.ReactNode {
  return (
    <Box flexDirection="column">
      {files.map((file, i) => (
        <Box key={file.filePath} flexDirection="column">
          {i > 0 && <FileRow name={ROW_NAME[file.type]!} path={file.movePath ?? file.filePath} />}
          {file.type === 'delete' ? (
            <MessageResponse>
              <Text>Deleted file</Text>
            </MessageResponse>
          ) : (
            <FileEditToolUpdatedMessage
              filePath={file.movePath ?? file.filePath}
              structuredPatch={file.structuredPatch}
              firstLine={file.originalFile.split('\n')[0] ?? null}
              fileContent={file.originalFile}
              style={style}
              verbose={verbose}
            />
          )}
        </Box>
      ))}
      {failure && (
        <Box flexDirection="column">
          <FileRow name={ROW_NAME[failure.type]!} path={failure.filePath} error />
          <MessageResponse>
            <Text color="error">Error: {failure.message}</Text>
          </MessageResponse>
          {failure.notAttempted.length > 0 && (
            <MessageResponse>
              <Text dimColor>Not attempted: {failure.notAttempted.map(p => getDisplayPath(p)).join(', ')}</Text>
            </MessageResponse>
          )}
        </Box>
      )}
    </Box>
  )
}
