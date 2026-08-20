import type {
  SDKControlRequest,
  SDKControlSSHFileSuggestionsRequest,
  StdoutMessage,
} from '../entrypoints/sdk/controlTypes.js'
import {
  SDKControlReplayHistoryRequestSchema,
  SDKControlSSHFileSuggestionsRequestSchema,
} from '../entrypoints/sdk/controlSchemas.js'
import type { Message } from '../types/message.js'
import { errorMessage } from '../utils/errors.js'
import {
  assertManagedSSHCapability,
  queryRemoteFileSuggestions,
  type RemoteFileSuggestionDependencies,
} from './remoteFileSuggestions.js'
import { buildSSHHistoryReplay } from './remoteHistoryReplay.js'

type QueryFileSuggestions = (
  request: SDKControlSSHFileSuggestionsRequest,
  dependencies: RemoteFileSuggestionDependencies,
) => ReturnType<typeof queryRemoteFileSuggestions>

export class ManagedSSHControlService {
  private readonly activeFileRequests = new Map<string, AbortController>()

  constructor(
    private readonly options: {
      environment?: Record<string, string | undefined>
      getHistory: () => readonly Message[]
      getSessionId: () => string
      enqueue: (message: StdoutMessage) => void
      queryFileSuggestions?: QueryFileSuggestions
    },
  ) {}

  handleRequest(message: SDKControlRequest): boolean {
    if (message.request.subtype === 'replay_history') {
      this.handleReplayHistory(message)
      return true
    }
    if (message.request.subtype === 'ssh_file_suggestions') {
      this.handleFileSuggestions(message)
      return true
    }
    return false
  }

  cancel(requestId: string): boolean {
    const controller = this.activeFileRequests.get(requestId)
    if (!controller) return false
    this.activeFileRequests.delete(requestId)
    controller.abort()
    return true
  }

  shutdown(): void {
    for (const controller of this.activeFileRequests.values()) {
      controller.abort()
    }
    this.activeFileRequests.clear()
  }

  private handleReplayHistory(message: SDKControlRequest): void {
    try {
      const request = SDKControlReplayHistoryRequestSchema().parse(message.request)
      assertManagedSSHCapability(
        request.ssh_remote_token,
        this.options.environment,
      )
      const replay = buildSSHHistoryReplay(this.options.getHistory(), {
        requestId: message.request_id,
        sessionId: this.options.getSessionId(),
      })
      for (const chunk of replay.chunks) this.options.enqueue(chunk)
      this.sendSuccess(message.request_id, replay.response)
    } catch (error) {
      this.sendError(message.request_id, errorMessage(error))
    }
  }

  private handleFileSuggestions(message: SDKControlRequest): void {
    let request: SDKControlSSHFileSuggestionsRequest
    try {
      request = SDKControlSSHFileSuggestionsRequestSchema().parse(message.request)
      assertManagedSSHCapability(
        request.ssh_remote_token,
        this.options.environment,
      )
    } catch (error) {
      this.sendError(message.request_id, errorMessage(error))
      return
    }

    const previous = this.activeFileRequests.get(message.request_id)
    previous?.abort()
    const controller = new AbortController()
    this.activeFileRequests.set(message.request_id, controller)
    const query = this.options.queryFileSuggestions ?? queryRemoteFileSuggestions
    void query(request, { signal: controller.signal })
      .then(response => {
        if (
          controller.signal.aborted ||
          this.activeFileRequests.get(message.request_id) !== controller
        ) {
          return
        }
        this.sendSuccess(message.request_id, response)
      })
      .catch(error => {
        if (
          controller.signal.aborted ||
          this.activeFileRequests.get(message.request_id) !== controller
        ) {
          return
        }
        this.sendError(message.request_id, errorMessage(error))
      })
      .finally(() => {
        if (this.activeFileRequests.get(message.request_id) === controller) {
          this.activeFileRequests.delete(message.request_id)
        }
      })
  }

  private sendSuccess(
    requestId: string,
    response: Record<string, unknown>,
  ): void {
    this.options.enqueue({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    })
  }

  private sendError(requestId: string, error: string): void {
    this.options.enqueue({
      type: 'control_response',
      response: { subtype: 'error', request_id: requestId, error },
    })
  }
}
