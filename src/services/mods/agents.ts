import { parseAgentFromJson, type AgentDefinition, type AgentDefinitionsResult } from '../../tools/AgentTool/loadAgentsDir.js'
import type { AppState } from '../../state/AppState.js'

export function listModAgents(tasks: AppState['tasks'], names: AppState['agentNameRegistry'] = new Map()) {
  const namesById = new Map([...names].map(([name, id]) => [id as string, name]))
  return Object.values(tasks).flatMap(task => {
    if (task.type !== 'local_agent' && task.type !== 'in_process_teammate') return []
    const id = task.type === 'local_agent' ? task.agentId : task.identity.agentId
    const name = task.type === 'in_process_teammate' ? task.identity.agentName : namesById.get(id)
    const parentId = task.type === 'local_agent' ? task.parentAgentId : undefined
    return [{
      id, description: task.description, type: task.type === 'local_agent' ? task.agentType : 'teammate', status: task.status,
      ...(parentId === undefined ? {} : {parentId}),
      ...(name === undefined ? {} : {name}),
    }]
  })
}

export function createModAgents(pluginOf: (owner: object) => { name: string; storageId: string }) {
  const candidates = new Map<object, Map<string, AgentDefinition>>()
  const published = new WeakSet<object>()
  const projected = new WeakSet<AgentDefinition>()
  const active = new Map<string, { owner: object; definition: AgentDefinition }>()
  const listeners = new Set<() => void>()
  let snapshot: AgentDefinition[] = []
  function publish() {
    snapshot = [...active.values()].map(item => item.definition)
    for (const listener of listeners) listener()
  }
  function validateCommit(owner: object, replaced?: object, prepared: readonly object[] = []) {
    for (const name of candidates.get(owner)?.keys() ?? []) {
      const current = active.get(name)
      if ((current && current.owner !== owner && current.owner !== replaced) || prepared.some(other => other !== owner && candidates.get(other)?.has(name)))
        throw new Error(`Mod agent ${name} is already owned by another activation`)
    }
  }
  function projection(base: AgentDefinition[]) {
    const names = new Set(snapshot.map(agent => agent.agentType))
    return [...base.filter(agent => !projected.has(agent) && !names.has(agent.agentType)), ...snapshot]
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    projection(base: AgentDefinitionsResult): AgentDefinitionsResult {
      if (!snapshot.length && !base.allAgents.some(agent => projected.has(agent)) && !base.activeAgents.some(agent => projected.has(agent))) return base
      return {...base, allAgents: projection(base.allAgents), activeAgents: projection(base.activeAgents)}
    },
    register(owner: object, input: Record<string, unknown>) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.name !== 'string' || !input.name.trim())
        throw new TypeError('agent.register requires a name and agent specification')
      const plugin = pluginOf(owner)
      const name = `${plugin.name}:${input.name}`
      const parsed = parseAgentFromJson(name, input)
      if (!parsed) throw new TypeError('agent.register requires a valid settings agent definition')
      const definition: AgentDefinition = {...parsed, source: 'plugin', plugin: plugin.storageId}
      projected.add(definition)
      if (published.has(owner)) {
        const current = active.get(name)
        if (current && current.owner !== owner) throw new Error(`Mod agent ${name} is already owned by another activation`)
        active.set(name, {owner, definition})
        publish()
      } else {
        let owned = candidates.get(owner)
        if (!owned) { owned = new Map(); candidates.set(owner, owned) }
        owned.set(name, definition)
      }
      return {agent: name}
    },
    validateCommit,
    commit(owner: object, replaced?: object) {
      validateCommit(owner, replaced)
      let changed = false
      for (const [name, current] of active) {
        if (current.owner === owner || current.owner === replaced) { active.delete(name); changed = true }
      }
      for (const [name, definition] of candidates.get(owner) ?? []) { active.set(name, {owner, definition}); changed = true }
      candidates.delete(owner)
      if (replaced) published.delete(replaced)
      published.add(owner)
      if (changed) publish()
    },
    release(owner: object) {
      candidates.delete(owner)
      published.delete(owner)
      let changed = false
      for (const [name, current] of active) {
        if (current.owner === owner) { active.delete(name); changed = true }
      }
      if (changed) publish()
    },
  }
}
