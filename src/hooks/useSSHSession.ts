/**
 * REPL integration hook for `claude ssh` sessions.
 *
 * Sibling to useDirectConnect — same shape (isRemoteMode/sendMessage/
 * cancelRequest/disconnect), same REPL wiring, but drives an SSH child
 * process instead of a WebSocket. Kept separate rather than generalizing
 * useDirectConnect because the lifecycle differs: the ssh process and auth
 * proxy are created BEFORE this hook runs (during startup, in main.tsx) and
 * handed in; useDirectConnect creates its WebSocket inside the effect.
 */

import isEqual from 'lodash-es/isEqual.js'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { applyGoalStatusAttachment } from '../commands/goal/restore.js'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import type { SpinnerMode } from '../components/Spinner/types.js'
import type { RemoteFileSuggestionProvider } from './remoteFileSuggestions.js'
import {
  createSyntheticAssistantMessage,
  createToolStub,
} from '../remote/remotePermissionBridge.js'
import {
  BoundedMessageUuidSet,
  convertSDKHistory,
  convertSDKMessage,
  isSessionEndMessage,
} from '../remote/sdkMessageAdapter.js'
import type { SSHSession } from '../ssh/createSSHSession.js'
import type { SSHSessionManager } from '../ssh/SSHSessionManager.js'
import type { AppState } from '../state/AppStateStore.js'
import type {
  ManagedSSHRemotePermissions,
  RemoteShellCommandResult,
  Tool,
} from '../Tool.js'
import { findToolByName } from '../Tool.js'
import type { Message as MessageType } from '../types/message.js'
import type {
  PermissionAskDecision,
  PermissionMode,
  PermissionModeChangeResult,
} from '../types/permissions.js'
import { logForDebugging } from '../utils/debug.js'
import {
  gracefulShutdown,
  isShuttingDown,
  registerSSHResumeHintContext,
} from '../utils/gracefulShutdown.js'
import {
  handleMessageFromStream,
  type StreamingToolUse,
} from '../utils/messages.js'
import type { RemoteMessageContent } from '../utils/teleport/api.js'

type UseSSHSessionResult = {
  isRemoteMode: boolean
  isReady: boolean
  remoteSessionId: string | null
  remoteFileSuggestionProvider?: RemoteFileSuggestionProvider
  managedSSHRemotePermissions?: ManagedSSHRemotePermissions
  sendMessage: (
    content: RemoteMessageContent,
    options: { uuid: string },
  ) => Promise<boolean>
  setPermissionMode: (
    mode: PermissionMode,
  ) => Promise<PermissionModeChangeResult>
  runShellCommand: (
    command: string,
    signal: AbortSignal,
  ) => Promise<RemoteShellCommandResult>
  cancelRequest: () => void
  disconnect: () => void
  permissionMode: PermissionMode | undefined
  permissionModeRevision: number
  getPermissionMode: () => PermissionMode | undefined
  getPermissionModeRevision: () => number
}

type UseSSHSessionProps = {
  session: SSHSession | undefined
  setMessages: React.Dispatch<React.SetStateAction<MessageType[]>>
  setIsLoading: (loading: boolean) => void
  setAppState?: React.Dispatch<React.SetStateAction<AppState>>
  setToolUseConfirmQueue: React.Dispatch<React.SetStateAction<ToolUseConfirm[]>>
  tools: Tool[]
  setStreamingToolUses?: React.Dispatch<
    React.SetStateAction<StreamingToolUse[]>
  >
  setStreamMode?: React.Dispatch<React.SetStateAction<SpinnerMode>>
  setInProgressToolUseIDs?: (f: (prev: Set<string>) => Set<string>) => void
  setResponseLength?: (f: (prev: number) => number) => void
  onStreamingText?: (f: (current: string | null) => string | null) => void
}

