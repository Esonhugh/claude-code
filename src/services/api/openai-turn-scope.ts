import { randomUUID } from 'crypto'
import type { AgentId } from '../../types/ids.js'
import { getSessionId } from '../../bootstrap/state.js'

export type OpenAIRequestIdentity = Readonly<{
  sessionId: string
  threadId: string
  promptCacheKey: string
}>

/** Mutable state shared by every OpenAI request in one outer query turn. */
export function createOpenAITurnScope(
  agentId?: AgentId,
  turnId?: string,
): OpenAITurnScope {
  const sessionId = getSessionId()
  return new OpenAITurnScope(
    {
      sessionId,
      threadId: agentId ?? sessionId,
      promptCacheKey: sessionId,
    },
    turnId,
  )
}

export class OpenAITurnScope {
  readonly turnId: string
  private turnState: string | undefined
  private websocketUnavailable = false

  constructor(
    readonly identity: OpenAIRequestIdentity,
    turnId: string = randomUUID(),
  ) {
    this.turnId = turnId
  }

  getTurnState(): string | undefined {
    return this.turnState
  }

  setTurnStateIfAbsent(value: string | null | undefined): void {
    const normalized = value?.trim()
    if (!this.turnState && normalized) this.turnState = normalized
  }

  canUseWebSocket(): boolean {
    return !this.websocketUnavailable
  }

  disableWebSocket(): void {
    this.websocketUnavailable = true
  }
}
