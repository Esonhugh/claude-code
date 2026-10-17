/** A user stop is distinct from a model or system interruption. */
export function cancelledAgentMessage(target: string): string {
  return `Agent "${target}" was stopped by the user and was not resumed. Treat its work as cancelled; only start a new agent for it if the user explicitly asks.`
}

export class AgentStoppedByUserError extends Error {
  constructor(agentId: string) {
    super(`Agent ${agentId} was stopped by the user and won't be resumed. Treat its work as cancelled; only launch a new agent if the user explicitly asks.`)
    this.name = 'AgentStoppedByUserError'
  }
}
