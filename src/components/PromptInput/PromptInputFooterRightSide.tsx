import { feature } from 'bun:bundle'
import * as React from 'react'
import { isBridgeEnabled } from '../../bridge/bridgeEnabled.js'
import { getBridgeStatus } from '../../bridge/bridgeStatusUtil.js'
import type { IDESelection } from '../../hooks/useIdeSelection.js'
import { Box, Text } from '../../ink.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import { useAppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import type { AutoUpdaterResult } from '../../utils/autoUpdater.js'
import { isUndercover } from '../../utils/undercover.js'
import { isAnt } from 'src/utils/userType.js'
import type { VerificationStatus } from '../../hooks/useApiKeyVerification.js'
import { GoalStatusIndicator } from './goalStatusIndicator.js'
import { Notifications } from './Notifications.js'

type Props = {
  apiKeyStatus: VerificationStatus
  autoUpdaterResult: AutoUpdaterResult | null
  debug: boolean
  isAutoUpdating: boolean
  verbose: boolean
  messages: Message[]
  onAutoUpdaterResult: (result: AutoUpdaterResult) => void
  onChangeIsUpdating: (isUpdating: boolean) => void
  ideSelection: IDESelection | undefined
  mcpClients?: MCPServerConnection[]
  isInputWrapped?: boolean
  isNarrow: boolean
  isFullscreen: boolean
  bridgeSelected: boolean
}

export function PromptInputFooterRightSide({
  apiKeyStatus,
  autoUpdaterResult,
  debug,
  isAutoUpdating,
  verbose,
  messages,
  onAutoUpdaterResult,
  onChangeIsUpdating,
  ideSelection,
  mcpClients,
  isInputWrapped,
  isNarrow,
  isFullscreen,
  bridgeSelected,
}: Props): React.ReactNode {
  const goalActive = useAppState(s => s.goalStatus.active)
  return (
    <Box flexShrink={1} gap={1}>
      {isFullscreen ? null : (
        <Notifications
          apiKeyStatus={apiKeyStatus}
          autoUpdaterResult={autoUpdaterResult}
          debug={debug}
          isAutoUpdating={isAutoUpdating}
          verbose={verbose}
          messages={messages}
          onAutoUpdaterResult={onAutoUpdaterResult}
          onChangeIsUpdating={onChangeIsUpdating}
          ideSelection={ideSelection}
          mcpClients={mcpClients}
          isInputWrapped={isInputWrapped}
          isNarrow={isNarrow}
        />
      )}
      {goalActive && <Text dimColor>·</Text>}
      <GoalStatusIndicator active={goalActive} />
      {isAnt() && isUndercover() && <Text dimColor>undercover</Text>}
      <BridgeStatusIndicator bridgeSelected={bridgeSelected} />
    </Box>
  )
}

type BridgeStatusProps = {
  bridgeSelected: boolean
}

function BridgeStatusIndicator({
  bridgeSelected,
}: BridgeStatusProps): React.ReactNode {
  if (!feature('BRIDGE_MODE')) return null

  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  const enabled = useAppState(s => s.replBridgeEnabled)
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  const connected = useAppState(s => s.replBridgeConnected)
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  const sessionActive = useAppState(s => s.replBridgeSessionActive)
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  const reconnecting = useAppState(s => s.replBridgeReconnecting)
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  const explicit = useAppState(s => s.replBridgeExplicit)

  // Failed state is surfaced via notification (useReplBridge), not a footer pill.
  if (!isBridgeEnabled() || !enabled) return null

  const status = getBridgeStatus({
    error: undefined,
    connected,
    sessionActive,
    reconnecting,
  })

  // For implicit (config-driven) remote, only show the reconnecting state
  if (!explicit && status.label !== 'Remote Control reconnecting') {
    return null
  }

  return (
    <Text
      color={bridgeSelected ? 'background' : status.color}
      inverse={bridgeSelected}
      wrap="truncate"
    >
      {status.label}
      {bridgeSelected && <Text dimColor> · Enter to view</Text>}
    </Text>
  )
}
