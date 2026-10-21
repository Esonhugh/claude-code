import chalk from 'chalk'
import figures from 'figures'
import React, { useEffect } from 'react'
import {
  getAdditionalDirectoriesForClaudeMd,
  setAdditionalDirectoriesForClaudeMd,
} from '../../bootstrap/state.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { AddWorkspaceDirectory } from '../../components/permissions/rules/AddWorkspaceDirectory.js'
import { Box, Text } from '../../ink.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  applyPermissionUpdate,
  persistPermissionUpdate,
} from '../../utils/permissions/PermissionUpdate.js'
import type { PermissionUpdateDestination } from '../../utils/permissions/PermissionUpdateSchema.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { executeDirectoryAddedHooks } from '../../utils/hooks.js'
import {
  addDirHelpMessage,
  validateDirectoryForWorkspace,
} from './validation.js'

function AddDirError({
  message,
  args,
  onDone,
}: {
  message: string
  args: string
  onDone: () => void
}): React.ReactNode {
  useEffect(() => {
    // We need to defer calling onDone to avoid the "return null" bug where
    // the component unmounts before React can render the error message.
    // Using setTimeout ensures the error displays before the command exits.
    const timer = setTimeout(onDone, 0)
    return () => clearTimeout(timer)
  }, [onDone])

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {figures.pointer} /add-dir {args}
      </Text>
      <MessageResponse>
        <Text>{message}</Text>
      </MessageResponse>
    </Box>
  )
}

// Hook output that reaches Claude is bounded so a chatty hook cannot flood
// the context.
const MAX_DIRECTORY_ADDED_CONTEXT_CHARS = 2000

async function runDirectoryAddedHooks(
  path: string,
  context: LocalJSXCommandContext,
): Promise<string[] | undefined> {
  const results = await executeDirectoryAddedHooks(
    path,
    'slash_command',
    context.getAppState,
  )
  const notes = results
    .map(result => result.systemMessage?.trim())
    .filter((note): note is string => !!note)
    .map(note => note.slice(0, MAX_DIRECTORY_ADDED_CONTEXT_CHARS))
  const failed = results.filter(result => !result.succeeded).length
  if (failed > 0) {
    notes.push(
      `${failed} of ${results.length} DirectoryAdded hook${results.length === 1 ? '' : 's'} failed for ${path}`,
    )
  }
  return notes.length > 0 ? notes : undefined
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode> {
  const directoryPath = (args ?? '').trim()
  const appState = context.getAppState()

  // Helper to handle adding a directory (shared by both with-path and no-path cases)
  const handleAddDirectory = async (path: string, remember = false) => {
    const destination: PermissionUpdateDestination = remember
      ? 'localSettings'
      : 'session'

    const permissionUpdate = {
      type: 'addDirectories' as const,
      directories: [path],
      destination,
    }

    // Apply to session context
    const latestAppState = context.getAppState()
    const updatedContext = applyPermissionUpdate(
      latestAppState.toolPermissionContext,
      permissionUpdate,
    )
    context.setAppState(prev => ({
      ...prev,
      toolPermissionContext: updatedContext,
    }))

    // Update sandbox config so Bash commands can access the new directory.
    // Bootstrap state is the source of truth for session-only dirs; persisted
    // dirs are picked up via the settings subscription, but we refresh
    // eagerly here to avoid a race when the user acts immediately.
    const currentDirs = getAdditionalDirectoriesForClaudeMd()
    if (!currentDirs.includes(path)) {
      setAdditionalDirectoriesForClaudeMd([...currentDirs, path])
    }
    SandboxManager.refreshConfig()

    let message: string

    if (remember) {
      try {
        persistPermissionUpdate(permissionUpdate)
        message = `Added ${chalk.bold(path)} as a working directory and saved to local settings`
      } catch (error) {
        message = `Added ${chalk.bold(path)} as a working directory. Failed to save to local settings: ${error instanceof Error ? error.message : 'Unknown error'}`
      }
    } else {
      message = `Added ${chalk.bold(path)} as a working directory for this session`
    }

    const messageWithHint = `${message} ${chalk.dim('· /permissions to manage')}`
    onDone(messageWithHint, {
      metaMessages: await runDirectoryAddedHooks(path, context),
    })
  }

  // When no path is provided, show AddWorkspaceDirectory input form directly
  // and return to REPL after confirmation
  if (!directoryPath) {
    return (
      <AddWorkspaceDirectory
        permissionContext={appState.toolPermissionContext}
        onAddDirectory={handleAddDirectory}
        onCancel={() => {
          onDone('Did not add a working directory.')
        }}
      />
    )
  }

  const result = await validateDirectoryForWorkspace(
    directoryPath,
    appState.toolPermissionContext,
  )

  if (result.resultType !== 'success') {
    const message = addDirHelpMessage(result)

    return (
      <AddDirError
        message={message}
        args={args ?? ''}
        onDone={() => onDone(message)}
      />
    )
  }

  return (
    <AddWorkspaceDirectory
      directoryPath={result.absolutePath}
      permissionContext={appState.toolPermissionContext}
      onAddDirectory={handleAddDirectory}
      onCancel={() => {
        onDone(
          `Did not add ${chalk.bold(result.absolutePath)} as a working directory.`,
        )
      }}
    />
  )
}
