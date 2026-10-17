import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const modules = Object.fromEntries(Object.entries({
  bootstrap: '../../bootstrap/state.ts', config: '../../utils/config.ts', app: '../../state/AppStateStore.ts',
  tool: '../../Tool.ts', files: '../../utils/fileStateCache.ts', messages: '../../utils/messages.ts',
  runner: '../AgentTool/runAgent.ts', storage: '../../utils/sessionStorage.ts', sender: './SendMessageTool.ts',
  tasks: '../../tasks/LocalAgentTask/LocalAgentTask.tsx', stop: '../../tasks/stopTask.ts',
}).map(([key, path]) => [key, new URL(path, import.meta.url).href]))

const source = `
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
const m=JSON.parse(process.env.CANCEL_MODULES), variant=process.env.CANCEL_VARIANT
const boot=await import(m.bootstrap);boot.setOriginalCwd(process.cwd());boot.setProjectRoot(process.cwd());boot.setIsInteractive(true)
const {enableConfigs}=await import(m.config);enableConfigs()
const {getDefaultAppState}=await import(m.app),{getEmptyToolPermissionContext}=await import(m.tool)
const {createUserMessage,createAssistantMessage}=await import(m.messages),{createFileStateCacheWithSizeLimit}=await import(m.files)
const executions=[]
mock.module(m.runner,()=>({async *runAgent(params){executions.push(params);yield createAssistantMessage({content:'NORMAL-RESUME-REPORT'})}}))
const storage=await import(m.storage),tasks=await import(m.tasks)
const id='acancel-probe-0123456789abcdef',name='cancel-probe'
let state={...getDefaultAppState(),toolPermissionContext:getEmptyToolPermissionContext()}
const set=fn=>{state=fn(state)},permit=async()=>({behavior:'allow'})
const context={options:{commands:[],debug:false,mainLoopModel:'claude-sonnet-4-6',tools:[],verbose:false,thinkingConfig:{type:'disabled'},mcpClients:[],mcpResources:{},isNonInteractiveSession:false,agentDefinitions:{activeAgents:[],inactiveAgents:[]}},messages:[createUserMessage({content:'PARENT'})],renderedSystemPrompt:['SYSTEM'],abortController:new AbortController(),readFileState:createFileStateCacheWithSizeLimit(20),getAppState:()=>state,setAppState:set,getAppStateForTasks:()=>state,setAppStateForTasks:set,setResponseLength:()=>{},setInProgressToolUseIDs:()=>{},updateFileHistoryState:()=>{},updateAttributionState:()=>{},setMessages:()=>{}}
await storage.recordSidechainTranscript([createUserMessage({content:'ORIGINAL'}),createAssistantMessage({content:'ORIGINAL-REPORT'})],id)
await storage.flushSessionStorage();await storage.writeAgentMetadata(id,{agentType:'fork',name,model:'claude-sonnet-4-6',description:'cancel fixture',spawnDepth:1})
state.agentNameRegistry.set(name,id)
tasks.registerAsyncAgent({agentId:id,description:'cancel fixture',prompt:'ORIGINAL',selectedAgent:{agentType:'fork',source:'built-in',whenToUse:'fixture',getSystemPrompt:()=>['SYSTEM']},setAppState:set,spawnDepth:1,abortController:new AbortController()})
let pendingReply
if(variant==='race'){
 set(s=>({...s,tasks:{...s.tasks,[id]:{...s.tasks[id],status:'completed',keepaliveReasons:new Set(['agent:pending'])}}}))
 const entered=Promise.withResolvers(),release=Promise.withResolvers(),read=storage.getAgentTranscript
 mock.module(m.storage,()=>({...storage,async getAgentTranscript(agentId){entered.resolve();await release.promise;return read(agentId)}}))
 const {SendMessageTool}=await import(m.sender)
 pendingReply=SendMessageTool.call({to:name,message:'FOLLOW-UP'},context,permit,undefined)
 await entered.promise
 tasks.killAsyncAgent(id,set,'user');await storage.readAgentMetadata(id);release.resolve()
}else if(variant==='model-stop'||variant==='sdk-stop'){
 const {stopTask}=await import(m.stop);await stopTask(id,{getAppState:()=>state,setAppState:set,source:variant==='sdk-stop'?'user':'model'})
}else if(variant==='bulk-user')tasks.killAllRunningAgentTasks(state.tasks,set)
else if(variant==='completed'||variant==='failed')set(s=>({...s,tasks:{...s.tasks,[id]:{...s.tasks[id],status:variant}}}))
else tasks.killAsyncAgent(id,set,variant==='system-kill'?'system':'user')
const cancelled=!['model-stop','system-kill','completed','failed'].includes(variant)
assert.equal(state.tasks[id].stoppedByUser===true,cancelled,'stop source must be retained independently of killed status')
const saved=await storage.readAgentMetadata(id)
assert.equal(saved.stoppedByUser===true,cancelled,'durable stop flag')
assert.equal(saved.name,name);assert.equal(saved.model,'claude-sonnet-4-6');assert.equal(saved.spawnDepth,1)
if(variant==='sticky-write'){
 await storage.writeAgentMetadata(id,{agentType:'fork',name,model:'claude-sonnet-4-6',spawnDepth:2})
 assert.equal((await storage.readAgentMetadata(id)).stoppedByUser,true,'a later metadata write must not lose cancellation')
}
if(variant==='cold'){set(s=>({...s,tasks:{}}))}
const target=variant==='raw'?id:name
const {SendMessageTool}=await import(m.sender)
const reply=await (pendingReply??SendMessageTool.call({to:target,message:'FOLLOW-UP'},context,permit,undefined))
if(cancelled){
 const message=['cold','race'].includes(variant)?'Agent '+id+" was stopped by the user and won't be resumed. Treat its work as cancelled; only launch a new agent if the user explicitly asks.":'Agent "'+target+'" was stopped by the user and was not resumed. Treat its work as cancelled; only start a new agent for it if the user explicitly asks.'
 assert.deepEqual(reply.data,{success:false,message})
 assert.equal(executions.length,0);assert.equal(state.runningSubagents,0)
 if(variant!=='cold'){assert.equal(state.tasks[id].status,'killed');assert.deepEqual(state.tasks[id].pendingMessages,[])}
}else{
 assert.equal(reply.data.success,true);assert.equal(executions.length,1);assert.equal(state.tasks[id].status,'completed');assert.equal(state.runningSubagents,0)
 assert.equal(reply.data.inlineHandback.content[0].text,'NORMAL-RESUME-REPORT')
}
console.log('owned cancellation fixture passed '+variant)
`

for (const variant of ['user','raw','cold','race','sdk-stop','bulk-user','sticky-write','model-stop','system-kill','completed','failed']) {
  test('SendMessage respects the stop source and persisted cancellation: '+variant, async () => {
    const dir=await realpath(await mkdtemp(join(tmpdir(),'send-cancel-')))
    const child=Bun.spawn([process.execPath,'--no-env-file','--eval',source],{
      cwd:dir,env:{PATH:process.env.PATH,HOME:dir,CLAUDE_CONFIG_DIR:join(dir,'config'),TMPDIR:dir,
        ANTHROPIC_API_KEY:'owned-cancel-dummy',DISABLE_TELEMETRY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:'1',CANCEL_MODULES:JSON.stringify(modules),CANCEL_VARIANT:variant},stdout:'pipe',stderr:'pipe',
    })
    try {
      const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()])
      expect(exit,out+err).toBe(0)
    } finally { if(child.exitCode===null){child.kill();await child.exited}await rm(dir,{recursive:true,force:true}) }
  })
}
