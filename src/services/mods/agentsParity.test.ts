import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime, type ModsRuntime } from './runtime.js'
import type { AppState } from '../../state/AppState.js'
import { writeTeamFileAsync } from '../../utils/swarm/teamHelpers.js'
const roots:string[]=[];const runtimes:ModsRuntime[]=[]
let savedConfigDir: string | undefined
beforeEach(async () => {
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  const config = await realpath(await mkdtemp(join(tmpdir(), 'mods-agent-config-')))
  roots.push(config)
  process.env.CLAUDE_CONFIG_DIR = config
})
afterEach(async()=>{
  try { await Promise.all(runtimes.splice(0).map(x=>x.dispose())) }
  finally {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
    await Promise.all(roots.splice(0).map(x=>rm(x,{recursive:true,force:true})))
  }
})
async function observer(tasks:AppState['tasks'], names:AppState['agentNameRegistry']=new Map()){
  const root=await realpath(await mkdtemp(join(tmpdir(),'mods-agent-parity-')));roots.push(root);const entry=join(root,'register.ts')
  await writeFile(entry,`export function register(on){on('command.run',async $=>({text:JSON.stringify(await $.agent.list())}))}`)
  const runtime=createModsRuntime({services:{tasks:()=>tasks,agentNames:()=>names}});runtimes.push(runtime)
  await runtime.bind({cwd:'/tmp',surface:null,isInteractive:false,sessionId:'offline'})
  await runtime.reconcile([{name:'observer',storageId:'observer@test',pluginRoot:root,entrypoints:[entry]}])
  const snapshot=runtime.capture();try{return JSON.parse((await snapshot.dispatch('command.run',{},async()=>({})) as {text:string}).text)}finally{snapshot.release()}
}
function local(id:string,status:string,extra:Record<string,unknown>={}){return {id,type:'local_agent',agentId:id,agentType:'Explore',description:id,status,...extra}}
function mate(id:string,extra:Record<string,unknown>={}){return {id,type:'in_process_teammate',description:'Task label',status:'running',identity:{agentId:id,agentName:id,teamName:'agent-parity',resumableAgentId:'logical-'+id},spawnedWith:{description:'Spawn description',agentType:'Review',parentAgentId:'parent'},...extra}}
test('C17 production Worker projects native task-feature fixture states and identity',async()=>{
  const tasks={pending:local('pending','pending'),run:local('run','running'),wait:local('wait','running',{isIdle:true}),finalizing:local('finalizing','completed',{finalizing:true}),keep:local('keep','completed',{keepaliveReasons:new Set(['child'])}),idleWindow:local('idleWindow','completed',{keepaliveReasons:new Set(['flag:idle-window'])}),named:local('named','completed'),done:local('done','completed'),fail:local('fail','failed'),killed:local('killed','killed'),paused:local('paused','paused'),mateIdle:mate('mateIdle',{isIdle:true,spawnedBy:'author'}),mateApproval:mate('mateApproval',{isIdle:true,awaitingPlanApproval:true})} as unknown as AppState['tasks']
  const rows=await observer(tasks,new Map([['kept','named' as never]]))
  expect(rows.map((x:{id:string;status:string})=>[x.id,x.status])).toEqual([['pending','pending'],['run','running'],['wait','waiting'],['finalizing','running'],['keep','waiting'],['idleWindow','idle'],['named','idle'],['done','completed'],['fail','failed'],['killed','killed'],['paused','idle'],['logical-mateIdle','idle'],['logical-mateApproval','waiting']])
  expect(rows.find((x:{id:string})=>x.id==='logical-mateIdle')).toEqual({id:'logical-mateIdle',teammateId:'mateIdle',description:'Spawn description',type:'Review',status:'idle',parentId:'parent',spawnedBy:'author',name:'mateIdle',kind:'in_process_teammate',
    taskStatus:'running',label:'Spawn description',cwd:'/tmp',tokenCount:0,tokenSamples:[0],cost:{usd:0},hasRow:true})
})
test('C17 production Worker prefers live logical duplicate and retains monitor work',async()=>{
  const tasks={live:local('same','running'),old:local('same','completed'),mate:mate('mate',{isIdle:true}),shell:{id:'shell',type:'local_bash',status:'running',isBackgrounded:true,agentId:'logical-mate'},monitor:{id:'monitor',type:'monitor_mcp',status:'running',agentId:'monitor-agent'},kept:local('monitor-agent','completed')} as unknown as AppState['tasks']
  const rows=await observer(tasks,new Map([['name','monitor-agent' as never]]))
  expect(rows.filter((x:{id:string})=>x.id==='same')).toHaveLength(1)
  expect(rows.find((x:{id:string})=>x.id==='same').status).toBe('running')
  expect(rows.find((x:{id:string})=>x.id==='logical-mate').status).toBe('waiting')
  expect(rows.find((x:{id:string})=>x.id==='monitor-agent').status).toBe('waiting')
})
test('C17 production Worker reads inactive teammate status from the real persisted team',async()=>{
  const name='inactive-agent-parity-'+Date.now()
  await writeTeamFileAsync(name,{name,createdAt:0,leadAgentId:'lead',members:[{agentId:'inactive',name:'inactive',joinedAt:0,tmuxPaneId:'none',cwd:'/tmp',subscriptions:[],isActive:false}]})
  const tasks={mate:mate('inactive',{identity:{agentId:'inactive',agentName:'inactive',teamName:name}})} as unknown as AppState['tasks']
  const rows=await observer(tasks)
  expect(rows[0].status).toBe('idle')
  expect(rows[0].teammateId).toBe('inactive')
})

