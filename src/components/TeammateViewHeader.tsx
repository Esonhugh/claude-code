import * as React from 'react'
import { Box, Text } from '../ink.js'
import { useAppState } from '../state/AppState.js'
import { getViewedAgentTask } from '../state/selectors.js'
import { toInkColor } from '../utils/ink.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { OffscreenFreeze } from './OffscreenFreeze.js'

/**
 * Header shown when viewing an agent transcript.
 * Displays agent name (colored when available), task description, and exit hint.
 */
export function TeammateViewHeader(): React.ReactNode {
  const viewedAgent = useAppState(s => getViewedAgentTask(s))
  const agentNameRegistry = useAppState(s => s.agentNameRegistry)

  if (!viewedAgent) {
    return null
  }

  const agentName =
    viewedAgent.type === 'in_process_teammate'
      ? viewedAgent.identity.agentName
      : [...agentNameRegistry.entries()].find(([, id]) => id === viewedAgent.id)?.[0]
  const displayName = agentName
    ? `@${agentName}`
    : viewedAgent.type === 'local_agent'
      ? viewedAgent.agentType
      : viewedAgent.identity.agentName
  const promptText =
    viewedAgent.type === 'in_process_teammate'
      ? viewedAgent.prompt
      : viewedAgent.description
  const nameColor = toInkColor(
    viewedAgent.type === 'in_process_teammate'
      ? viewedAgent.identity.color
      : undefined,
  )

  return (
    <OffscreenFreeze>
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text>Viewing </Text>
          <Text color={nameColor} bold>
            {displayName}
          </Text>
          <Text dimColor>
            {' · '}
            <KeyboardShortcutHint shortcut="esc" action="return" />
          </Text>
        </Box>
        <Text dimColor>{promptText}</Text>
      </Box>
    </OffscreenFreeze>
  )
}
