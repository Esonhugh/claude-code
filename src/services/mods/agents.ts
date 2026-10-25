import { parseAgentFromJson, type AgentDefinition, type AgentDefinitionsResult } from '../../tools/AgentTool/loadAgentsDir.js'
import { isDeepStrictEqual } from 'node:util'
import { isEffortLevel } from '../../utils/effort.js'
import { isAbsolute } from 'node:path'
import { readTeamFileAsync } from '../../utils/swarm/teamHelpers.js'
import type { ModInput } from './types.js'
import type { ToolUseContext } from '../../Tool.js'
import type { ModSnapshot } from './runtime.js'
import { providerForAgent } from './agentOffer.js'
import { logForDebugging } from '../../utils/debug.js'
import type { AppState } from '../../state/AppState.js'
import { isTerminalTaskStatus } from '../../taskStatus.js'

export type ModAgentStatus = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'
export type ModAgentInfo = { id: string; teammateId?: string; description: string; type: string; status: ModAgentStatus; parentId?: string; spawnedBy?: string; name?: string }

export async function listModAgents(tasks: AppState['tasks'], names: AppState['agentNameRegistry'] = new Map()): Promise<ModAgentInfo[]> {
  const namesById = new Map([...names].map(([name, id]) => [id as string, name]))
  const all = Object.values(tasks)
  const nativeMates = all.flatMap(task => task.type === 'in_process_teammate' && task.status === 'running' && task.identity.resumableAgentId === undefined ? [task.identity] : [])
  const teams = await Promise.all([...new Set(nativeMates.map(identity => identity.teamName))].map(name => readTeamFileAsync(name)))
  const inactiveMembers = new Set(teams.flatMap(team => (team?.members ?? []).filter(member => member.isActive === false).map(member => member.agentId)))
  const inactive = new Set(nativeMates.filter(identity => inactiveMembers.has(identity.agentId)).map(identity => identity.agentId))
  const activeIds = new Set<string>()
  const result = new Map<string, ModAgentInfo>()
  for (const task of all) {
    if (task.type !== 'local_agent' && task.type !== 'in_process_teammate') continue
    const teammate = task.type === 'in_process_teammate'
    const id = teammate ? task.identity.resumableAgentId ?? task.identity.agentId : task.agentId
    const terminal = isTerminalTaskStatus(task.status)
    if (terminal && activeIds.has(id)) continue
    if (!terminal) activeIds.add(id)
    const name = teammate ? task.identity.agentName : namesById.get(id)
    const parentId = teammate ? task.spawnedWith?.parentAgentId : task.parentAgentId
    let status: ModAgentStatus
    const storedStatus: ModAgentStatus | 'paused' = task.status as ModAgentStatus | 'paused'
    switch (storedStatus) {
      case 'running': status = (teammate ? task.awaitingPlanApproval : task.isIdle) === true ? 'waiting' : task.isIdle === true ? 'idle' : 'running'; break
      case 'completed': {
        const keepalive = teammate ? [] : [...task.keepaliveReasons ?? []]
        status = !teammate && task.finalizing === true ? 'running'
          : keepalive.some(reason => reason !== 'flag:idle-window') ? 'waiting'
          : !teammate && (name !== undefined || keepalive.length > 0) ? 'idle' : 'completed'
        break
      }
      case 'paused': status = 'idle'; break
      default: status = storedStatus
    }
    if (inactive.has(id)) status = 'idle'
    if (status === 'idle' && all.some(work => work.status === 'running' &&
      ((work.type === 'local_bash' && work.isBackgrounded) || work.type === 'monitor_mcp') &&
      'agentId' in work && work.agentId === id)) status = 'waiting'
    result.set(id, {
      id, ...(teammate ? {teammateId:task.identity.agentId} : {}),
      description: teammate ? task.spawnedWith?.description ?? task.description : task.description,
      type: teammate ? task.spawnedWith?.agentType || 'teammate' : task.agentType,
      status, ...(parentId === undefined ? {} : {parentId}),
      ...(task.spawnedBy === undefined ? {} : {spawnedBy:task.spawnedBy}),
      ...(name === undefined ? {} : {name}),
    })
  }
  return [...result.values()]
}

// A workflow agent takes a rewrite of its prompt and model only; a resumed run takes none.
const workflowFixedKeys = ['description', 'subagentType', 'background', 'cwd']
const resumeFixedKeys = ['prompt', 'description', 'subagentType', 'model', 'background', 'cwd']

export function restoreModAgentSpawnInput(value: ModInput, received: ModInput, onIgnored?: (key: string) => void): ModInput {
  const fixed = received.resume !== undefined ? resumeFixedKeys : received.workflow !== undefined ? workflowFixedKeys : []
  if (fixed.length) {
    const changed = fixed.filter(key => !isDeepStrictEqual(value[key], received[key]))
    for (const key of changed) onIgnored?.(key)
    if (changed.length) value = { ...value, ...Object.fromEntries(changed.map(key => [key, received[key]])) }
  }
  const missing = ['isTeammate', 'parentAgentId', 'provider', 'workflow', 'resume'].filter(key => !Object.hasOwn(value, key) && Object.hasOwn(received, key))
  const restored = missing.length ? {...value, ...Object.fromEntries(missing.map(key => [key, received[key]]))} : value
  return received.isTeammate === true && ['background', 'cwd'].some(key => restored[key] !== received[key])
    ? {...restored, background:received.background, cwd:received.cwd} : restored
}