test('C17 actual teammate constructor persists launch provenance for the list consumer',async()=>{
  const {getDefaultAppState}=await import('../../state/AppStateStore.js')
  const {spawnInProcessTeammate}=await import('../../utils/swarm/spawnInProcess.js')
  let state=getDefaultAppState()
  const result=await spawnInProcessTeammate({name:'produced',teamName:'producer-parity',prompt:'Review',description:'Original spawn description',agentType:'Review',parentAgentId:'parent',planModeRequired:false,permissionMode:'default'}, {setAppState:update=>{state=update(state)},modSpawnedBy:'author'})
  expect(result.success).toBe(true)
  const task=Object.values(state.tasks).find(x=>x.type==='in_process_teammate')
  try{
    expect(task).toMatchObject({spawnedWith:{description:'Original spawn description',agentType:'Review',parentAgentId:'parent'},spawnedBy:'author'})
    const rows=await observer(state.tasks)
    expect(task?.type === 'in_process_teammate' ? task.identity.resumableAgentId : undefined).toMatch(/^aproduced-[0-9a-f]{16}$/)
    expect(rows[0]).toMatchObject({id:task?.type === 'in_process_teammate' ? task.identity.resumableAgentId : undefined,teammateId:'produced@producer-parity',description:'Original spawn description',type:'Review',parentId:'parent',spawnedBy:'author'})
  }finally{if(task?.type==='in_process_teammate'){task.unregisterCleanup?.();task.abortController?.abort()}}
})


test('C17 real Worker agent spec retains native declared settings in the production registry',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mods-agent-spec-parity-'));roots.push(root);const entry=join(root,'register.ts')
  await writeFile(entry,`export function register(on){on('session.start',async($,e,next)=>{await $.agent.register({name:'spec',description:'Review',prompt:'Review',permissionMode:'plan',hooks:{PreToolUse:[{hooks:[{type:'command',command:'true'}]}]},mcpServers:['fixture'],omitClaudeMd:true,background:true,isolation:'remote'});return next(e)})}`)
  const runtime=createModsRuntime();runtimes.push(runtime);await runtime.bind({cwd:'/tmp',surface:null,isInteractive:false,sessionId:'offline'});await runtime.reconcile([{name:'author',storageId:'author@test',pluginRoot:root,entrypoints:[entry]}])
  expect(runtime.agents.getSnapshot()[0]).toMatchObject({agentType:'author:spec',permissionMode:'plan',hooks:{PreToolUse:[{hooks:[{type:'command',command:'true'}]}]},mcpServers:['fixture'],omitClaudeMd:true,background:true,isolation:'remote'})
})


