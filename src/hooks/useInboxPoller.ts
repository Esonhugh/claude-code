import { randomUUID } from 'crypto'
import { useCallback, useEffect, useRef } from 'react'
import { useInterval } from 'usehooks-ts'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import { TEAMMATE_MESSAGE_TAG } from '../constants/xml.js'
import { useTerminalNotification } from '../ink/useTerminalNotification.js'
import { sendNotification } from '../services/notifier.js'
import {
  type AppState,
  useAppState,
  useAppStateStore,
  useSetAppState,
} from '../state/AppState.js'
import { findToolByName, type ToolPermissionContext } from '../Tool.js'
import { getAllBaseTools } from '../tools.js'
import type { PermissionMode, PermissionUpdate } from '../types/permissions.js'
import { logForDebugging } from '../utils/debug.js'
import {
  findInProcessTeammateTaskId,
  handlePlanApprovalResponse,
} from '../utils/inProcessTeammateHelpers.js'
import { createAssistantMessage } from '../utils/messages.js'
import { toExternalPermissionMode } from '../utils/permissions/PermissionMode.js'
import { transitionPermissionModeWithGates } from '../utils/permissions/permissionSetup.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { isInsideTmux } from '../utils/swarm/backends/detection.js'
import {
  ensureBackendsRegistered,
  getBackendByType,
} from '../utils/swarm/backends/registry.js'
import type { PaneBackendType } from '../utils/swarm/backends/types.js'
import { TEAM_LEAD_NAME } from '../utils/swarm/constants.js'
import { getLeaderToolUseConfirmQueue } from '../utils/swarm/leaderPermissionBridge.js'
import { sendPermissionResponseViaMailbox } from '../utils/swarm/permissionSync.js'
import { setMemberMode } from '../utils/swarm/teamHelpers.js'
import { handleTeammateShutdownApproved } from '../utils/swarm/teammateShutdown.js'
import {
  getAgentName,
  isPlanModeRequired,
  isTeamLead,
  isTeammate,
} from '../utils/teammate.js'
import { runOutsideTeammateContext } from '../utils/teammateContext.js'
import {
  capIdleResultsInDrain,
  isModeSetRequest,
  isPermissionRequest,
  isPermissionResponse,
  isPlanApprovalRequest,
  isPlanApprovalResponse,
  isSandboxPermissionRequest,
  isSandboxPermissionResponse,
  isShutdownApproved,
  isShutdownRequest,
  isTeamPermissionUpdate,
  markMessagesAsRead,
  readUnreadMessages,
  type TeammateMessage,
  writeToMailbox,
} from '../utils/teammateMailbox.js'
import {
  hasPermissionCallback,
  hasSandboxPermissionCallback,
  processMailboxPermissionResponse,
  processSandboxPermissionResponse,
} from './useSwarmPermissionPoller.js'

/**
 * The teammate's context once the lead approves its plan: the lead's mode (or
 * default), entered through the same gates as any other mode switch. A mode
 * this session cannot enter falls back to default.
 */
export function planApprovedContext(
  current: ToolPermissionContext,
  leaderMode: PermissionMode | undefined,
): ToolPermissionContext {
  const targetMode = toExternalPermissionMode(leaderMode ?? 'default')
  try {
    return transitionPermissionModeWithGates(current, targetMode)
  } catch (error) {
    logForDebugging(
      `[InboxPoller] Plan approval asked for ${targetMode}: ${error instanceof Error ? error.message : String(error)}; using default`,
    )
    return transitionPermissionModeWithGates(current, 'default')
  }
}

/**
 * Get the agent name to poll for messages.
 * - Process-based teammates use their CLAUDE_CODE_AGENT_NAME
 * - Team leads use their name from teamContext.teammates
 * - Standalone sessions return undefined
 *
 * The poller belongs to this process's REPL, never to an in-process teammate
 * (those poll via waitForNextPromptOrShutdown in inProcessRunner.ts). A
 * teammate's setAppState can re-render the REPL synchronously, leaking that
 * teammate's AsyncLocalStorage context into this hook, so it is ignored here.
 */
