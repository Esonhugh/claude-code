import { homedir } from 'os'
import { join, sep } from 'path'
import React, { type ReactNode } from 'react'
import { getOriginalCwd } from '../../../bootstrap/state.js'
import { Text } from '../../../ink.js'
import { getShortcutDisplay } from '../../../keybindings/shortcutFormat.js'
import type { ToolPermissionContext } from '../../../Tool.js'
import { expandPath } from '../../../utils/path.js'
import {
  generateSuggestions,
  normalizeCaseForComparison,
} from '../../../utils/permissions/filesystem.js'
import type { OptionWithDescription } from '../../CustomSelect/select.js'
/**
 * Check if a path is within the project's .claude/ folder.
 * This is used to determine whether to show the special ".claude folder" permission option.
 */
export function isInClaudeFolder(filePath: string): boolean {
  const absolutePath = expandPath(filePath)
  const claudeFolderPath = expandPath(`${getOriginalCwd()}/.claude`)

  // Check if the path is within the project's .claude folder
  const normalizedAbsolutePath = normalizeCaseForComparison(absolutePath)
  const normalizedClaudeFolderPath =
    normalizeCaseForComparison(claudeFolderPath)

  // Path must start with the .claude folder path (and be inside it, not just the folder itself)
  return (
    normalizedAbsolutePath.startsWith(
      normalizedClaudeFolderPath + sep.toLowerCase(),
    ) ||
    // Also match case where sep is / on posix systems
    normalizedAbsolutePath.startsWith(normalizedClaudeFolderPath + '/')
  )
}

/**
 * Check if a path is within the global ~/.claude/ folder.
 * This is used to determine whether to show the special ".claude folder" permission option
 * for files in the user's home directory.
 */
export function isInGlobalClaudeFolder(filePath: string): boolean {
  const absolutePath = expandPath(filePath)
  const globalClaudeFolderPath = join(homedir(), '.claude')

  const normalizedAbsolutePath = normalizeCaseForComparison(absolutePath)
  const normalizedGlobalClaudeFolderPath = normalizeCaseForComparison(
    globalClaudeFolderPath,
  )

  return (
    normalizedAbsolutePath.startsWith(
      normalizedGlobalClaudeFolderPath + sep.toLowerCase(),
    ) ||
    normalizedAbsolutePath.startsWith(normalizedGlobalClaudeFolderPath + '/')
  )
}

export type PermissionOption =
  | { type: 'accept-once' }
  | { type: 'accept-session'; scope?: 'claude-folder' | 'global-claude-folder' }
  | { type: 'reject' }

export type PermissionOptionWithLabel = OptionWithDescription<string> & {
  option: PermissionOption
}

export type FileOperationType = 'read' | 'write' | 'create'

export function getFilePermissionOptions({
  filePath,
  toolPermissionContext,
  operationType = 'write',
  onRejectFeedbackChange,
  onAcceptFeedbackChange,
  yesInputMode = false,
  noInputMode = false,
}: {
  filePath: string
  toolPermissionContext: ToolPermissionContext
  operationType?: FileOperationType
  onRejectFeedbackChange?: (value: string) => void
  onAcceptFeedbackChange?: (value: string) => void
  yesInputMode?: boolean
  noInputMode?: boolean
}): PermissionOptionWithLabel[] {
  const options: PermissionOptionWithLabel[] = []
  const modeCycleShortcut = getShortcutDisplay(
    'chat:cycleMode',
    'Chat',
    'shift+tab',
  )

  // When in input mode, show input field
  if (yesInputMode && onAcceptFeedbackChange) {
    options.push({
      type: 'input',
      label: 'Yes',
      value: 'yes',
      placeholder: 'and tell Claude what to do next',
      onChange: onAcceptFeedbackChange,
      allowEmptySubmitToCancel: true,
      option: { type: 'accept-once' },
    })
  } else {
    options.push({
      label: 'Yes',
      value: 'yes',
      option: { type: 'accept-once' },
    })
  }

  // Check if this is a .claude/ folder path (project or global)
  const inClaudeFolder = isInClaudeFolder(filePath)
  const inGlobalClaudeFolder = isInGlobalClaudeFolder(filePath)

  // Option 2: For .claude/ folder, show special option instead of generic session option
  // Note: Session-level options are always shown since they only affect in-memory state,
  // not persisted settings. The allowManagedPermissionRulesOnly setting only restricts
  // persisted permission rules.
  if ((inClaudeFolder || inGlobalClaudeFolder) && operationType !== 'read') {
    options.push({
      label: inGlobalClaudeFolder
        ? 'Yes, and allow Claude to edit files in its ~/.claude folder for this session'
        : "Yes, and allow Claude to edit files in this project's .claude folder for this session",
      value: 'yes-claude-folder',
      option: {
        type: 'accept-session',
        scope: inGlobalClaudeFolder ? 'global-claude-folder' : 'claude-folder',
      },
    })
  } else {
    // Option 2 names exactly the updates "yes-session" applies, like
    // official: the accept-edits switch, added directories, read rules.
    const suggestions = generateSuggestions(
      filePath,
      operationType,
      toolPermissionContext,
    )
    const rows: ReactNode[] = []
    if (
      suggestions.some(s => s.type === 'setMode' && s.mode === 'acceptEdits')
    ) {
      rows.push(
        <Text>
          Yes, and switch to{' '}
          <Text bold>
            accept edits (auto-approve file edits and common file commands)
          </Text>{' '}
          for this session
        </Text>,
      )
    }
    const directories = [
      ...new Set(
        suggestions.flatMap(s =>
          s.type === 'addDirectories' ? s.directories : [],
        ),
      ),
    ]
    if (directories.length > 0) {
      rows.push(
        <Text>
          Yes, and always allow access to{' '}
          <Text bold>{directories.join(', ')}</Text> for this session
        </Text>,
      )
    }
    const readPaths = [
      ...new Set(
        suggestions.flatMap(s =>
          s.type === 'addRules'
            ? s.rules.map(r =>
                (r.ruleContent ?? '')
                  .replace(/\/\*\*$/, '')
                  .replace(/^\.\//, '')
                  .replace(/^\/\//, '/'),
              )
            : [],
        ),
      ),
    ].filter(Boolean)
    if (readPaths.length > 0) {
      const last = readPaths.at(-1)!
      rows.push(
        <Text>
          Yes, allow reading from{' '}
          {readPaths.slice(0, -1).map((path, i) => (
            <Text key={i}>
              <Text bold>{path}</Text>
              {readPaths.length > 2 ? ', ' : ' '}
            </Text>
          ))}
          {readPaths.length > 1 && 'and '}
          <Text bold>{last}</Text> during this session
        </Text>,
      )
    }

    if (rows.length > 0) {
      options.push({
        label: (
          <Text>
            {rows.map((row, i) => (
              <Text key={i}>
                {i > 0 && '; '}
                {row}
              </Text>
            ))}
            {operationType !== 'read' && (
              <Text bold> ({modeCycleShortcut})</Text>
            )}
          </Text>
        ),
        value: 'yes-session',
        option: { type: 'accept-session' },
      })
    }
  }

  // When in input mode, show input field for reject
  if (noInputMode && onRejectFeedbackChange) {
    options.push({
      type: 'input',
      label: 'No',
      value: 'no',
      placeholder: 'and tell Claude what to do differently',
      onChange: onRejectFeedbackChange,
      allowEmptySubmitToCancel: true,
      option: { type: 'reject' },
    })
  } else {
    // Not in input mode - simple option
    options.push({
      label: 'No',
      value: 'no',
      option: { type: 'reject' },
    })
  }

  return options
}