test('C17 public Worker spawn drops caller-private extras and rejects blank prompts',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mods-agent-public-parity-'));roots.push(root);const entry=join(root,'register.ts')
  await writeFile(entry,`export function register(on){on('command.run',async $=>{const out={};out.result=await $.agent.spawn({prompt:'one two three four five six',provider:{plugin:'forged',tier:'core'},isTeammate:true,parentAgentId:'forged',fork:true,unexpected:'ignored'});try{await $.agent.spawn({prompt:'   '});out.blank='accepted'}catch{out.blank='rejected'};return {text:JSON.stringify(out)}})}`)
  const inputs:unknown[]=[];const runtime=createModsRuntime({services:{agentSpawn:async input=>{inputs.push(input);return {model:'inherit',agentId:'real'}}}});runtimes.push(runtime)
  await runtime.bind({cwd:'/tmp',surface:null,isInteractive:false,sessionId:'offline'});await runtime.reconcile([{name:'author',storageId:'author@test',pluginRoot:root,entrypoints:[entry]}])
  const snapshot=runtime.capture();try{const out=JSON.parse((await snapshot.dispatch('command.run',{},async()=>({})) as {text:string}).text);expect(out).toEqual({result:{model:'inherit',agentId:'real'},blank:'rejected'});expect(inputs).toEqual([{prompt:'one two three four five six'}])}finally{snapshot.release()}
})

test('C17 public Worker register validates native short names and drops unknown fields before hooks',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mods-agent-register-parity-'));roots.push(root);const entry=join(root,'register.ts')
  await writeFile(entry,`export function register(on){on('command.run',async $=>{const outcomes=[];for(const name of ['space name','punctuation:bad','x'.repeat(65)]){try{await $.agent.register({name,description:'Review',prompt:'Review'});outcomes.push('accepted')}catch{outcomes.push('rejected')}};await $.agent.register({name:'valid',description:'Review',prompt:'Review',unexpected:'ignored'});return {text:JSON.stringify(outcomes)}});on('agent.register',($,e,next)=>{if(Object.hasOwn(e,'unexpected'))throw Error('Private extra leaked to hooks');return next(e)})}`)
  const diagnostics:unknown[]=[];const runtime=createModsRuntime({onDiagnostic:x=>diagnostics.push(x)});runtimes.push(runtime)
  await runtime.bind({cwd:'/tmp',surface:null,isInteractive:false,sessionId:'offline'});await runtime.reconcile([{name:'author',storageId:'author@test',pluginRoot:root,entrypoints:[entry]}])
  const snapshot=runtime.capture();try{expect(JSON.parse((await snapshot.dispatch('command.run',{},async()=>({})) as {text:string}).text)).toEqual(['rejected','rejected','rejected']);expect(diagnostics).toEqual([]);expect(runtime.agents.getSnapshot().map(x=>x.agentType)).toEqual(['author:valid'])}finally{snapshot.release()}
})


test('C17 inactive persisted membership applies only to matching live legacy teammate rows',async()=>{
  const name='inactive-agent-negative-'+Date.now()
  await writeTeamFileAsync(name,{name,createdAt:0,leadAgentId:'lead',members:[{agentId:'legacy',name:'legacy',joinedAt:0,tmuxPaneId:'none',cwd:'/tmp',subscriptions:[],isActive:false},{agentId:'local',name:'local',joinedAt:0,tmuxPaneId:'none',cwd:'/tmp',subscriptions:[],isActive:false},{agentId:'ended',name:'ended',joinedAt:0,tmuxPaneId:'none',cwd:'/tmp',subscriptions:[],isActive:false}]})
  const tasks={local:local('local','completed'),legacy:mate('legacy',{identity:{agentId:'legacy',agentName:'legacy',teamName:name}}),ended:mate('ended',{status:'completed',identity:{agentId:'ended',agentName:'ended',teamName:name}})} as unknown as AppState['tasks']
  const rows=await observer(tasks);expect(rows.map((x:{id:string;status:string})=>[x.id,x.status])).toEqual([['local','completed'],['legacy','idle'],['ended','completed']])
})