export function getAgentNameToPoll(appState: AppState): string | undefined {
  return runOutsideTeammateContext(() => {
    if (isTeammate()) {
      return getAgentName()
    }
    // Team lead polls using their agent name (not ID)
    if (isTeamLead(appState.teamContext)) {
      const leadAgentId = appState.teamContext!.leadAgentId
      // Look up the lead's name from teammates map
      const leadName = appState.teamContext!.teammates[leadAgentId]?.name
      return leadName || 'team-lead'
    }
    return undefined
  })
}

const INBOX_POLL_INTERVAL_MS = 1000

type Props = {
  enabled: boolean
  isLoading: boolean
  focusedInputDialog: string | undefined
  // Returns true if submission succeeded, false if rejected (e.g., query already running)
  // Dead code elimination: parameter named onSubmitMessage to avoid "teammate" string in external builds
  onSubmitMessage: (formatted: string) => boolean
}

/**
 * Polls the teammate inbox for new messages and submits them as turns.
 *
 * This hook:
 * 1. Polls every 1s for unread messages (teammates or team leads)
 * 2. When idle: submits messages immediately as a new turn
 * 3. When busy: queues messages in AppState.inbox for UI display, delivers when turn ends
 */
export function useInboxPoller({
  enabled,
  isLoading,
  focusedInputDialog,
  onSubmitMessage,
}: Props): void {
  // Assign to original name for clarity within the function
  const onSubmitTeammateMessage = onSubmitMessage
  const store = useAppStateStore()
  const setAppState = useSetAppState()
  const inboxMessageCount = useAppState(s => s.inbox.messages.length)
  const terminal = useTerminalNotification()

  const poll = useCallback(async () => {
    if (!enabled) return

    // Use ref to avoid dependency on appState object (prevents infinite loop)
    const currentAppState = store.getState()
    const agentName = getAgentNameToPoll(currentAppState)
    if (!agentName) return

    const unread = await readUnreadMessages(
      agentName,
      currentAppState.teamContext?.teamName,
    )

    if (unread.length === 0) return

    logForDebugging(`[InboxPoller] Found ${unread.length} unread message(s)`)

    // Check for plan approval responses and transition out of plan mode if approved
    // Security: Only accept approval responses from the team lead
    if (isTeammate() && isPlanModeRequired()) {
      for (const msg of unread) {
        const approvalResponse = isPlanApprovalResponse(msg.text)
        // Verify the message is from the team lead to prevent teammates from forging approvals
        if (approvalResponse && msg.from === 'team-lead') {
          logForDebugging(
            `[InboxPoller] Received plan approval response from team-lead: approved=${approvalResponse.approved}`,
          )
          if (approvalResponse.approved) {
            const next = planApprovedContext(
              store.getState().toolPermissionContext,
              approvalResponse.permissionMode,
            )
            setAppState(prev => ({ ...prev, toolPermissionContext: next }))
            logForDebugging(
              `[InboxPoller] Plan approved by team lead, exited plan mode to ${next.mode}`,
            )
          } else {
            logForDebugging(
              `[InboxPoller] Plan rejected by team lead: ${approvalResponse.feedback || 'No feedback provided'}`,
            )
          }
        } else if (approvalResponse) {
          logForDebugging(
            `[InboxPoller] Ignoring plan approval response from non-team-lead: ${msg.from}`,
          )
        }
      }
    }

    // Helper to mark messages as read in the inbox file.
    // Called after messages are successfully delivered or reliably queued.
    const markRead = () => {
      void markMessagesAsRead(agentName, currentAppState.teamContext?.teamName, unread)
    }

    // Separate permission messages from regular teammate messages
    const permissionRequests: TeammateMessage[] = []
    const permissionResponses: TeammateMessage[] = []
    const sandboxPermissionRequests: TeammateMessage[] = []
    const sandboxPermissionResponses: TeammateMessage[] = []
    const shutdownRequests: TeammateMessage[] = []
    const shutdownApprovals: TeammateMessage[] = []
    const teamPermissionUpdates: TeammateMessage[] = []
    const modeSetRequests: TeammateMessage[] = []
    const planApprovalRequests: TeammateMessage[] = []
    const regularMessages: TeammateMessage[] = []

    for (const m of unread) {
      const permReq = isPermissionRequest(m.text)
      const permResp = isPermissionResponse(m.text)
      const sandboxReq = isSandboxPermissionRequest(m.text)
      const sandboxResp = isSandboxPermissionResponse(m.text)
      const shutdownReq = isShutdownRequest(m.text)
      const shutdownApproval = isShutdownApproved(m.text)
      const teamPermUpdate = isTeamPermissionUpdate(m.text)
      const modeSetReq = isModeSetRequest(m.text)
      const planApprovalReq = isPlanApprovalRequest(m.text)

      if (permReq) {
        permissionRequests.push(m)
      } else if (permResp) {
        permissionResponses.push(m)
      } else if (sandboxReq) {
        sandboxPermissionRequests.push(m)
      } else if (sandboxResp) {
        sandboxPermissionResponses.push(m)
      } else if (shutdownReq) {
        shutdownRequests.push(m)
      } else if (shutdownApproval) {
        shutdownApprovals.push(m)
      } else if (teamPermUpdate) {
        teamPermissionUpdates.push(m)
      } else if (modeSetReq) {
        modeSetRequests.push(m)
      } else if (planApprovalReq) {
        planApprovalRequests.push(m)
      } else {
        regularMessages.push(m)
      }
    }

    // Handle permission requests (leader side) - route to ToolUseConfirmQueue
    if (
      permissionRequests.length > 0 &&
      isTeamLead(currentAppState.teamContext)
    ) {
      logForDebugging(
        `[InboxPoller] Found ${permissionRequests.length} permission request(s)`,
      )

      const setToolUseConfirmQueue = getLeaderToolUseConfirmQueue()
      const teamName = currentAppState.teamContext?.teamName

      for (const m of permissionRequests) {
        const parsed = isPermissionRequest(m.text)
        if (!parsed) continue

        if (setToolUseConfirmQueue) {
          // Route through the standard ToolUseConfirmQueue so tmux workers
          // get the same tool-specific UI (BashPermissionRequest, FileEditToolDiff, etc.)
          // as in-process teammates.
          const tool = findToolByName(getAllBaseTools(), parsed.tool_name)
          if (!tool) {
            logForDebugging(
              `[InboxPoller] Unknown tool ${parsed.tool_name}, skipping permission request`,
            )
            continue
          }

          const entry: ToolUseConfirm = {
            assistantMessage: createAssistantMessage({ content: '' }),
            tool,
            description: parsed.description,
            input: parsed.input,
            toolUseContext: {} as ToolUseConfirm['toolUseContext'],
            toolUseID: parsed.tool_use_id,
            permissionResult: {
              behavior: 'ask',
              message: parsed.description,
            },
            permissionPromptStartTimeMs: Date.now(),
            workerBadge: {
              name: parsed.agent_id,
              color: 'cyan',
            },
            onUserInteraction() {
              // No-op for tmux workers (no classifier auto-approval)
            },
            onAbort() {
              void sendPermissionResponseViaMailbox(
                parsed.agent_id,
                { decision: 'rejected', resolvedBy: 'leader' },
                parsed.request_id,
                teamName,
              )
            },
            onAllow(
              updatedInput: Record<string, unknown>,
              permissionUpdates: PermissionUpdate[],
            ) {
              void sendPermissionResponseViaMailbox(
                parsed.agent_id,
                {
                  decision: 'approved',
                  resolvedBy: 'leader',
                  updatedInput,
                  permissionUpdates,
                },
                parsed.request_id,
                teamName,
              )
            },
            onReject(feedback?: string) {
              void sendPermissionResponseViaMailbox(
                parsed.agent_id,
                {
                  decision: 'rejected',
                  resolvedBy: 'leader',
                  feedback,
                },
                parsed.request_id,
                teamName,
              )
            },
            async recheckPermission() {
              // No-op for tmux workers — permission state is on the worker side
            },
          }

          // Deduplicate: if markMessagesAsRead failed on a prior poll,
          // the same message will be re-read — skip if already queued.
          setToolUseConfirmQueue(queue => {
            if (queue.some(q => q.toolUseID === parsed.tool_use_id)) {
              return queue
            }
            return [...queue, entry]
          })
        } else {
          logForDebugging(
            `[InboxPoller] ToolUseConfirmQueue unavailable, dropping permission request from ${parsed.agent_id}`,
          )
        }
      }

      // Send desktop notification for the first request
      const firstParsed = isPermissionRequest(permissionRequests[0]?.text ?? '')
      if (firstParsed && !isLoading && !focusedInputDialog) {
        void sendNotification(
          {
            message: `${firstParsed.agent_id} needs permission for ${firstParsed.tool_name}`,
            notificationType: 'worker_permission_prompt',
          },
          terminal,
        )
      }
    }

    // Handle permission responses (worker side) - invoke registered callbacks
    if (permissionResponses.length > 0 && isTeammate()) {
      logForDebugging(
        `[InboxPoller] Found ${permissionResponses.length} permission response(s)`,
      )

      for (const m of permissionResponses) {
        const parsed = isPermissionResponse(m.text)
        if (!parsed) continue

        if (hasPermissionCallback(parsed.request_id)) {
          logForDebugging(
            `[InboxPoller] Processing permission response for ${parsed.request_id}: ${parsed.subtype}`,
          )

          if (parsed.subtype === 'success') {
            processMailboxPermissionResponse({
              requestId: parsed.request_id,
              decision: 'approved',
              updatedInput: parsed.response?.updated_input,
              permissionUpdates: parsed.response?.permission_updates,
            })
          } else {
            processMailboxPermissionResponse({
              requestId: parsed.request_id,
              decision: 'rejected',
              feedback: parsed.error,
            })
          }
        }
      }
    }

    // Handle sandbox permission requests (leader side) - add to workerSandboxPermissions queue
    if (
      sandboxPermissionRequests.length > 0 &&
      isTeamLead(currentAppState.teamContext)
    ) {
      logForDebugging(
        `[InboxPoller] Found ${sandboxPermissionRequests.length} sandbox permission request(s)`,
      )

      const newSandboxRequests: Array<{
        requestId: string
        workerId: string
        workerName: string
        workerColor?: string
        host: string
        createdAt: number
      }> = []

      for (const m of sandboxPermissionRequests) {
        const parsed = isSandboxPermissionRequest(m.text)
        if (!parsed) continue

        // Validate required nested fields to prevent crashes from malformed messages
        if (!parsed.hostPattern?.host) {
          logForDebugging(
            `[InboxPoller] Invalid sandbox permission request: missing hostPattern.host`,
          )
          continue
        }

        newSandboxRequests.push({
          requestId: parsed.requestId,
          workerId: parsed.workerId,
          workerName: parsed.workerName,
          workerColor: parsed.workerColor,
          host: parsed.hostPattern.host,
          createdAt: parsed.createdAt,
        })
      }

      if (newSandboxRequests.length > 0) {
        setAppState(prev => ({
          ...prev,
          workerSandboxPermissions: {
            ...prev.workerSandboxPermissions,
            queue: [
              ...prev.workerSandboxPermissions.queue,
              ...newSandboxRequests,
            ],
          },
        }))

        // Send desktop notification for the first new request
        const firstRequest = newSandboxRequests[0]
        if (firstRequest && !isLoading && !focusedInputDialog) {
          void sendNotification(
            {
              message: `${firstRequest.workerName} needs network access to ${firstRequest.host}`,
              notificationType: 'worker_permission_prompt',
            },
            terminal,
          )
        }
      }
    }

    // Handle sandbox permission responses (worker side) - invoke registered callbacks
    if (sandboxPermissionResponses.length > 0 && isTeammate()) {
      logForDebugging(
        `[InboxPoller] Found ${sandboxPermissionResponses.length} sandbox permission response(s)`,
      )

      for (const m of sandboxPermissionResponses) {
        const parsed = isSandboxPermissionResponse(m.text)
        if (!parsed) continue

        // Check if we have a registered callback for this request
        if (hasSandboxPermissionCallback(parsed.requestId)) {
          logForDebugging(
            `[InboxPoller] Processing sandbox permission response for ${parsed.requestId}: allow=${parsed.allow}`,
          )

          // Process the response using the exported function
          processSandboxPermissionResponse({
            requestId: parsed.requestId,
            host: parsed.host,
            allow: parsed.allow,
          })

          // Clear the pending sandbox request indicator
          setAppState(prev => ({
            ...prev,
            pendingSandboxRequest: null,
          }))
        }
      }
    }

    // Like official 2.1.311, the inbox never changes permissions: anything
    // that can write the mailbox file could forge these as team-lead.
    for (const _ of teamPermissionUpdates) {
      logForDebugging(
        '[InboxPoller] Dropping team_permission_update message: permission rules are never accepted from the inbox',
      )
    }
    for (const _ of modeSetRequests) {
      logForDebugging(
        '[InboxPoller] Dropping mode_set_request message: permission mode changes are never accepted from the inbox',
      )
    }

    // Handle plan approval requests (leader side) - auto-approve and write response to teammate inbox
    if (
      planApprovalRequests.length > 0 &&
      isTeamLead(currentAppState.teamContext)
    ) {
      logForDebugging(
        `[InboxPoller] Found ${planApprovalRequests.length} plan approval request(s), auto-approving`,
      )

      const teamName = currentAppState.teamContext?.teamName
      const leaderExternalMode = toExternalPermissionMode(
        currentAppState.toolPermissionContext.mode,
      )
      const modeToInherit =
        leaderExternalMode === 'plan' ? 'default' : leaderExternalMode

      for (const m of planApprovalRequests) {
        const parsed = isPlanApprovalRequest(m.text)
        if (!parsed) continue

        // Write approval response to teammate's inbox
        const approvalResponse = {
          type: 'plan_approval_response',
          requestId: parsed.requestId,
          approved: true,
          timestamp: new Date().toISOString(),
          permissionMode: modeToInherit,
        }

        void writeToMailbox(
          m.from,
          {
            from: TEAM_LEAD_NAME,
            text: jsonStringify(approvalResponse),
            timestamp: new Date().toISOString(),
          },
          teamName,
        )
        if (teamName) {
          await setMemberMode(teamName, m.from, modeToInherit)
        }

        // Update in-process teammate task state if applicable
        const taskId = findInProcessTeammateTaskId(m.from, currentAppState)
        if (taskId) {
          handlePlanApprovalResponse(
            taskId,
            {
              type: 'plan_approval_response',
              requestId: parsed.requestId,
              approved: true,
              timestamp: new Date().toISOString(),
              permissionMode: modeToInherit,
            },
            setAppState,
          )
        }

        logForDebugging(
          `[InboxPoller] Auto-approved plan from ${m.from} (request ${parsed.requestId})`,
        )

        // Still pass through as a regular message so the model has context
        // about what the teammate is doing, but the approval is already sent
        regularMessages.push(m)
      }
    }

    // Handle shutdown requests (teammate side) - preserve JSON for UI rendering
    if (shutdownRequests.length > 0 && isTeammate()) {
      logForDebugging(
        `[InboxPoller] Found ${shutdownRequests.length} shutdown request(s)`,
      )

      // Pass through shutdown requests - the UI component will render them nicely
      // and the model will receive instructions via the tool prompt documentation
      for (const m of shutdownRequests) {
        regularMessages.push(m)
      }
    }

    // Handle shutdown approvals (leader side) - kill the teammate's pane
    if (
      shutdownApprovals.length > 0 &&
      isTeamLead(currentAppState.teamContext)
    ) {
      logForDebugging(
        `[InboxPoller] Found ${shutdownApprovals.length} shutdown approval(s)`,
      )

      for (const m of shutdownApprovals) {
        const parsed = isShutdownApproved(m.text)
        if (!parsed) continue

        // Kill the pane if we have the info (pane-based teammates)
        if (parsed.paneId && parsed.backendType) {
          void (async () => {
            try {
              // Ensure backend classes are imported (no subprocess probes)
              await ensureBackendsRegistered()
              const insideTmux = await isInsideTmux()
              const backend = getBackendByType(
                parsed.backendType as PaneBackendType,
              )
              const success = await backend?.killPane(
                parsed.paneId!,
                !insideTmux,
              )
              logForDebugging(
                `[InboxPoller] Killed pane ${parsed.paneId} for ${parsed.from}: ${success}`,
              )
            } catch (error) {
              logForDebugging(
                `[InboxPoller] Failed to kill pane for ${parsed.from}: ${error}`,
              )
            }
          })()
        }

        // Remove the teammate from teamContext.teammates so the count is accurate
        const teammateToRemove = parsed.from
        if (teammateToRemove && currentAppState.teamContext?.teammates) {
          // Find the teammate ID by name
          const teammateId = Object.entries(
            currentAppState.teamContext.teammates,
          ).find(([, t]) => t.name === teammateToRemove)?.[0]

          if (teammateId) {
            const { notificationMessage, removed } =
              await handleTeammateShutdownApproved({
                teamName: currentAppState.teamContext?.teamName,
                teammateId,
                teammateName: teammateToRemove,
                setAppState,
              })
            if (removed) {
              setAppState(prev => ({
                ...prev,
                inbox: {
                  messages: [
                    ...prev.inbox.messages,
                    {
                      id: randomUUID(),
                      from: 'system',
                      text: jsonStringify({
                        type: 'teammate_terminated',
                        message: notificationMessage,
                      }),
                      timestamp: new Date().toISOString(),
                      status: 'pending' as const,
                    },
                  ],
                },
              }))
              logForDebugging(
                `[InboxPoller] Removed ${teammateToRemove} (${teammateId}) from teamContext`,
              )
            }
          }
        }

        // Pass through for UI rendering - the component will render it nicely
        regularMessages.push(m)
      }
    }

    // Process regular teammate messages (existing logic)
    if (regularMessages.length === 0) {
      // No regular messages, but we may have processed non-regular messages
      // (permissions, shutdown requests, etc.) above — mark those as read.
      markRead()
      return
    }

    // Format messages with XML wrapper for Claude (include color if available)
    // Transform plan approval requests to include instructions for Claude
    const formatted = capIdleResultsInDrain(regularMessages)
      .map(m => {
        const colorAttr = m.color ? ` color="${m.color}"` : ''
        const summaryAttr = m.summary ? ` summary="${m.summary}"` : ''
        const messageContent = m.text

        return `<${TEAMMATE_MESSAGE_TAG} teammate_id="${m.from}"${colorAttr}${summaryAttr}>\n${messageContent}\n</${TEAMMATE_MESSAGE_TAG}>`
      })
      .join('\n\n')

    // Helper to queue messages in AppState for later delivery
    const queueMessages = () => {
      setAppState(prev => ({
        ...prev,
        inbox: {
          messages: [
            ...prev.inbox.messages,
            ...regularMessages.map(m => ({
              id: randomUUID(),
              from: m.from,
              text: m.text,
              timestamp: m.timestamp,
              status: 'pending' as const,
              color: m.color,
              summary: m.summary,
            })),
          ],
        },
      }))
    }

    if (!isLoading && !focusedInputDialog) {
      // IDLE: Submit as new turn immediately
      logForDebugging(`[InboxPoller] Session idle, submitting immediately`)
      const submitted = onSubmitTeammateMessage(formatted)
      if (!submitted) {
        // Submission rejected (query already running), queue for later
        logForDebugging(
          `[InboxPoller] Submission rejected, queuing for later delivery`,
        )
        queueMessages()
      }
    } else {
      // BUSY: Add to inbox queue for UI display + later delivery
      logForDebugging(`[InboxPoller] Session busy, queuing for later delivery`)
      queueMessages()
    }

    // Mark messages as read only after they have been successfully delivered
    // or reliably queued in AppState. This prevents permanent message loss
    // when the session is busy — if we crash before this point, the messages
    // will be re-read on the next poll cycle instead of being silently dropped.
    markRead()
  }, [
    enabled,
    isLoading,
    focusedInputDialog,
    onSubmitTeammateMessage,
    setAppState,
    terminal,
    store,
  ])

  // When session becomes idle, deliver any pending messages and clean up processed ones
  useEffect(() => {
    if (!enabled) return

    // Skip if busy or in a dialog
    if (isLoading || focusedInputDialog) {
      return
    }

    // Use ref to avoid dependency on appState object (prevents infinite loop)
    const currentAppState = store.getState()
    const agentName = getAgentNameToPoll(currentAppState)
    if (!agentName) return

    const pendingMessages = currentAppState.inbox.messages.filter(
      m => m.status === 'pending',
    )
    const processedMessages = currentAppState.inbox.messages.filter(
      m => m.status === 'processed',
    )

    // Clean up processed messages (they were already delivered mid-turn as attachments)
    if (processedMessages.length > 0) {
      logForDebugging(
        `[InboxPoller] Cleaning up ${processedMessages.length} processed message(s) that were delivered mid-turn`,
      )
      const processedIds = new Set(processedMessages.map(m => m.id))
      setAppState(prev => ({
        ...prev,
        inbox: {
          messages: prev.inbox.messages.filter(m => !processedIds.has(m.id)),
        },
      }))
    }

    // No pending messages to deliver
    if (pendingMessages.length === 0) return

    logForDebugging(
      `[InboxPoller] Session idle, delivering ${pendingMessages.length} pending message(s)`,
    )

    // Format messages with XML wrapper for Claude (include color if available)
    const formatted = capIdleResultsInDrain(pendingMessages)
      .map(m => {
        const colorAttr = m.color ? ` color="${m.color}"` : ''
        const summaryAttr = m.summary ? ` summary="${m.summary}"` : ''
        return `<${TEAMMATE_MESSAGE_TAG} teammate_id="${m.from}"${colorAttr}${summaryAttr}>\n${m.text}\n</${TEAMMATE_MESSAGE_TAG}>`
      })
      .join('\n\n')

    // Try to submit - only clear messages if successful
    const submitted = onSubmitTeammateMessage(formatted)
    if (submitted) {
      // Clear the specific messages we just submitted by their IDs
      const submittedIds = new Set(pendingMessages.map(m => m.id))
      setAppState(prev => ({
        ...prev,
        inbox: {
          messages: prev.inbox.messages.filter(m => !submittedIds.has(m.id)),
        },
      }))
    } else {
      logForDebugging(
        `[InboxPoller] Submission rejected, keeping messages queued`,
      )
    }
  }, [
    enabled,
    isLoading,
    focusedInputDialog,
    onSubmitTeammateMessage,
    setAppState,
    inboxMessageCount,
    store,
  ])

  // Poll if running as a teammate or as a team lead
  const shouldPoll = enabled && !!getAgentNameToPoll(store.getState())
  useInterval(
    () => runOutsideTeammateContext(() => void poll()),
    shouldPoll ? INBOX_POLL_INTERVAL_MS : null,
  )

  // Initial poll on mount (only once)
  const hasDoneInitialPollRef = useRef(false)
  useEffect(() => {
    if (!enabled) return
    if (hasDoneInitialPollRef.current) return
    // Use store.getState() to avoid dependency on appState object
    if (getAgentNameToPoll(store.getState())) {
      hasDoneInitialPollRef.current = true
      runOutsideTeammateContext(() => void poll())
    }
    // Note: poll uses store.getState() (not appState) so it won't re-run on appState changes
    // The ref guard is a safety measure to ensure initial poll only happens once
  }, [enabled, poll, store])
}