export function useSSHSession({
  session,
  setMessages,
  setIsLoading,
  setAppState,
  setToolUseConfirmQueue,
  tools,
  setStreamingToolUses,
  setStreamMode,
  setInProgressToolUseIDs,
  setResponseLength,
  onStreamingText,
}: UseSSHSessionProps): UseSSHSessionResult {
  const isRemoteMode = !!session

  const managerRef = useRef<SSHSessionManager | null>(null)
  const permissionToolUseIdsRef = useRef(new Set<string>())
  const remoteTasksRef = useRef<AppState['remoteTasks']>({})
  const hasReceivedInitRef = useRef(false)
  const isConnectedRef = useRef(false)
  const isReadyRef = useRef(false)
  const messageUuidCacheRef = useRef(new BoundedMessageUuidSet())
  const clearResumeHintRef = useRef<(() => void) | null>(null)
  const permissionModeRevisionRef = useRef(0)
  const permissionModeRef = useRef<PermissionMode | undefined>(undefined)
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>()
  const [permissionModeRevision, setPermissionModeRevision] = useState(0)
  const [isReady, setIsReady] = useState(false)
  const [remoteSessionId, setRemoteSessionId] = useState<string | null>(null)

  const toolsRef = useRef(tools)
  useEffect(() => {
    toolsRef.current = tools
  }, [tools])

  const updateRemoteTasks = useCallback(
    (update: (tasks: AppState['remoteTasks']) => AppState['remoteTasks']) => {
      const remoteTasks = update(remoteTasksRef.current)
      if (remoteTasks === remoteTasksRef.current) return
      remoteTasksRef.current = remoteTasks
      setAppState?.(prev => ({
        ...prev,
        remoteTasks,
        remoteBackgroundTaskCount: Object.keys(remoteTasks).length,
      }))
    },
    [setAppState],
  )

  const clearToolRuntimeState = useCallback(() => {
    setStreamingToolUses?.(prev => (prev.length > 0 ? [] : prev))
    setInProgressToolUseIDs?.(prev => (prev.size > 0 ? new Set() : prev))
    onStreamingText?.(() => null)
  }, [onStreamingText, setInProgressToolUseIDs, setStreamingToolUses])

  const clearPermissionRequests = useCallback(() => {
    if (permissionToolUseIdsRef.current.size === 0) return
    const ids = permissionToolUseIdsRef.current
    permissionToolUseIdsRef.current = new Set()
    setToolUseConfirmQueue(queue =>
      queue.filter(item => !ids.has(item.toolUseID)),
    )
  }, [setToolUseConfirmQueue])

  const clearRemoteRuntimeState = useCallback(() => {
    updateRemoteTasks(tasks =>
      Object.keys(tasks).length === 0 ? tasks : {},
    )
    clearToolRuntimeState()
  }, [clearToolRuntimeState, updateRemoteTasks])

  useEffect(() => {
    if (!session) {
      isReadyRef.current = false
      setIsReady(false)
      setRemoteSessionId(null)
      return
    }

    hasReceivedInitRef.current = false
    isReadyRef.current = false
    messageUuidCacheRef.current.clear()
    clearResumeHintRef.current?.()
    clearResumeHintRef.current = null
    setIsReady(false)
    setRemoteSessionId(null)
    permissionModeRevisionRef.current = 0
    permissionModeRef.current = undefined
    setPermissionModeState(undefined)
    setPermissionModeRevision(0)
    logForDebugging('[useSSHSession] wiring SSH session manager')

    let active = true
    const manager = session.createManager({
      onBootstrap: bootstrap => {
        if (!active) return
        if (setAppState) {
          const lastGoalMessage = bootstrap.history.findLast(
            historyMessage =>
              historyMessage.type === 'system' &&
              historyMessage.subtype === 'goal_state_changed',
          )
          if (lastGoalMessage) {
            applyGoalStatusAttachment(lastGoalMessage.goal, setAppState, Date.now, {
              hydrateTerminal: true,
            })
          } else {
            setAppState(prev =>
              prev.goalStatus.active
                ? { ...prev, goalStatus: { active: false } }
                : prev,
            )
          }
        }
        const convertedHistory = convertSDKHistory(bootstrap.history)
        for (const message of convertedHistory) {
          messageUuidCacheRef.current.remember(message.uuid)
        }
        setMessages(previousMessages => {
          const existingUuids = new Set(
            previousMessages.map(message => message.uuid),
          )
          const uniqueHistory = convertedHistory.filter(
            message => !existingUuids.has(message.uuid),
          )
          return uniqueHistory.length === 0
            ? previousMessages
            : [...previousMessages, ...uniqueHistory]
        })

        const target = session.target
        if (target && session.remoteCwd) {
          try {
            clearResumeHintRef.current?.()
            clearResumeHintRef.current = registerSSHResumeHintContext({
              target,
              remoteCwd: session.remoteCwd,
              remoteSessionId: bootstrap.sessionId,
            })
          } catch (error) {
            logForDebugging(
              `[useSSHSession] invalid SSH resume context: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }

        isReadyRef.current = true
        setRemoteSessionId(bootstrap.sessionId)
        setIsReady(true)
      },
      onMessage: sdkMessage => {
        if (!active) return
        if (isSessionEndMessage(sdkMessage)) {
          setIsLoading(false)
          clearPermissionRequests()
          clearToolRuntimeState()
        }

        if (sdkMessage.type === 'system') {
          if (sdkMessage.subtype === 'task_started') {
            updateRemoteTasks(tasks => {
              const current = tasks[sdkMessage.task_id]
              if (
                current &&
                current.toolUseId === sdkMessage.tool_use_id &&
                current.taskType === sdkMessage.task_type &&
                current.description === sdkMessage.description &&
                current.workflowName === sdkMessage.workflow_name &&
                current.prompt === sdkMessage.prompt
              ) {
                return tasks
              }
              return {
                ...tasks,
                [sdkMessage.task_id]: {
                  taskId: sdkMessage.task_id,
                  toolUseId: sdkMessage.tool_use_id,
                  taskType: sdkMessage.task_type,
                  description: sdkMessage.description,
                  workflowName: sdkMessage.workflow_name,
                  prompt: sdkMessage.prompt,
                },
              }
            })
            return
          }
          if (sdkMessage.subtype === 'task_notification') {
            updateRemoteTasks(tasks => {
              if (!tasks[sdkMessage.task_id]) return tasks
              const next = { ...tasks }
              delete next[sdkMessage.task_id]
              return next
            })
            return
          }
          if (sdkMessage.subtype === 'task_progress') {
            updateRemoteTasks(tasks => {
              const current = tasks[sdkMessage.task_id]
              if (!current) return tasks
              const next = {
                ...current,
                description: sdkMessage.description,
                usage: {
                  totalTokens: sdkMessage.usage.total_tokens,
                  toolUses: sdkMessage.usage.tool_uses,
                  durationMs: sdkMessage.usage.duration_ms,
                },
                lastToolName: sdkMessage.last_tool_name,
                summary: sdkMessage.summary,
                workflowProgress: sdkMessage.workflow_progress,
              }
              return isEqual(current, next)
                ? tasks
                : { ...tasks, [sdkMessage.task_id]: next }
            })
            return
          }
          if (sdkMessage.subtype === 'goal_state_changed') {
            if (setAppState) {
              applyGoalStatusAttachment(sdkMessage.goal, setAppState)
            }
            return
          }
        }

        if (setInProgressToolUseIDs && sdkMessage.type === 'user') {
          const content = (sdkMessage.message as { content?: unknown })?.content
          if (Array.isArray(content)) {
            const resultIds = content
              .filter(
                (block): block is { type: 'tool_result'; tool_use_id: string } =>
                  typeof block === 'object' &&
                  block !== null &&
                  'type' in block &&
                  block.type === 'tool_result' &&
                  'tool_use_id' in block &&
                  typeof block.tool_use_id === 'string',
              )
              .map(block => block.tool_use_id)
            if (resultIds.length > 0) {
              setInProgressToolUseIDs(prev => {
                const next = new Set(prev)
                for (const id of resultIds) next.delete(id)
                return next.size === prev.size ? prev : next
              })
            }
          }
        }

        if (
          sdkMessage.type === 'system' &&
          (sdkMessage.subtype === 'init' || sdkMessage.subtype === 'status') &&
          sdkMessage.permissionMode
        ) {
          permissionModeRevisionRef.current++
          permissionModeRef.current = sdkMessage.permissionMode
          setPermissionModeState(sdkMessage.permissionMode)
          setPermissionModeRevision(permissionModeRevisionRef.current)
        }

        // Skip duplicate init messages (one per turn from stream-json mode).
        if (sdkMessage.type === 'system' && sdkMessage.subtype === 'init') {
          if (hasReceivedInitRef.current) return
          hasReceivedInitRef.current = true
        }

        const converted = convertSDKMessage(sdkMessage, {
          convertToolResults: true,
        })
        if (converted.type === 'message') {
          setStreamingToolUses?.(prev => (prev.length > 0 ? [] : prev))
          onStreamingText?.(() => null)

          if (
            setInProgressToolUseIDs &&
            converted.message.type === 'assistant'
          ) {
            const toolUseIds = converted.message.message.content
              .filter(block => block.type === 'tool_use')
              .map(block => block.id)
            if (toolUseIds.length > 0) {
              setInProgressToolUseIDs(prev => {
                const next = new Set(prev)
                for (const id of toolUseIds) next.add(id)
                return next.size === prev.size ? prev : next
              })
            }
          }

          if (messageUuidCacheRef.current.remember(converted.message.uuid)) {
            setMessages(prev =>
              prev.some(message => message.uuid === converted.message.uuid)
                ? prev
                : [...prev, converted.message],
            )
          }
        } else if (converted.type === 'stream_event') {
          if (setStreamingToolUses && setStreamMode) {
            handleMessageFromStream(
              converted.event,
              message => setMessages(prev => [...prev, message]),
              newContent =>
                setResponseLength?.(length => length + newContent.length),
              setStreamMode,
              setStreamingToolUses,
              undefined,
              undefined,
              undefined,
              onStreamingText,
            )
          }
        }
      },
      onPermissionRequest: (request, requestId) => {
        if (!active) return
        logForDebugging(
          `[useSSHSession] permission request: ${request.tool_name}`,
        )

        const tool =
          findToolByName(toolsRef.current, request.tool_name) ??
          createToolStub(request.tool_name)

        const syntheticMessage = createSyntheticAssistantMessage(
          request,
          requestId,
        )

        const permissionResult: PermissionAskDecision = {
          behavior: 'ask',
          message:
            request.description ?? `${request.tool_name} requires permission`,
          suggestions: request.permission_suggestions,
          blockedPath: request.blocked_path,
        }

        const toolUseConfirm: ToolUseConfirm = {
          assistantMessage: syntheticMessage,
          tool,
          description:
            request.description ?? `${request.tool_name} requires permission`,
          input: request.input,
          toolUseContext: {} as ToolUseConfirm['toolUseContext'],
          toolUseID: request.tool_use_id,
          permissionResult,
          permissionPromptStartTimeMs: Date.now(),
          onUserInteraction() {},
          onAbort() {
            manager.respondToPermissionRequest(requestId, {
              behavior: 'deny',
              message: 'User aborted',
            })
            permissionToolUseIdsRef.current.delete(request.tool_use_id)
            setToolUseConfirmQueue(q =>
              q.filter(i => i.toolUseID !== request.tool_use_id),
            )
          },
          onAllow(updatedInput, permissionUpdates) {
            manager.respondToPermissionRequest(requestId, {
              behavior: 'allow',
              updatedInput,
              ...(permissionUpdates.length > 0
                ? { updatedPermissions: permissionUpdates }
                : {}),
            })
            permissionToolUseIdsRef.current.delete(request.tool_use_id)
            setToolUseConfirmQueue(q =>
              q.filter(i => i.toolUseID !== request.tool_use_id),
            )
            setIsLoading(true)
          },
          onReject(feedback) {
            manager.respondToPermissionRequest(requestId, {
              behavior: 'deny',
              message: feedback ?? 'User denied permission',
            })
            permissionToolUseIdsRef.current.delete(request.tool_use_id)
            setToolUseConfirmQueue(q =>
              q.filter(i => i.toolUseID !== request.tool_use_id),
            )
          },
          async recheckPermission() {},
        }

        permissionToolUseIdsRef.current.add(request.tool_use_id)
        setToolUseConfirmQueue(q => [...q, toolUseConfirm])
        setIsLoading(false)
      },
      onPermissionCancelled: (requestId, toolUseId) => {
        if (!active) return
        logForDebugging(
          `[useSSHSession] permission request cancelled: ${requestId}`,
        )
        if (toolUseId) {
          permissionToolUseIdsRef.current.delete(toolUseId)
          setToolUseConfirmQueue(queue =>
            queue.filter(item => item.toolUseID !== toolUseId),
          )
        }
        setIsLoading(true)
      },
      onConnected: () => {
        if (!active) return
        logForDebugging('[useSSHSession] connected')
        isConnectedRef.current = true
      },
      onDisconnected: () => {
        if (!active) return
        logForDebugging('[useSSHSession] ssh process exited (giving up)')
        const stderr = session.getStderrTail().trim()
        const connected = isConnectedRef.current
        const exitCode = session.proc.exitCode
        isConnectedRef.current = false
        isReadyRef.current = false
        setIsReady(false)
        setIsLoading(false)
        setRemoteSessionId(null)
        clearPermissionRequests()
        clearRemoteRuntimeState()

        let msg = connected
          ? 'Remote session ended.'
          : 'SSH session failed before connecting.'
        // Surface remote stderr if it looks like an error (pre-connect always,
        // post-connect only on nonzero exit — normal --verbose noise otherwise).
        if (stderr && (!connected || exitCode !== 0)) {
          msg += `\nRemote stderr (exit ${exitCode ?? 'signal ' + session.proc.signalCode}):\n${stderr}`
        }
        void gracefulShutdown(1, 'other', { finalMessage: msg })
      },
      onError: error => {
        if (!active) return
        logForDebugging(`[useSSHSession] error: ${error.message}`)
      },
    })

    managerRef.current = manager
    manager.connect()

    return () => {
      logForDebugging('[useSSHSession] cleanup')
      active = false
      manager.disconnect()
      session.proxy.stop()
      clearPermissionRequests()
      clearRemoteRuntimeState()
      managerRef.current = null
      isReadyRef.current = false
      if (!isShuttingDown()) {
        clearResumeHintRef.current?.()
        clearResumeHintRef.current = null
      }
    }
  }, [
    session,
    setMessages,
    setIsLoading,
    setToolUseConfirmQueue,
    setStreamingToolUses,
    setStreamMode,
    setInProgressToolUseIDs,
    setResponseLength,
    onStreamingText,
    clearToolRuntimeState,
    clearPermissionRequests,
    clearRemoteRuntimeState,
    updateRemoteTasks,
  ])

  const sendMessage = useCallback(
    async (
      content: RemoteMessageContent,
      options: { uuid: string },
    ): Promise<boolean> => {
      const m = managerRef.current
      if (!m || !isReadyRef.current) return false
      messageUuidCacheRef.current.remember(options.uuid)
      setIsLoading(true)
      const sent = await m.sendMessage(content, options)
      if (!sent) setIsLoading(false)
      return sent
    },
    [setIsLoading],
  )

  const setPermissionMode = useCallback(
    (mode: PermissionMode): Promise<PermissionModeChangeResult> => {
      return (
        managerRef.current?.setPermissionMode(mode) ??
        Promise.resolve({ success: false, error: 'SSH session is not connected' })
      )
    },
    [],
  )

  const runShellCommand = useCallback(
    (
      command: string,
      signal: AbortSignal,
    ): Promise<RemoteShellCommandResult> => {
      const manager = managerRef.current
      if (!manager) {
        return Promise.reject(new Error('SSH session is not connected'))
      }
      return manager.runShellCommand(command, signal)
    },
    [],
  )

  const cancelRequest = useCallback(() => {
    managerRef.current?.sendInterrupt()
    setIsLoading(false)
    clearToolRuntimeState()
  }, [clearToolRuntimeState, setIsLoading])

  const disconnect = useCallback(() => {
    managerRef.current?.disconnect()
    session?.proxy.stop()
    managerRef.current = null
    isConnectedRef.current = false
    isReadyRef.current = false
    setIsReady(false)
    setIsLoading(false)
    setRemoteSessionId(null)
    clearPermissionRequests()
    clearRemoteRuntimeState()
  }, [
    clearPermissionRequests,
    clearRemoteRuntimeState,
    session,
    setIsLoading,
  ])

  const getPermissionMode = useCallback(() => permissionModeRef.current, [])

  const getPermissionModeRevision = useCallback(
    () => permissionModeRevisionRef.current,
    [],
  )

  const remoteFileSuggestionProvider = useMemo<
    RemoteFileSuggestionProvider | undefined
  >(() => {
    if (!session || !isReady) return undefined
    return (request, signal) => {
      const manager = managerRef.current
      if (!manager) {
        return Promise.reject(new Error('SSH session is not connected'))
      }
      return manager.getFileSuggestions(request, signal)
    }
  }, [session, isReady])

  const managedSSHRemotePermissions = useMemo<
    ManagedSSHRemotePermissions | undefined
  >(() => {
    if (!session || !isReady) return undefined
    return {
      async getDirectorySuggestions(query, signal) {
        const manager = managerRef.current
        if (!manager) {
          return Promise.reject(new Error('SSH session is not connected'))
        }
        const response = await manager.getFileSuggestions(
          { query, mode: 'path', limit: 10 },
          signal,
        )
        return response.items.filter(item => item.kind === 'directory')
      },
      getPermissions() {
        const manager = managerRef.current
        if (!manager) {
          return Promise.reject(new Error('SSH session is not connected'))
        }
        return manager.getPermissions()
      },
      updatePermissions(update) {
        const manager = managerRef.current
        if (!manager) {
          return Promise.reject(new Error('SSH session is not connected'))
        }
        return manager.updatePermissions(update)
      },
    }
  }, [session, isReady])

  return useMemo(
    () => ({
      isRemoteMode,
      isReady,
      remoteSessionId,
      remoteFileSuggestionProvider,
      managedSSHRemotePermissions,
      sendMessage,
      setPermissionMode,
      runShellCommand,
      cancelRequest,
      disconnect,
      permissionMode,
      permissionModeRevision,
      getPermissionMode,
      getPermissionModeRevision,
    }),
    [
      isRemoteMode,
      isReady,
      remoteSessionId,
      remoteFileSuggestionProvider,
      managedSSHRemotePermissions,
      sendMessage,
      setPermissionMode,
      runShellCommand,
      cancelRequest,
      disconnect,
      permissionMode,
      permissionModeRevision,
      getPermissionMode,
      getPermissionModeRevision,
    ],
  )
}
