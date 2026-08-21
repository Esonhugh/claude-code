import { randomUUID } from 'crypto'
import type { ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type {
  SDKControlPermissionRequest,
  SDKControlRunShellCommandResponse,
  SDKControlSSHPermissionUpdate,
  SDKControlSSHPermissionsResponse,
  SDKControlSSHFileSuggestionsResponse,
  SSHFileSuggestionItem,
  StdoutMessage,
} from '../entrypoints/sdk/controlTypes.js'
import type { RemotePermissionResponse } from '../remote/RemoteSessionManager.js'
import type { RemoteShellCommandResult } from '../Tool.js'
import { logForDebugging } from '../utils/debug.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import type { RemoteMessageContent } from '../utils/teleport/api.js'
import type {
  PermissionMode,
  PermissionModeChangeResult,
} from '../types/permissions.js'

export const CONTROL_REQUEST_TIMEOUT_MS = 15_000
export const HISTORY_BOOTSTRAP_TIMEOUT_MS = 2 * 60_000
export const SSH_FILE_SUGGESTION_TIMEOUT_MS = 2_000

export type SSHFileSuggestionQuery = {
  query: string
  mode: 'fuzzy' | 'path'
  show_on_empty?: boolean
  limit: number
}

export type SSHSessionCallbacks = {
  onMessage: (message: SDKMessage) => void
  onBootstrap?: (bootstrap: {
    sessionId: string
    history: SDKMessage[]
  }) => void
  onPermissionRequest: (
    request: SDKControlPermissionRequest,
    requestId: string,
  ) => void
  onPermissionCancelled?: (
    requestId: string,
    toolUseId: string | undefined,
  ) => void
  onConnected?: () => void
  onDisconnected?: () => void
  onError?: (error: Error) => void
}

function isStdoutMessage(value: unknown): value is StdoutMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string'
  )
}

type ControlResponseEnvelope = {
  subtype: 'success' | 'error'
  request_id: string
  response?: unknown
  error?: string
}

type SSHHistoryChunkEnvelope = {
  type: 'ssh_history_chunk'
  request_id: string
  sequence: number
  messages: SDKMessage[]
}

type SSHHistoryReplayResponse = {
  session_id: string
  count: number
  last_uuid?: string | null
}

function isControlResponseEnvelope(
  value: unknown,
): value is ControlResponseEnvelope {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('subtype' in value) ||
    (value.subtype !== 'success' && value.subtype !== 'error') ||
    !('request_id' in value) ||
    typeof value.request_id !== 'string'
  ) {
    return false
  }
  return (
    value.subtype === 'success' ||
    ('error' in value && typeof value.error === 'string')
  )
}

function isSSHHistoryChunkEnvelope(
  value: unknown,
): value is SSHHistoryChunkEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'ssh_history_chunk' &&
    'request_id' in value &&
    typeof value.request_id === 'string' &&
    'sequence' in value &&
    typeof value.sequence === 'number' &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 0 &&
    'messages' in value &&
    Array.isArray(value.messages)
  )
}

function isSSHHistoryReplayResponse(
  value: unknown,
): value is SSHHistoryReplayResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'session_id' in value &&
    typeof value.session_id === 'string' &&
    value.session_id.length > 0 &&
    'count' in value &&
    typeof value.count === 'number' &&
    Number.isSafeInteger(value.count) &&
    value.count >= 0 &&
    (!('last_uuid' in value) ||
      value.last_uuid === null ||
      typeof value.last_uuid === 'string')
  )
}

function isShellCommandResponse(
  value: unknown,
): value is SDKControlRunShellCommandResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'stdout' in value &&
    typeof value.stdout === 'string' &&
    'stderr' in value &&
    typeof value.stderr === 'string' &&
    'code' in value &&
    typeof value.code === 'number' &&
    'interrupted' in value &&
    typeof value.interrupted === 'boolean'
  )
}

function isSSHPermissionsResponse(
  value: unknown,
): value is SDKControlSSHPermissionsResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'overlay' in value &&
    typeof value.overlay === 'object' &&
    value.overlay !== null &&
    'rules' in value &&
    Array.isArray(value.rules) &&
    'additionalDirectories' in value &&
    Array.isArray(value.additionalDirectories)
  )
}

