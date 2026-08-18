import { randomUUID } from 'crypto'
import type { ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type {
  SDKControlPermissionRequest,
  SDKControlRunShellCommandResponse,
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

export type SSHSessionCallbacks = {
  onMessage: (message: SDKMessage) => void
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
    }
  }

  async sendMessage(content: RemoteMessageContent): Promise<boolean> {
    return this.write({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
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
    this.disconnected = true
    this.pendingPermissionRequests.clear()
    this.rejectPendingPermissionModeRequests('SSH session disconnected')
    this.rejectPendingShellRequests('SSH session disconnected')
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

    if (
      !this.initialized &&
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

      const pendingShell = this.pendingShellRequests.get(requestId)
      if (pendingShell) {
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

    this.callbacks.onMessage(parsed)
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

  private handleDisconnected(): void {
    if (this.disconnected) return
    logForDebugging('[SSHSessionManager] SSH child disconnected')
    this.connected = false
    this.initialized = false
    this.disconnected = true
    this.pendingPermissionRequests.clear()
    this.rejectPendingPermissionModeRequests('SSH session disconnected')
    this.rejectPendingShellRequests('SSH session disconnected')
    this.clearPendingAcknowledgements()
    this.clearExpectedPermissionResponseEchoes()
    this.stdoutInterface?.close()
    this.stdoutInterface = null
    this.callbacks.onDisconnected?.()
  }
}
