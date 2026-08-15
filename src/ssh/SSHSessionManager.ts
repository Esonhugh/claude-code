import { randomUUID } from 'crypto'
import type { ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type {
  SDKControlPermissionRequest,
  StdoutMessage,
} from '../entrypoints/sdk/controlTypes.js'
import type { RemotePermissionResponse } from '../remote/RemoteSessionManager.js'
import { logForDebugging } from '../utils/debug.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import type { RemoteMessageContent } from '../utils/teleport/api.js'

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

  constructor(
    private readonly proc: ChildProcess,
    private readonly callbacks: SSHSessionCallbacks,
  ) {}

  connect(): void {
    if (this.connected || this.disconnected) return
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
    this.write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: {
          behavior: result.behavior,
          ...(result.behavior === 'allow'
            ? { updatedInput: result.updatedInput }
            : { message: result.message }),
        },
      },
    })
  }

  sendInterrupt(): void {
    this.write({
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'interrupt' },
    })
  }

  disconnect(): void {
    if (this.disconnected) return
    this.stdoutInterface?.close()
    this.stdoutInterface = null
    this.connected = false
    this.initialized = false
    this.disconnected = true
    this.pendingPermissionRequests.clear()
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
    if (parsed.type === 'control_response' || parsed.type === 'keep_alive') {
      return
    }

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

  private handleDisconnected(): void {
    if (this.disconnected) return
    logForDebugging('[SSHSessionManager] SSH child disconnected')
    this.connected = false
    this.initialized = false
    this.disconnected = true
    this.pendingPermissionRequests.clear()
    this.stdoutInterface?.close()
    this.stdoutInterface = null
    this.callbacks.onDisconnected?.()
  }
}
