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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import {
  createSyntheticAssistantMessage,
  createToolStub,
} from '../remote/remotePermissionBridge.js'
import {
  convertSDKMessage,
  isSessionEndMessage,
} from '../remote/sdkMessageAdapter.js'
import type { SSHSession } from '../ssh/createSSHSession.js'
import type { SSHSessionManager } from '../ssh/SSHSessionManager.js'
import type { RemoteShellCommandResult, Tool } from '../Tool.js'
import { findToolByName } from '../Tool.js'
import type { Message as MessageType } from '../types/message.js'
import type {
  PermissionAskDecision,
  PermissionMode,
  PermissionModeChangeResult,
} from '../types/permissions.js'
import { logForDebugging } from '../utils/debug.js'
import { gracefulShutdown } from '../utils/gracefulShutdown.js'
import type { RemoteMessageContent } from '../utils/teleport/api.js'

type UseSSHSessionResult = {
  isRemoteMode: boolean
  sendMessage: (content: RemoteMessageContent) => Promise<boolean>
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
  setToolUseConfirmQueue: React.Dispatch<React.SetStateAction<ToolUseConfirm[]>>
  tools: Tool[]
}

export function useSSHSession({
  session,
  setMessages,
  setIsLoading,
  setToolUseConfirmQueue,
  tools,
}: UseSSHSessionProps): UseSSHSessionResult {
  const isRemoteMode = !!session

  const managerRef = useRef<SSHSessionManager | null>(null)
  const hasReceivedInitRef = useRef(false)
  const isConnectedRef = useRef(false)
  const permissionModeRevisionRef = useRef(0)
  const permissionModeRef = useRef<PermissionMode | undefined>(undefined)
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>()
  const [permissionModeRevision, setPermissionModeRevision] = useState(0)

  const toolsRef = useRef(tools)
  useEffect(() => {
    toolsRef.current = tools
  }, [tools])

  useEffect(() => {
    if (!session) return

    hasReceivedInitRef.current = false
    permissionModeRevisionRef.current = 0
    permissionModeRef.current = undefined
    setPermissionModeState(undefined)
    setPermissionModeRevision(0)
    logForDebugging('[useSSHSession] wiring SSH session manager')

    const manager = session.createManager({
      onMessage: sdkMessage => {
        if (isSessionEndMessage(sdkMessage)) {
          setIsLoading(false)
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
          setMessages(prev => [...prev, converted.message])
        }
      },
      onPermissionRequest: (request, requestId) => {
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
            setToolUseConfirmQueue(q =>
              q.filter(i => i.toolUseID !== request.tool_use_id),
            )
          },
          async recheckPermission() {},
        }

        setToolUseConfirmQueue(q => [...q, toolUseConfirm])
        setIsLoading(false)
      },
      onPermissionCancelled: (requestId, toolUseId) => {
        logForDebugging(
          `[useSSHSession] permission request cancelled: ${requestId}`,
        )
        if (toolUseId) {
          setToolUseConfirmQueue(queue =>
            queue.filter(item => item.toolUseID !== toolUseId),
          )
        }
        setIsLoading(true)
      },
      onConnected: () => {
        logForDebugging('[useSSHSession] connected')
        isConnectedRef.current = true
      },
      onDisconnected: () => {
        logForDebugging('[useSSHSession] ssh process exited (giving up)')
        const stderr = session.getStderrTail().trim()
        const connected = isConnectedRef.current
        const exitCode = session.proc.exitCode
        isConnectedRef.current = false
        setIsLoading(false)

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
        logForDebugging(`[useSSHSession] error: ${error.message}`)
      },
    })

    managerRef.current = manager
    manager.connect()

    return () => {
      logForDebugging('[useSSHSession] cleanup')
      manager.disconnect()
      session.proxy.stop()
      managerRef.current = null
    }
  }, [session, setMessages, setIsLoading, setToolUseConfirmQueue])

  const sendMessage = useCallback(
    async (content: RemoteMessageContent): Promise<boolean> => {
      const m = managerRef.current
      if (!m) return false
      setIsLoading(true)
      const sent = await m.sendMessage(content)
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
  }, [setIsLoading])

  const disconnect = useCallback(() => {
    managerRef.current?.disconnect()
    managerRef.current = null
    isConnectedRef.current = false
  }, [])

  const getPermissionMode = useCallback(() => permissionModeRef.current, [])

  const getPermissionModeRevision = useCallback(
    () => permissionModeRevisionRef.current,
    [],
  )

  return useMemo(
    () => ({
      isRemoteMode,
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