export function validateModAgentSpawnInput(value: ModInput, received: ModInput): void {
  for (const key of ['tool_use_id', 'name', 'fork', 'isTeammate', 'workflow', 'resume', 'parentModel', 'permissionMode', 'parentAgentId', 'provider'])
    if (!isDeepStrictEqual(value[key], received[key])) throw new Error(`agent.spawn cannot rewrite ${key}`)
  const checks: [string, boolean][] = [
    ['prompt', typeof value.prompt === 'string' && value.prompt.trim() !== ''],
    ['description', typeof value.description === 'string'],
    ['subagentType', typeof value.subagentType === 'string'],
    ['model', value.model === undefined || typeof value.model === 'string'],
    ['effort', value.effort === undefined || typeof value.effort === 'string' && isEffortLevel(value.effort) || typeof value.effort === 'number' && Number.isInteger(value.effort)],
    ['background', typeof value.background === 'boolean'],
    ['cwd', value.cwd === undefined || typeof value.cwd === 'string' && isAbsolute(value.cwd)],
  ]
  for (const [key, valid] of checks) if (!valid && value[key] !== received[key]) throw new Error(`agent.spawn invalid ${key}`)
}

export function createModAgents(pluginOf: (owner: object) => { name: string; storageId: string; isNative?: boolean }, notify: (listener: () => void) => void = listener => listener()) {
  const candidates = new Map<object, Map<string, AgentDefinition>>()
  const published = new WeakSet<object>()
  const projected = new WeakSet<AgentDefinition>()
  const active = new Map<string, { owner: object; definition: AgentDefinition }>()
  const listeners = new Set<() => void>()
  let snapshot: AgentDefinition[] = []
  function publish() {
    snapshot = [...active.values()].map(item => item.definition)
    for (const listener of listeners) notify(listener)
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
      const parsed = parseAgentFromJson(name, input, 'userSettings', {modSpec:true})
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

function spawnProvider(context: ToolUseContext, snapshot: ModSnapshot, subagentType: string): ModInput {
  const agent = context.options.agentDefinitions.activeAgents.find(candidate => candidate.agentType === subagentType)
  return agent ? providerForAgent(agent, snapshot) : { plugin: 'engine', tier: 'core' }
}

/**
 * Raises `agent.spawn` for a spawn whose content `workflow` or `resume` fixes:
 * a hook's rewrite of a fixed key is left out and said once; a deny throws.
 * Returns the input the bottom saw, or undefined when nothing listens.
 */
async function raiseFixedModAgentSpawn(context: ToolUseContext, build: (snapshot: ModSnapshot) => ModInput, agentId: string): Promise<ModInput | undefined> {
  const snapshot = context.mods?.capture({})
  try {
    if (!snapshot?.hasHooks('agent.spawn')) return undefined
    const input: ModInput = {
      tool_use_id: context.toolUseId ?? '',
      parentModel: context.options.mainLoopModel,
      permissionMode: context.getAppState().toolPermissionContext.mode,
      ...build(snapshot),
      ...(context.agentId === undefined ? {} : { parentAgentId: context.agentId }),
    }
    const ignored = new Set<string>()
    let started: ModInput | undefined
    const result = await snapshot.dispatch('agent.spawn', input, async value => {
      validateModAgentSpawnInput(value, input)
      started ??= value
      return { model: (started.model as string | undefined) ?? context.options.mainLoopModel, agentId }
    }, {
      signal: context.abortController.signal,
      validateInput: value => validateModAgentSpawnInput(value, input),
      restoreInput: (value, received) => restoreModAgentSpawnInput(value, received, key => {
        if (ignored.has(key)) return
        ignored.add(key)
        logForDebugging(`agent.spawn: ${received.resume !== undefined ? 'a resumed run' : "a workflow agent's"} ${key} is fixed; the rewrite is left out`)
      }),
    }) as { deny?: string }
    if (typeof result.deny === 'string') throw new Error(result.deny)
    if (!started) throw new Error('agent.spawn: a hook answered without passing the spawn on')
    return started
  } finally {
    snapshot?.release()
  }
}

/**
 * Raises `agent.spawn` for a workflow script's `agent()` call. A hook may
 * rewrite its prompt and model; a deny is the error `agent()` throws.
 */
export async function raiseModWorkflowAgentSpawn(context: ToolUseContext, spawn: {
  prompt: string
  model?: string
  agentId: string
  runId: string
  agentIndex: number
  description: string
  subagentType: string
}): Promise<{ prompt: string; model?: string }> {
  const started = await raiseFixedModAgentSpawn(context, snapshot => ({
    prompt: spawn.prompt,
    description: spawn.description,
    subagentType: spawn.subagentType,
    provider: spawnProvider(context, snapshot, spawn.subagentType),
    background: false,
    fork: false,
    workflow: { runId: spawn.runId, agentIndex: spawn.agentIndex },
    ...(spawn.model === undefined ? {} : { model: spawn.model }),
  }), spawn.agentId)
  return started ? { prompt: started.prompt as string, model: started.model as string | undefined } : { prompt: spawn.prompt, model: spawn.model }
}

/**
 * Raises `agent.spawn` with `resume` before a saved subagent run continues.
 * A hook can only refuse it; the deny is the resume's error and starts nothing.
 */
export async function raiseModAgentResume(context: ToolUseContext, resume: {
  agentId: string
  prompt: string
  description: string
  subagentType: string
  model?: string
  permissionMode: string
  fork: boolean
}): Promise<void> {
  await raiseFixedModAgentSpawn(context, snapshot => ({
    prompt: resume.prompt,
    description: resume.description,
    subagentType: resume.subagentType,
    provider: spawnProvider(context, snapshot, resume.subagentType),
    permissionMode: resume.permissionMode,
    background: true,
    fork: resume.fork,
    resume: { agentId: resume.agentId },
    ...(resume.model === undefined ? {} : { model: resume.model }),
  }), resume.agentId)
}
