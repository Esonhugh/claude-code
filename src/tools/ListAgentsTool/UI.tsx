import React from 'react'
import stripAnsi from 'strip-ansi'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Box, Text } from '../../ink.js'
import { formatDuration } from '../../utils/format.js'
import type { LiveSessionInfo } from '../../utils/udsClient.js'

export function AgentList({
  agents,
}: {
  agents: LiveSessionInfo[]
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text>Other Claude sessions ({agents.length}):</Text>
      {agents.length === 0 ? (
        <Text dimColor>No other live local Claude sessions found.</Text>
      ) : (
        agents.map(agent => {
          const age = formatDuration(
            Math.max(0, Date.now() - agent.startedAt),
            {
              mostSignificantOnly: true,
            },
          )
          const row = `[${agent.status ?? 'unknown'}] · ${agent.name} [${agent.ref}] · ${agent.cwd} · started ${age} ago`
          return (
            <Text key={`${agent.pid}:${agent.sessionId}`}>
              {stripAnsi(row).replace(/\p{Cc}/gu, ' ')}
            </Text>
          )
        })
      )}
    </Box>
  )
}

export function AgentListDialog({
  agents,
  onDone,
}: {
  agents: LiveSessionInfo[]
  onDone: () => void
}): React.ReactNode {
  return (
    <Dialog title="Local Claude sessions" onCancel={onDone}>
      <AgentList agents={agents} />
    </Dialog>
  )
}

export function renderToolResultMessage({
  agents,
}: {
  agents: LiveSessionInfo[]
}): React.ReactNode {
  return <AgentList agents={agents} />
}
