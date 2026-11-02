import React, { type ReactNode } from 'react'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { Text } from '../../ink.js'
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js'
import { permissionRuleExtractPrefix } from '../../utils/permissions/shellRuleMatching.js'

function commandListDisplay(commands: string[]): ReactNode {
  switch (commands.length) {
    case 0:
      return ''
    case 1:
      return <Text bold>{commands[0]}</Text>
    case 2:
      return (
        <Text>
          <Text bold>{commands[0]}</Text> and <Text bold>{commands[1]}</Text>
        </Text>
      )
    default:
      return (
        <Text>
          <Text bold>{commands.slice(0, -1).join(', ')}</Text>, and{' '}
          <Text bold>{commands.slice(-1)[0]}</Text>
        </Text>
      )
  }
}

function commandListDisplayTruncated(commands: string[]): ReactNode {
  // Check if the plain text representation would be too long
  const plainText = commands.join(', ')
  if (plainText.length > 50) {
    return 'similar'
  }
  return commandListDisplay(commands)
}

// 2.1.311 (`p3e`) names every path in full: "a", "a and b", "a, b, and c".
function formatPathList(paths: string[]): ReactNode {
  if (paths.length === 0) return ''
  if (paths.length === 1) return <Text bold>{paths[0]}</Text>
  if (paths.length === 2) {
    return (
      <Text>
        <Text bold>{paths[0]}</Text> and <Text bold>{paths[1]}</Text>
      </Text>
    )
  }
  return (
    <Text>
      {paths.slice(0, -1).map((path, i) => (
        <Text key={i}>
          <Text bold>{path}</Text>,{' '}
        </Text>
      ))}
      and <Text bold>{paths.at(-1)}</Text>
    </Text>
  )
}

// Official drops the "always allow" label when its names exceed this width.
const MAX_LABEL_NAMES_LENGTH = 160

/**
 * The updates the "Yes, and apply suggestions" option applies: only the kinds
 * its label describes, so a suggested mode switch (e.g. setMode acceptEdits
 * for a write in the cwd) is not applied behind a directory/rule label.
 */
export function shellSuggestionUpdates(
  suggestions: PermissionUpdate[],
): PermissionUpdate[] {
  return suggestions.filter(
    s => s.type === 'addRules' || s.type === 'addDirectories',
  )
}

/**
 * Generate the label for the "Yes, and apply suggestions" option in shell
 * permission dialogs (Bash, PowerShell). Parametrized by the shell tool name
 * and an optional command transform (e.g., Bash strips output redirections so
 * filenames don't show as commands).
 */
export function generateShellSuggestionsLabel(
  suggestions: PermissionUpdate[],
  shellToolName: string,
  commandTransform?: (command: string) => string,
): ReactNode | null {
  // Collect all rules for display
  const allRules = suggestions
    .filter(s => s.type === 'addRules')
    .flatMap(s => s.rules || [])

  // Separate Read rules from shell rules
  const readRules = allRules.filter(r => r.toolName === 'Read')
  const shellRules = allRules.filter(r => r.toolName === shellToolName)

  // Get directory info
  const directories = suggestions
    .filter(s => s.type === 'addDirectories')
    .flatMap(s => s.directories || [])

  // Extract paths from Read rules (keep separate from directories)
  const readPaths = readRules
    .map(r => r.ruleContent?.replace('/**', '') || '')
    .filter(p => p)

  // Extract shell command prefixes, optionally transforming for display
  const shellCommands = [
    ...new Set(
      shellRules.flatMap(rule => {
        if (!rule.ruleContent) return []
        const command =
          permissionRuleExtractPrefix(rule.ruleContent) ?? rule.ruleContent
        return commandTransform ? commandTransform(command) : command
      }),
    ),
  ]

  if (
    [...shellCommands, ...readPaths, ...directories].join(' and ').length >
    MAX_LABEL_NAMES_LENGTH
  ) {
    return null
  }

  // Check what we have
  const hasDirectories = directories.length > 0
  const hasReadPaths = readPaths.length > 0
  const hasCommands = shellCommands.length > 0

  // Handle single type cases
  if (hasReadPaths && !hasDirectories && !hasCommands) {
    // Only Read rules - use "reading from" language
    return (
      <Text>
        Yes, allow reading from {formatPathList(readPaths)} from this project
      </Text>
    )
  }

  if (hasDirectories && !hasReadPaths && !hasCommands) {
    // Only directory permissions - use "access to" language
    return (
      <Text>
        Yes, and always allow access to {formatPathList(directories)} from this
        project
      </Text>
    )
  }

  if (hasCommands && !hasDirectories && !hasReadPaths) {
    // Only shell command permissions
    return (
      <Text>
        {"Yes, and don't ask again for "}
        {commandListDisplayTruncated(shellCommands)} commands in{' '}
        <Text bold>{getOriginalCwd()}</Text>
      </Text>
    )
  }

  // Handle mixed cases
  if ((hasDirectories || hasReadPaths) && !hasCommands) {
    // Combine directories and read paths since they're both path access
    const allPaths = [...directories, ...readPaths]
    if (hasDirectories && hasReadPaths) {
      // Mixed - use generic "access to"
      return (
        <Text>
          Yes, and always allow access to {formatPathList(allPaths)} from this
          project
        </Text>
      )
    }
  }

  if ((hasDirectories || hasReadPaths) && hasCommands) {
    // Build descriptive message for both types
    const allPaths = [...directories, ...readPaths]

    // Keep it concise but informative
    if (allPaths.length === 1 && shellCommands.length === 1) {
      return (
        <Text>
          Yes, and allow access to {formatPathList(allPaths)} and{' '}
          {commandListDisplayTruncated(shellCommands)} commands
        </Text>
      )
    }

    return (
      <Text>
        Yes, and allow {formatPathList(allPaths)} access and{' '}
        {commandListDisplayTruncated(shellCommands)} commands
      </Text>
    )
  }

  return null
}