test('agent.list rows carry the AgentInfo fields of official 2.1.329', async () => {
  const { listModAgents } = await import('./agents.js')
  const { resetCostState } = await import('../../bootstrap/state.js')
  const { addToTotalSessionCost } = await import('../../cost-tracker.js')
  const { recordAgentRequest, resetAgentRequestsForTests } = await import('../../utils/agentLastRequest.js')
  resetCostState(); resetAgentRequestsForTests()
  const usage = {input_tokens:10,output_tokens:5,cache_read_input_tokens:4,cache_creation_input_tokens:0} as never
  addToTotalSessionCost(0.5, usage, 'claude-opus-5-5', {agentId:'worker', answeredModel:'claude-opus-5-5'})
  recordAgentRequest('worker', {at:1_234, model:'claude-opus-5-5', effort:'medium', usage:{cache_read_input_tokens:4}})
  const tasks = {
    worker: local('worker','running',{startTime:1_000,model:'claude-opus-5-5',cwd:'/work/tree',progress:{tokenCount:15,toolUseCount:0,summary:'Reading files'}}),
    parked: local('parked','completed',{startTime:2_000,isBackgrounded:true}),
    held: local('held','completed',{startTime:3_000,isBackgrounded:true,evictAfter:99_999}),
    mate: mate('mate',{startTime:4_000}),
  } as unknown as AppState['tasks']
  const rows = await listModAgents(tasks, new Map(), {cwd:'/session', now:1_100})
  const byId = Object.fromEntries(rows.map(row => [row.id, row]))
  expect(byId.worker).toEqual({id:'worker',description:'worker',type:'Explore',status:'running',kind:'local_agent',
    taskStatus:'running',label:'Reading files',startTime:1_000,cwd:'/work/tree',model:'claude-opus-5-5',contextWindowSize:expect.any(Number),
    tokenCount:15,tokenSamples:[15],lastRequest:{at:1_234,model:'claude-opus-5-5',effort:'medium'},
    usage:[{model:'claude-opus-5-5',input_tokens:10,output_tokens:5,cache_read_input_tokens:4,cache_creation_input_tokens:0}],cost:{usd:0.5},hasRow:true})
  expect([byId.parked.hasRow, byId.parked.cwd, byId.parked.cost]).toEqual([false, '/session', {usd:0}])
  expect(byId.held.hasRow).toBe(true)
  // A teammate with a logical id of its own has a ledger under it.
  expect(byId['logical-mate']).toMatchObject({teammateId:'mate', label:'Spawn description', cost:{usd:0}, hasRow:true})
  resetCostState(); resetAgentRequestsForTests()
})

test('a request that only read the cache keeps the lifetime of the last write', async () => {
  const { recordAgentRequest, getLastAgentRequest, resetAgentRequestsForTests } = await import('../../utils/agentLastRequest.js')
  resetAgentRequestsForTests()
  recordAgentRequest('a', {at:1, model:'m', usage:{cache_creation_input_tokens:8, cache_creation:{ephemeral_5m_input_tokens:0, ephemeral_1h_input_tokens:8}}})
  expect(getLastAgentRequest('a')).toEqual({at:1, model:'m', cacheTtl:'1h'})
  recordAgentRequest('a', {at:2, model:'m', effort:3, usage:{cache_read_input_tokens:8}})
  expect(getLastAgentRequest('a')).toEqual({at:2, model:'m', effort:3, cacheTtl:'1h'})
  recordAgentRequest('a', {at:3, model:'m', usage:{}})
  expect(getLastAgentRequest('a')).toEqual({at:3, model:'m'})
  resetAgentRequestsForTests()
})