function isSSHFileSuggestionsResponse(
  value: unknown,
): value is SDKControlSSHFileSuggestionsResponse {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('items' in value) ||
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    !('incomplete' in value) ||
    typeof value.incomplete !== 'boolean'
  ) {
    return false
  }
  return value.items.every(
    (item: unknown): item is SSHFileSuggestionItem =>
      typeof item === 'object' &&
      item !== null &&
      'path' in item &&
      typeof item.path === 'string' &&
      item.path.length > 0 &&
      !item.path.includes('\0') &&
      'kind' in item &&
      (item.kind === 'file' || item.kind === 'directory') &&
      (!('score' in item) || typeof item.score === 'number'),
  )
}

function createAbortError(): Error {
  const error = new Error('SSH file suggestion request aborted')
  error.name = 'AbortError'
  return error
}

function isPermissionRequest(
  value: unknown,
): value is SDKControlPermissionRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'subtype' in value &&
    value.subtype === 'can_use_tool' &&
    'tool_name' in value &&
    typeof value.tool_name === 'string' &&
    'input' in value &&
    typeof value.input === 'object' &&
    value.input !== null &&
    'tool_use_id' in value &&
    typeof value.tool_use_id === 'string'
  )
}

export class SSHSessionManager {
  private stdoutInterface: Interface | null = null
  private connected = false
  private initialized = false
  private disconnected = false
  private remoteSessionId: string | null = null
  private pendingHistoryReplay: {
    requestId: string
    chunks: Map<number, SDKMessage[]>
    liveMessages: SDKMessage[]
    timeout: ReturnType<typeof setTimeout>
  } | null = null
  private pendingPermissionRequests = new Map<string, string>()
  private pendingPermissionModeRequests = new Map<
    string,
    {
      mode: PermissionMode
      resolve: (result: PermissionModeChangeResult) => void
      timeout: ReturnType<typeof setTimeout>
    }
  >()
  private pendingShellRequests = new Map<
    string,
    {
      resolve: (result: RemoteShellCommandResult) => void
      reject: (error: Error) => void
      removeAbortListener: () => void
      cancellationTimeout?: ReturnType<typeof setTimeout>
    }
  >()
  private pendingFileSuggestionRequests = new Map<
    string,
    {
      resolve: (response: SDKControlSSHFileSuggestionsResponse) => void
      reject: (error: Error) => void
      timeout: ReturnType<typeof setTimeout>
      removeAbortListener: () => void
    }
  >()
  private pendingPermissionsRequests = new Map<
    string,
    {
      resolve: (response: SDKControlSSHPermissionsResponse) => void
      reject: (error: Error) => void
      timeout: ReturnType<typeof setTimeout>
    }
  >()
  private pendingAcknowledgements = new Map<
    string,
    ReturnType<typeof setTimeout>
  >()
  private expectedPermissionResponseEchoes = new Map<
    string,
    ReturnType<typeof setTimeout>
  >()

  constructor(
    private readonly proc: ChildProcess,
    private readonly callbacks: SSHSessionCallbacks,
    private readonly sshRemoteToken?: string,
  ) {}

  connect(): void {
    if (this.connected || this.disconnected) return
    logForDebugging(
      `[SSHSessionManager] connecting capability=${this.sshRemoteToken ? 'present' : 'absent'}`,
    )
    if (!this.proc.stdout || !this.proc.stdin) {
      this.callbacks.onError?.(
        new Error('SSH child process is missing piped stdin/stdout'),
      )
      this.handleDisconnected()
      return
    }

    this.connected = true
    this.stdoutInterface = createInterface({ input: this.proc.stdout })
    this.stdoutInterface.on('line', line => this.handleLine(line))
    this.proc.once('close', () => this.handleDisconnected())
    this.proc.once('error', error => {
      this.callbacks.onError?.(error)
      this.handleDisconnected()
    })
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) {
      this.handleDisconnected()
      return
    }

