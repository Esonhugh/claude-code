import type { Message, StreamEvent } from '../../types/message.js'
import type { ModRequestServices } from './runtime.js'
import type { createModTurnCompletion } from './turnAdapter.js'

export type ModTurnEnd = {
  aborted: boolean
  failed: boolean
  terminal?: { reason?: string }
}
export type ModRegisteredTurn = {
  readonly turnId: string
  readonly agentId?: string
  observe(message: Message | StreamEvent): void
  rememberQueryServices(services: ModRequestServices): void
  release(): void
  finish(end: ModTurnEnd): Promise<Awaited<ReturnType<ReturnType<typeof createModTurnCompletion>['complete']>> | undefined>
}

/** Host registration is keyed by producer identity, never by query source. */
export function createModTurnRegistry<T extends { readonly turnId: string; readonly agentId?: string }>() {
  let main: T | undefined
  const agents = new Map<string, T>()
  return {
    admit(turn: T): void {
      if (turn.agentId === undefined) main = turn
      else agents.set(turn.agentId, turn)
    },
    current(agentId?: string): T | undefined {
      return agentId === undefined ? main : agents.get(agentId)
    },
    release(turn: T): void {
      if (turn.agentId === undefined) {
        if (main === turn) main = undefined
      } else if (agents.get(turn.agentId) === turn) agents.delete(turn.agentId)
    },
    clear(): void { main = undefined; agents.clear() },
  }
}
