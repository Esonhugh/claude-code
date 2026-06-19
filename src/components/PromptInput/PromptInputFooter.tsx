import { feature } from 'bun:bundle'
import * as React from 'react'
import { memo, type ReactNode, useMemo, useRef } from 'react'
import { useSetPromptOverlay } from '../../context/promptOverlayContext.js'
import type { VerificationStatus } from '../../hooks/useApiKeyVerification.js'
import type { IDESelection } from '../../hooks/useIdeSelection.js'
import { useSettings } from '../../hooks/useSettings.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box } from '../../ink.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import { useAppState } from '../../state/AppState.js'
import type { ToolPermissionContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import type { PromptInputMode, VimMode } from '../../types/textInputTypes.js'
import type { AutoUpdaterResult } from '../../utils/autoUpdater.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import {
  CoordinatorTaskPanel,
  useCoordinatorTaskCount,
} from '../CoordinatorAgentStatus.js'
import {
  getLastAssistantMessageId,
  StatusLine,
  statusLineShouldDisplay,
} from '../StatusLine.js'
import { PromptInputFooterLeftSide } from './PromptInputFooterLeftSide.js'
import {
  PromptInputFooterSuggestions,
  type SuggestionItem,
} from './PromptInputFooterSuggestions.js'
import { PromptInputHelpMenu } from './PromptInputHelpMenu.js'
import { PromptInputFooterRightSide } from './PromptInputFooterRightSide.js'


type Props = {
  apiKeyStatus: VerificationStatus
  debug: boolean
  exitMessage: {
    show: boolean
    key?: string
  }
  vimMode: VimMode | undefined
  mode: PromptInputMode
  autoUpdaterResult: AutoUpdaterResult | null
  isAutoUpdating: boolean
  verbose: boolean
  onAutoUpdaterResult: (result: AutoUpdaterResult) => void
  onChangeIsUpdating: (isUpdating: boolean) => void
  suggestions: SuggestionItem[]
  selectedSuggestion: number
  maxColumnWidth?: number
  toolPermissionContext: ToolPermissionContext
  helpOpen: boolean
  suppressHint: boolean
  isLoading: boolean
  tasksSelected: boolean
  teamsSelected: boolean
  bridgeSelected: boolean
  tmuxSelected: boolean
  teammateFooterIndex?: number
  ideSelection: IDESelection | undefined
  mcpClients?: MCPServerConnection[]
  isPasting?: boolean
  isInputWrapped?: boolean
  messages: Message[]
  isSearching: boolean
  historyQuery: string
  setHistoryQuery: (query: string) => void
  historyFailedMatch: boolean
  onOpenTasksDialog?: (taskId?: string) => void
  isLocalJSXCommandActive?: boolean
}

function PromptInputFooter({
  apiKeyStatus,
  debug,
  exitMessage,
  vimMode,
  mode,
  autoUpdaterResult,
  isAutoUpdating,
  verbose,
  onAutoUpdaterResult,
  onChangeIsUpdating,
  suggestions,
  selectedSuggestion,
  maxColumnWidth,
  toolPermissionContext,
  helpOpen,
  suppressHint: suppressHintFromProps,
  isLoading,
  tasksSelected,
  teamsSelected,
  bridgeSelected,
  tmuxSelected,
  teammateFooterIndex,
  ideSelection,
  mcpClients,
  isPasting = false,
  isInputWrapped = false,
  messages,
  isSearching,
  historyQuery,
  setHistoryQuery,
  historyFailedMatch,
  onOpenTasksDialog,
  isLocalJSXCommandActive = false,
}: Props): ReactNode {
  const settings = useSettings()
  const { columns, rows } = useTerminalSize()
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const lastAssistantMessageId = useMemo(
    () => getLastAssistantMessageId(messages),
    [messages],
  )
  const isNarrow = columns < 80
  // In fullscreen the bottom slot is flexShrink:0, so every row here is a row
  // stolen from the ScrollBox. Drop the optional StatusLine first. Non-fullscreen
  // has terminal scrollback to absorb overflow, so we never hide StatusLine there.
  const isFullscreen = isFullscreenEnvEnabled()
  const isShort = isFullscreen && rows < 24

  // Pill highlights when tasks is the active footer item AND no specific
  // agent row is selected. When coordinatorTaskIndex >= 0 the pointer has
  // moved into CoordinatorTaskPanel, so the pill should un-highlight.
  // coordinatorTaskCount === 0 covers the bash-only case (no agent rows
  // exist, pill is the only selectable item).
  const coordinatorTaskCount = useCoordinatorTaskCount()
  const coordinatorTaskIndex = useAppState(s => s.coordinatorTaskIndex)
  const pillSelected =
    tasksSelected && (coordinatorTaskCount === 0 || coordinatorTaskIndex < 0)

  // Hide `? for shortcuts` if the user has a custom status line, or during ctrl-r
  const suppressHint =
    suppressHintFromProps || statusLineShouldDisplay(settings) || isSearching
  // Fullscreen: portal data to FullscreenLayout — see promptOverlayContext.tsx
  const overlayData = useMemo(
    () =>
      isFullscreen && suggestions.length
        ? { suggestions, selectedSuggestion, maxColumnWidth }
        : null,
    [isFullscreen, suggestions, selectedSuggestion, maxColumnWidth],
  )
  useSetPromptOverlay(overlayData)

  if (suggestions.length && !isFullscreen) {
    return (
      <Box paddingX={2} paddingY={0}>
        <PromptInputFooterSuggestions
          suggestions={suggestions}
          selectedSuggestion={selectedSuggestion}
          maxColumnWidth={maxColumnWidth}
        />
      </Box>
    )
  }

  if (helpOpen) {
    return (
      <PromptInputHelpMenu dimColor={true} fixedWidth={true} paddingX={2} />
    )
  }

  return (
    <>
      <Box
        flexDirection={isNarrow ? 'column' : 'row'}
        justifyContent={isNarrow ? 'flex-start' : 'space-between'}
        paddingX={2}
        gap={isNarrow ? 0 : 1}
      >
        <Box flexDirection="column" flexShrink={isNarrow ? 0 : 1}>
          {mode === 'prompt' &&
            !isShort &&
            !exitMessage.show &&
            !isPasting &&
            statusLineShouldDisplay(settings) && (
              <StatusLine
                messagesRef={messagesRef}
                lastAssistantMessageId={lastAssistantMessageId}
                vimMode={vimMode}
              />
            )}
          <PromptInputFooterLeftSide
            exitMessage={exitMessage}
            vimMode={vimMode}
            mode={mode}
            toolPermissionContext={toolPermissionContext}
            suppressHint={suppressHint}
            isLoading={isLoading}
            tasksSelected={pillSelected}
            teamsSelected={teamsSelected}
            teammateFooterIndex={teammateFooterIndex}
            tmuxSelected={tmuxSelected}
            isPasting={isPasting}
            isSearching={isSearching}
            historyQuery={historyQuery}
            setHistoryQuery={setHistoryQuery}
            historyFailedMatch={historyFailedMatch}
            onOpenTasksDialog={onOpenTasksDialog}
          />
        </Box>
        <PromptInputFooterRightSide
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
          isFullscreen={isFullscreen}
          bridgeSelected={bridgeSelected}
        />
      </Box>
      {!isLocalJSXCommandActive && (
        <CoordinatorTaskPanel onOpenTasksDialog={onOpenTasksDialog} />
      )}
    </>
  )
}

export default memo(PromptInputFooter)