    if (this.sshRemoteToken && this.callbacks.onBootstrap) {
      this.startHistoryReplay()
    }
  }

  async sendMessage(
    content: RemoteMessageContent,
    options?: { uuid?: string },
  ): Promise<boolean> {
    if (this.pendingHistoryReplay || (this.callbacks.onBootstrap && !this.initialized)) {
      return false
    }
    return this.write({
      type: 'user',
      ...(options?.uuid ? { uuid: options.uuid } : {}),
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this.remoteSessionId ?? '',
    })
  }

  respondToPermissionRequest(
    requestId: string,
    result: RemotePermissionResponse,
  ): void {
    if (!this.pendingPermissionRequests.delete(requestId)) {
      this.callbacks.onError?.(
        new Error(`No pending SSH permission request with ID: ${requestId}`),
      )
      return
    }
    const timeout = setTimeout(() => {
      this.expectedPermissionResponseEchoes.delete(requestId)
    }, CONTROL_REQUEST_TIMEOUT_MS)
    timeout.unref()
    this.expectedPermissionResponseEchoes.set(requestId, timeout)
    if (
      !this.write({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: {
            behavior: result.behavior,
            ...(result.behavior === 'allow'
              ? {
                  updatedInput: result.updatedInput,
                  ...(result.updatedPermissions?.length
                    ? { updatedPermissions: result.updatedPermissions }
                    : {}),
                }
              : { message: result.message }),
          },
        },
      })
    ) {
      this.expectedPermissionResponseEchoes.delete(requestId)
      clearTimeout(timeout)
    }
  }

  setPermissionMode(mode: PermissionMode): Promise<PermissionModeChangeResult> {
    const requestId = randomUUID()
    logForDebugging(
      `[SSHSessionManager] setting remote permission mode: ${mode} requestId=${requestId}`,
    )
    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        if (!this.pendingPermissionModeRequests.delete(requestId)) return
        resolve({
          success: false,
          error: 'SSH permission mode change timed out',
        })
      }, CONTROL_REQUEST_TIMEOUT_MS)
      timeout.unref()
      this.pendingPermissionModeRequests.set(requestId, {
        mode,
        resolve,
        timeout,
      })
      if (
        !this.write({
          type: 'control_request',
          request_id: requestId,
          request: { subtype: 'set_permission_mode', mode },
        })
      ) {
        this.pendingPermissionModeRequests.delete(requestId)
        clearTimeout(timeout)
        resolve({ success: false, error: 'SSH session is not connected' })
      }
    })
  }

  runShellCommand(
    command: string,
    signal: AbortSignal,
  ): Promise<RemoteShellCommandResult> {
    if (!this.sshRemoteToken) {
      logForDebugging(
        '[SSHSessionManager] direct shell rejected: missing capability',
      )
      return Promise.reject(
        new Error('Direct shell commands are unavailable in this SSH session'),
      )
    }
    if (signal.aborted) {
      logForDebugging(
        '[SSHSessionManager] direct shell skipped: signal already aborted',
      )
      return Promise.resolve({
        stdout: '',
        stderr: '',
        code: 137,
        interrupted: true,
      })
    }
    const requestId = randomUUID()
    logForDebugging(
      `[SSHSessionManager] direct shell request sent requestId=${requestId} commandLength=${command.length}`,
    )
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        logForDebugging(
          `[SSHSessionManager] direct shell abort requested requestId=${requestId}`,
        )
        const pending = this.pendingShellRequests.get(requestId)
        if (pending && !pending.cancellationTimeout) {
          const cancellationTimeout = setTimeout(() => {
            const cancelled = this.pendingShellRequests.get(requestId)
            if (cancelled?.cancellationTimeout !== cancellationTimeout) return
            this.pendingShellRequests.delete(requestId)
            cancelled.removeAbortListener()
            cancelled.reject(new Error('SSH shell command cancellation timed out'))
          }, CONTROL_REQUEST_TIMEOUT_MS)
          cancellationTimeout.unref()
          pending.cancellationTimeout = cancellationTimeout
        }
        this.sendInterrupt()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.pendingShellRequests.set(requestId, {
        resolve,
        reject,
        removeAbortListener: () =>
          signal.removeEventListener('abort', onAbort),
      })
      if (
        !this.write({
          type: 'control_request',
          request_id: requestId,
          request: {
            subtype: 'run_shell_command',
            command,
            ssh_remote_token: this.sshRemoteToken,
          },
        })
      ) {
        const pending = this.pendingShellRequests.get(requestId)
        this.pendingShellRequests.delete(requestId)
        pending?.removeAbortListener()
        reject(new Error('SSH session is not connected'))
      }
    })
  }

  getPermissions(): Promise<SDKControlSSHPermissionsResponse> {
    return this.sendPermissionsRequest({ subtype: 'ssh_permissions' })
  }

  updatePermissions(
    update: SDKControlSSHPermissionUpdate,
  ): Promise<SDKControlSSHPermissionsResponse> {
    return this.sendPermissionsRequest({
      subtype: 'ssh_update_permissions',
      update,
    })
  }

  private sendPermissionsRequest(
    request:
      | { subtype: 'ssh_permissions' }
      | { subtype: 'ssh_update_permissions'; update: SDKControlSSHPermissionUpdate },
  ): Promise<SDKControlSSHPermissionsResponse> {
    if (!this.sshRemoteToken) {
      return Promise.reject(
        new Error('Remote permission management is unavailable in this SSH session'),
      )
    }
    if (this.callbacks.onBootstrap && !this.initialized) {
      return Promise.reject(new Error('SSH session is not ready'))
    }

    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pendingPermissionsRequests.delete(requestId)) return
        reject(new Error('SSH permissions request timed out'))
      }, CONTROL_REQUEST_TIMEOUT_MS)
      timeout.unref()
      this.pendingPermissionsRequests.set(requestId, { resolve, reject, timeout })
      if (
        !this.write({
          type: 'control_request',
          request_id: requestId,
          request: {
            ...request,
            ssh_remote_token: this.sshRemoteToken,
          },
        })
      ) {
        this.pendingPermissionsRequests.delete(requestId)
        clearTimeout(timeout)
        reject(new Error('SSH session is not connected'))
      }
    })
  }

  getFileSuggestions(
    request: SSHFileSuggestionQuery,
    signal: AbortSignal,
  ): Promise<SDKControlSSHFileSuggestionsResponse> {
    if (!this.sshRemoteToken) {
      return Promise.reject(
        new Error('Remote file suggestions are unavailable in this SSH session'),
      )
    }
    if (this.callbacks.onBootstrap && !this.initialized) {
      return Promise.reject(new Error('SSH session is not ready'))
    }
    if (signal.aborted) return Promise.reject(createAbortError())

    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const pending = this.pendingFileSuggestionRequests.get(requestId)
        if (!pending) return
        this.pendingFileSuggestionRequests.delete(requestId)
        clearTimeout(pending.timeout)
        pending.removeAbortListener()
        this.write({ type: 'control_cancel_request', request_id: requestId })
        reject(createAbortError())
      }
      signal.addEventListener('abort', onAbort, { once: true })
      const timeout = setTimeout(() => {
        const pending = this.pendingFileSuggestionRequests.get(requestId)
        if (!pending) return
        this.pendingFileSuggestionRequests.delete(requestId)
        pending.removeAbortListener()
        this.write({ type: 'control_cancel_request', request_id: requestId })
        reject(new Error('SSH file suggestion request timed out'))
      }, SSH_FILE_SUGGESTION_TIMEOUT_MS)
      timeout.unref()
      this.pendingFileSuggestionRequests.set(requestId, {
        resolve,
        reject,
        timeout,
        removeAbortListener: () =>
          signal.removeEventListener('abort', onAbort),
      })
      if (
        !this.write({
          type: 'control_request',
          request_id: requestId,
          request: {
            subtype: 'ssh_file_suggestions',
            version: 1,
            ...request,
            ssh_remote_token: this.sshRemoteToken,
          },
        })
      ) {
        this.pendingFileSuggestionRequests.delete(requestId)
        clearTimeout(timeout)
        signal.removeEventListener('abort', onAbort)
        reject(new Error('SSH session is not connected'))
      }
    })
  }

  sendInterrupt(): void {
    const requestId = randomUUID()
    const timeout = setTimeout(() => {
      this.pendingAcknowledgements.delete(requestId)
    }, CONTROL_REQUEST_TIMEOUT_MS)
    timeout.unref()
    this.pendingAcknowledgements.set(requestId, timeout)
    if (
      !this.write({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'interrupt' },
      })
    ) {
      this.pendingAcknowledgements.delete(requestId)
      clearTimeout(timeout)
    }
  }

  disconnect(): void {
    if (this.disconnected) return
    this.stdoutInterface?.close()
    this.stdoutInterface = null
    this.connected = false
    this.initialized = false
    this.remoteSessionId = null
    this.disconnected = true
    this.clearPendingHistoryReplay()
    this.pendingPermissionRequests.clear()
    this.rejectPendingPermissionModeRequests('SSH session disconnected')
    this.rejectPendingShellRequests('SSH session disconnected')
    this.rejectPendingFileSuggestionRequests('SSH session disconnected')
    this.rejectPendingPermissionsRequests('SSH session disconnected')
    this.clearPendingAcknowledgements()
    this.clearExpectedPermissionResponseEchoes()
    if (this.proc.exitCode === null && this.proc.signalCode === null) {
      this.proc.kill('SIGTERM')
    }
  }

  isConnected(): boolean {
    return this.connected && !this.disconnected
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let parsed: unknown
    try {
      parsed = jsonParse(line)
    } catch {
      this.callbacks.onError?.(
        new Error(`Invalid stream-json output from SSH child: ${line.slice(0, 200)}`),
      )
      return
    }
    if (!isStdoutMessage(parsed)) {
      this.callbacks.onError?.(
        new Error('Invalid stream-json message from SSH child'),
      )
      return
    }

    if (isSSHHistoryChunkEnvelope(parsed)) {
      this.handleHistoryChunk(parsed)
      return
    }

    if (
      !this.initialized &&
      !this.pendingHistoryReplay &&
      parsed.type === 'system' &&
      parsed.subtype === 'init'
    ) {
      this.initialized = true
      this.callbacks.onConnected?.()
    }

    if (parsed.type === 'control_request') {
      if (isPermissionRequest(parsed.request)) {
        this.pendingPermissionRequests.set(
          parsed.request_id,
          parsed.request.tool_use_id,
        )
        this.callbacks.onPermissionRequest(parsed.request, parsed.request_id)
      } else {
        this.write({
          type: 'control_response',
          response: {
            subtype: 'error',
            request_id: parsed.request_id,
            error: 'Unsupported or invalid control request',
          },
        })
      }
      return
    }
    if (parsed.type === 'control_cancel_request') {
      const toolUseId = this.pendingPermissionRequests.get(parsed.request_id)
      this.pendingPermissionRequests.delete(parsed.request_id)
      this.callbacks.onPermissionCancelled?.(parsed.request_id, toolUseId)
      return
    }
    if (parsed.type === 'control_response') {
      if (!isControlResponseEnvelope(parsed.response)) {
        this.callbacks.onError?.(
          new Error('Invalid control response from SSH child'),
        )
        return
      }
      const response = parsed.response
      const requestId = response.request_id
      if (this.pendingHistoryReplay?.requestId === requestId) {
        this.completeHistoryReplay(response)
        return
      }
      const permissionEchoTimeout =
        this.expectedPermissionResponseEchoes.get(requestId)
      if (permissionEchoTimeout) {
        this.expectedPermissionResponseEchoes.delete(requestId)
        clearTimeout(permissionEchoTimeout)
        return
      }
      const pendingMode = this.pendingPermissionModeRequests.get(requestId)
      if (pendingMode) {
        this.pendingPermissionModeRequests.delete(requestId)
        clearTimeout(pendingMode.timeout)
        if (response.subtype === 'success') {
          logForDebugging(
            `[SSHSessionManager] remote permission mode set: ${pendingMode.mode}`,
          )
          pendingMode.resolve({ success: true })
        } else {
          logForDebugging(
            `[SSHSessionManager] remote permission mode rejected: ${pendingMode.mode}: ${response.error}`,
          )
          pendingMode.resolve({ success: false, error: response.error })
        }
        return
      }

      const acknowledgementTimeout = this.pendingAcknowledgements.get(requestId)
      if (acknowledgementTimeout) {
        this.pendingAcknowledgements.delete(requestId)
        clearTimeout(acknowledgementTimeout)
        if (response.subtype === 'error') {
          this.callbacks.onError?.(new Error(response.error))
        }
        return
      }

      const pendingPermissions = this.pendingPermissionsRequests.get(requestId)
      if (pendingPermissions) {
        this.pendingPermissionsRequests.delete(requestId)
        clearTimeout(pendingPermissions.timeout)
        if (response.subtype === 'error') {
          pendingPermissions.reject(new Error(response.error))
          return
        }
        if (!isSSHPermissionsResponse(response.response)) {
          pendingPermissions.reject(new Error('Invalid SSH permissions response'))
          return
        }
        pendingPermissions.resolve(response.response)
        return
      }

      const pendingShell = this.pendingShellRequests.get(requestId)
      const pendingFileSuggestions =
        this.pendingFileSuggestionRequests.get(requestId)
      if (pendingFileSuggestions) {
        this.pendingFileSuggestionRequests.delete(requestId)
        clearTimeout(pendingFileSuggestions.timeout)
        pendingFileSuggestions.removeAbortListener()
        if (response.subtype === 'error') {
          pendingFileSuggestions.reject(new Error(response.error))
          return
        }
        if (!isSSHFileSuggestionsResponse(response.response)) {
          pendingFileSuggestions.reject(
            new Error('Invalid SSH file suggestion response'),
          )
          return
        }
        pendingFileSuggestions.resolve(response.response)
      } else if (pendingShell) {
        this.pendingShellRequests.delete(requestId)
        pendingShell.removeAbortListener()
        if (pendingShell.cancellationTimeout) {
          clearTimeout(pendingShell.cancellationTimeout)
        }
        if (response.subtype === 'error') {
          logForDebugging(
            `[SSHSessionManager] direct shell response error requestId=${requestId}: ${response.error}`,
          )
          pendingShell.reject(new Error(response.error))
          return
        }
        if (!isShellCommandResponse(response.response)) {
          logForDebugging(
            `[SSHSessionManager] direct shell response invalid requestId=${requestId}`,
          )
          pendingShell.reject(new Error('Invalid SSH shell command response'))
          return
        }
        logForDebugging(
          `[SSHSessionManager] direct shell response received requestId=${requestId} code=${response.response.code} interrupted=${response.response.interrupted} stdoutBytes=${Buffer.byteLength(response.response.stdout)} stderrBytes=${Buffer.byteLength(response.response.stderr)}`,
        )
        pendingShell.resolve(response.response)
      } else {
        logForDebugging(
          `[SSHSessionManager] ignoring unmatched control response requestId=${requestId}`,
        )
      }
      return
    }
    if (parsed.type === 'keep_alive') return

    if (this.pendingHistoryReplay) {
      this.pendingHistoryReplay.liveMessages.push(parsed)
      return
    }

    this.callbacks.onMessage(parsed)
  }

  private startHistoryReplay(): void {
    const requestId = randomUUID()
    const timeout = setTimeout(() => {
      if (this.pendingHistoryReplay?.requestId !== requestId) return
      this.pendingHistoryReplay = null
      this.callbacks.onError?.(new Error('SSH history bootstrap timed out'))
      this.disconnect()
    }, HISTORY_BOOTSTRAP_TIMEOUT_MS)
    timeout.unref()
    this.pendingHistoryReplay = {
      requestId,
      chunks: new Map(),
      liveMessages: [],
      timeout,
    }
    if (
      !this.write({
        type: 'control_request',
        request_id: requestId,
        request: {
          subtype: 'replay_history',
          ssh_remote_token: this.sshRemoteToken,
        },
      })
    ) {
      this.clearPendingHistoryReplay()
      this.callbacks.onError?.(new Error('Failed to start SSH history bootstrap'))
      this.disconnect()
    }
  }

  private handleHistoryChunk(chunk: SSHHistoryChunkEnvelope): void {
    const pending = this.pendingHistoryReplay
    if (!pending || pending.requestId !== chunk.request_id) {
      this.callbacks.onError?.(new Error('Unexpected SSH history chunk'))
      return
    }
    if (pending.chunks.has(chunk.sequence)) {
      this.callbacks.onError?.(new Error('Duplicate SSH history chunk'))
      return
    }
    pending.chunks.set(chunk.sequence, chunk.messages)
  }

  private completeHistoryReplay(response: ControlResponseEnvelope): void {
    const pending = this.pendingHistoryReplay
    if (!pending) return
    clearTimeout(pending.timeout)
    this.pendingHistoryReplay = null
    if (response.subtype === 'error') {
      this.callbacks.onError?.(
        new Error(`SSH history bootstrap failed: ${response.error}`),
      )
      this.disconnect()
      return
    }
    if (!isSSHHistoryReplayResponse(response.response)) {
      this.callbacks.onError?.(new Error('Invalid SSH history bootstrap response'))
      this.disconnect()
      return
    }
    const sequences = [...pending.chunks.keys()].sort((a, b) => a - b)
    if (sequences.some((sequence, index) => sequence !== index)) {
      this.callbacks.onError?.(new Error('Incomplete SSH history bootstrap'))
      this.disconnect()
      return
    }
    const history = sequences.flatMap(sequence => pending.chunks.get(sequence) ?? [])
    if (history.length !== response.response.count) {
      this.callbacks.onError?.(new Error('SSH history bootstrap count mismatch'))
      this.disconnect()
      return
    }
    const lastMessage = history.at(-1) as (SDKMessage & { uuid?: string }) | undefined
    if (
      response.response.last_uuid &&
      lastMessage?.uuid !== response.response.last_uuid
    ) {
      this.callbacks.onError?.(new Error('SSH history bootstrap tail mismatch'))
      this.disconnect()
      return
    }
    this.remoteSessionId = response.response.session_id
    this.initialized = true
    this.callbacks.onBootstrap?.({
      sessionId: response.response.session_id,
      history,
    })
    this.callbacks.onConnected?.()
    for (const message of pending.liveMessages) {
      this.callbacks.onMessage(message)
    }
  }

  private write(message: unknown): boolean {
    if (
      !this.connected ||
      this.disconnected ||
      !this.proc.stdin ||
      !this.proc.stdin.writable
    ) {
      return false
    }
    try {
      this.proc.stdin.write(`${jsonStringify(message)}\n`)
      return true
    } catch (error) {
      this.callbacks.onError?.(
        error instanceof Error ? error : new Error(String(error)),
      )
      return false
    }
  }

  private rejectPendingPermissionModeRequests(error: string): void {
    if (this.pendingPermissionModeRequests.size > 0) {
      logForDebugging(
        `[SSHSessionManager] resolving pending permission mode requests count=${this.pendingPermissionModeRequests.size}: ${error}`,
      )
    }
    for (const pending of this.pendingPermissionModeRequests.values()) {
      clearTimeout(pending.timeout)
      pending.resolve({ success: false, error })
    }
    this.pendingPermissionModeRequests.clear()
  }

  private clearPendingHistoryReplay(): void {
    if (!this.pendingHistoryReplay) return
    clearTimeout(this.pendingHistoryReplay.timeout)
    this.pendingHistoryReplay = null
  }

  private clearPendingAcknowledgements(): void {
    for (const timeout of this.pendingAcknowledgements.values()) {
      clearTimeout(timeout)
    }
    this.pendingAcknowledgements.clear()
  }

  private clearExpectedPermissionResponseEchoes(): void {
    for (const timeout of this.expectedPermissionResponseEchoes.values()) {
      clearTimeout(timeout)
    }
    this.expectedPermissionResponseEchoes.clear()
  }

  private rejectPendingShellRequests(error: string): void {
    if (this.pendingShellRequests.size > 0) {
      logForDebugging(
        `[SSHSessionManager] rejecting pending direct shell requests count=${this.pendingShellRequests.size}: ${error}`,
      )
    }
    for (const pending of this.pendingShellRequests.values()) {
      pending.removeAbortListener()
      if (pending.cancellationTimeout) {
        clearTimeout(pending.cancellationTimeout)
      }
      pending.reject(new Error(error))
    }
    this.pendingShellRequests.clear()
  }

  private rejectPendingFileSuggestionRequests(error: string): void {
    for (const pending of this.pendingFileSuggestionRequests.values()) {
      clearTimeout(pending.timeout)
      pending.removeAbortListener()
      pending.reject(new Error(error))
    }
    this.pendingFileSuggestionRequests.clear()
  }

  private rejectPendingPermissionsRequests(error: string): void {
    for (const pending of this.pendingPermissionsRequests.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error(error))
    }
    this.pendingPermissionsRequests.clear()
  }

  private handleDisconnected(): void {
    if (this.disconnected) return
    logForDebugging('[SSHSessionManager] SSH child disconnected')
    this.connected = false
    this.initialized = false
    this.remoteSessionId = null
    this.disconnected = true
    this.clearPendingHistoryReplay()
    this.pendingPermissionRequests.clear()
    this.rejectPendingPermissionModeRequests('SSH session disconnected')
    this.rejectPendingShellRequests('SSH session disconnected')
    this.rejectPendingFileSuggestionRequests('SSH session disconnected')
    this.rejectPendingPermissionsRequests('SSH session disconnected')
    this.clearPendingAcknowledgements()
    this.clearExpectedPermissionResponseEchoes()
    this.stdoutInterface?.close()
    this.stdoutInterface = null
    this.callbacks.onDisconnected?.()
  }
}
