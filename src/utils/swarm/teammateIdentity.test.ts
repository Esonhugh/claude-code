import { afterEach, expect, test } from 'bun:test'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { listModAgents } from '../../services/mods/agents.js'
import type { AppState } from '../../state/AppState.js'
import { spawnInProcessTeammate, type InProcessSpawnConfig } from './spawnInProcess.js'

const states: Array<() => AppState> = []
afterEach(() => {
  for (const getState of states.splice(0)) for (const task of Object.values(getState().tasks)) {
    if (task.type === 'in_process_teammate') { task.unregisterCleanup?.(); task.abortController?.abort() }
  }
})
function fixture() {
  let state = getDefaultAppState()
  const context = { getAppState: () => state, setAppState: (update: (prev: AppState) => AppState) => { state = update(state) } }
  states.push(context.getAppState)
  return context
}
const config: InProcessSpawnConfig = {name:'reviewer',teamName:'identity-producer-team',prompt:'Review',planModeRequired:false,permissionMode:'default'}

test('C17 actual constructor mints a logical identity and publishes it to native list and name registry', async () => {
  const context = fixture()
  const result = await spawnInProcessTeammate(config, context)
  expect(result.success).toBe(true)
  const task = context.getAppState().tasks[result.taskId!]
  expect(task.type).toBe('in_process_teammate')
  if (task.type !== 'in_process_teammate') throw Error('Missing produced teammate')
  expect(task.identity.resumableAgentId).toMatch(/^areviewer-[0-9a-f]{16}$/)
  expect(task.identity.agentId).toBe('reviewer@identity-producer-team')
  expect<string | undefined>(context.getAppState().agentNameRegistry.get('reviewer')).toBe(task.identity.resumableAgentId)
  expect(await listModAgents(context.getAppState().tasks, context.getAppState().agentNameRegistry)).toEqual([
    {id:task.identity.resumableAgentId,teammateId:task.identity.agentId,description:'Review',type:'teammate',status:'running',name:'reviewer'},
  ])
  expect(result.identity).toEqual(task.identity)
})

test('C17 actual constructor preserves a supplied resume identity without minting a replacement', async () => {
  const context = fixture(), id = 'areviewer-0123456789abcdef'
  const first = await spawnInProcessTeammate({...config,resumableAgentId:id}, context)
  const second = await spawnInProcessTeammate({...config,resumableAgentId:id}, context)
  expect(first.identity?.resumableAgentId).toBe(id)
  expect(second.identity?.resumableAgentId).toBe(id)
  expect<string | undefined>(context.getAppState().agentNameRegistry.get('reviewer')).toBe(id)
  expect(context.getAppState().agentNameRegistry.size).toBe(1)
})

test('C17 actual constructor preserves a live name route and allocates a distinct registry name', async () => {
  const context = fixture()
  const first = await spawnInProcessTeammate(config, context)
  const second = await spawnInProcessTeammate({...config,teamName:'other-team'}, context)
  expect(first.identity?.resumableAgentId).toMatch(/^areviewer-[0-9a-f]{16}$/)
  expect(second.identity?.resumableAgentId).not.toBe(first.identity?.resumableAgentId)
  expect<string | undefined>(context.getAppState().agentNameRegistry.get('reviewer')).toBe(first.identity?.resumableAgentId)
  expect<string | undefined>(context.getAppState().agentNameRegistry.get('reviewer-2')).toBe(second.identity?.resumableAgentId)
})

test('C17 actual constructor replaces terminal names but does not publish reserved routes', async () => {
  const context = fixture()
  const first = await spawnInProcessTeammate(config, context)
  context.setAppState(prev => ({...prev,tasks:{...prev.tasks,[first.taskId!]:{...prev.tasks[first.taskId!],status:'completed'}}}))
  const second = await spawnInProcessTeammate(config, context)
  expect<string | undefined>(context.getAppState().agentNameRegistry.get('reviewer')).toBe(second.identity?.resumableAgentId)
  expect(context.getAppState().agentNameRegistry.has('reviewer-2')).toBe(false)
  for (const name of ['main','team-lead','user','system','a0123456789abcdef']) await spawnInProcessTeammate({...config,name},context)
  expect([...context.getAppState().agentNameRegistry.keys()]).toEqual(['reviewer'])
})
