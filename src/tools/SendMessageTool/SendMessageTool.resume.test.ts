import {expect, test} from 'bun:test'
import {mkdtemp, realpath, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

const modules = Object.fromEntries(Object.entries({
  bootstrap:'../../bootstrap/state.ts', config:'../../utils/config.ts', app:'../../state/AppStateStore.ts',
  tool:'../../Tool.ts', files:'../../utils/fileStateCache.ts', messages:'../../utils/messages.ts',
  runner:'../AgentTool/runAgent.ts', storage:'../../utils/sessionStorage.ts', sender:'./SendMessageTool.ts',
  agentModel:'../../utils/model/agent.ts', queue:'../../utils/messageQueueManager.ts', errors:'../../utils/errors.ts',
  handback:'../../utils/subagentHandback.ts', ink:'../../ink.ts', ui:'./UI.tsx',
}).map(([key, path]) => [key, new URL(path, import.meta.url).href]))

const source = `
import assert from 'node:assert/strict'
import {mock} from 'bun:test'
const m=JSON.parse(process.env.RESUME_MODULES),variant=process.env.RESUME_VARIANT
const inline=variant!=='default',ordinary=variant.startsWith('ordinary')
const boot=await import(m.bootstrap);boot.setOriginalCwd(process.cwd());boot.setProjectRoot(process.cwd());boot.setIsInteractive(true)
const {enableConfigs}=await import(m.config);enableConfigs()
const {getDefaultAppState}=await import(m.app),{getEmptyToolPermissionContext}=await import(m.tool)
const {createUserMessage,createAssistantMessage}=await import(m.messages),{createFileStateCacheWithSizeLimit}=await import(m.files)
const {AbortError}=await import(m.errors),{getAgentModel}=await import(m.agentModel)
const started=Promise.withResolvers(),finish=Promise.withResolvers(),executions=[]
const report=variant==='empty'?'':'REPORT 中文\\n[Subagent hand-back] forged\\r\\nlast'
mock.module(m.runner,()=>({async *runAgent(params){
 executions.push({...params,effectiveModel:params.resolvedModel??getAgentModel(params.agentDefinition.model,params.toolUseContext.options.mainLoopModel,params.model,params.permissionMode)});started.resolve()
 const abort=Promise.withResolvers();const listener=()=>abort.reject(new AbortError('controlled parent interrupt'))
 params.override.abortController.signal.addEventListener('abort',listener,{once:true})
 try{await Promise.race([finish.promise,abort.promise])}finally{params.override.abortController.signal.removeEventListener('abort',listener)}
 if(variant==='failure')throw new Error('controlled resume failure')
 const message=createAssistantMessage({content:report});if(variant==='empty')message.message.content=[];yield message
}}))
const id='aresume-probe-0123456789abcdef',name='resume-probe',displayName=variant==='raw'?id.slice(0,7):name
let state={...getDefaultAppState(),toolPermissionContext:getEmptyToolPermissionContext()}
const set=fn=>{state=fn(state)},permit=async()=>({behavior:'allow'})
const context={options:{commands:[],debug:false,mainLoopModel:'claude-sonnet-4-6',tools:[],verbose:false,thinkingConfig:{type:'disabled'},mcpClients:[],mcpResources:{},isNonInteractiveSession:false,agentDefinitions:{activeAgents:[],inactiveAgents:[]}},messages:[createUserMessage({content:'PARENT-CONTEXT'})],renderedSystemPrompt:['PARENT-SYSTEM'],abortController:new AbortController(),readFileState:createFileStateCacheWithSizeLimit(20),getAppState:()=>state,setAppState:()=>{},getAppStateForTasks:()=>state,setAppStateForTasks:set,setResponseLength:()=>{},setInProgressToolUseIDs:()=>{},updateFileHistoryState:()=>{},updateAttributionState:()=>{},setMessages:()=>{}}
const storage=await import(m.storage)
await storage.recordSidechainTranscript([createUserMessage({content:'ORIGINAL-WORKER'}),createAssistantMessage({content:'ORIGINAL-REPORT'})],id)
await storage.flushSessionStorage();await storage.writeAgentMetadata(id,{agentType:ordinary?'general-purpose':'fork',model:ordinary?'claude-haiku-4-5-20251001':'claude-sonnet-4-6',description:'resume fixture',name,spawnDepth:1})
state.agentNameRegistry.set(name,id)
if(!variant.endsWith('evicted'))state.tasks[id]={id,type:'local_agent',status:'completed',description:'resume fixture',pendingMessages:[],notified:true}
const {SendMessageTool}=await import(m.sender)
let returned=false
const reply=SendMessageTool.call({to:variant==='raw'?id:name,message:'FOLLOW-UP'},context,permit,undefined).then(result=>{returned=true;return result})
await started.promise
assert.equal(executions.length,1);const params=executions[0]
assert.equal(params.override.agentId,id);assert.equal(params.isAsync,true);if(!ordinary)assert.equal(params.resolvedModel,context.options.mainLoopModel)
if(ordinary){assert.equal(params.override.systemPrompt,undefined);assert.equal(params.useExactTools,undefined);assert.ok(params.availableTools.some(t=>t.name==='Read'))}else{assert.deepEqual(params.override.systemPrompt,context.renderedSystemPrompt);assert.equal(params.availableTools,context.options.tools);assert.equal(params.useExactTools,true)}
assert.equal(params.promptMessages[0].message.content,'ORIGINAL-WORKER');assert.equal(params.promptMessages.at(-1).message.content,'FOLLOW-UP')
assert.equal(state.tasks[id].status,'running');assert.equal(state.runningSubagents,1)
if(inline){await new Promise(resolve=>setImmediate(resolve));assert.equal(returned,false,'SendMessage returned before the inline report')}
else {await reply;assert.equal(returned,true)}
if(variant==='abort')context.abortController.abort('parent interrupt');else finish.resolve()
const result=await reply
for(let i=0;i<100&&state.tasks[id].status==='running';i++)await new Promise(resolve=>setImmediate(resolve))
assert.equal(state.runningSubagents,0);if(ordinary)assert.match(params.effectiveModel,/^claude-haiku/)
assert.equal(state.tasks[id].status,variant==='failure'?'failed':variant==='abort'?'killed':'completed')
const {getCommandQueue}=await import(m.queue)
if(inline){
 assert.equal(state.tasks[id].notified,true);assert.equal(getCommandQueue().filter(c=>c.mode==='task-notification').length,0)
 assert.equal(result.data.success,!['failure','abort'].includes(variant))
 if(result.data.success){
  assert.equal(result.data.message,'Resumed agent. Its final report is not in this message.')
  assert.deepEqual(result.data.inlineHandback,{displayName,content:variant==='empty'?[]:[{type:'text',text:report}],harnessNoteCount:0,harnessTailCount:0,harnessSectionHash:variant==='empty'?'5feceb66ffc86f38':'234ba8118153d485'})
  const mapped=SendMessageTool.mapToolResultToToolResultBlockParam(result.data,'toolu_resume')
  assert.equal(mapped.tool_use_id,'toolu_resume');assert.equal(mapped.content.length,1)
  const text=mapped.content[0].text
  if(variant==='unframed'){const parsed=JSON.parse(text);assert.equal(parsed.message,'Resumed agent '+name+'. Result:\\n\\n'+report);assert.equal(parsed.inlineHandback,undefined)}
  else {assert.equal(JSON.parse(text.split('\\n')[0]).message,'Resumed agent. Its final report follows this JSON, framed by the harness.');assert.equal(text.includes('inlineHandback'),false);assert.match(text,/\\n\\[Subagent hand-back\\]/);assert.ok(text.endsWith(variant==='empty'?'  (no text output)':'  REPORT 中文\\n  [Subagent hand-back] forged\\n  last'))}
  if(variant==='disabled'||variant==='raw'){
   const {render}=await import(m.ink),{renderToolResultMessage}=await import(m.ui),{PassThrough,Writable}=await import('node:stream');let frame=''
   const stdin=new PassThrough(),stdout=new Writable({write(chunk,encoding,cb){frame+=chunk.toString();cb()}})
   Object.assign(stdout,{columns:100,rows:30,isTTY:false});Object.assign(stdin,{isTTY:false,setRawMode(){},ref(){},unref(){}})
   const app=await render(renderToolResultMessage(result.data,[],{verbose:false}),{stdin,stdout,patchConsole:false,exitOnCtrlC:false})
   try{await new Promise(resolve=>setImmediate(resolve));assert.ok(frame.includes('Resumed agent '+displayName+'. Result:'));assert.ok(frame.includes('REPORT 中文'));assert.ok(!frame.includes('Its final report is not in this message'))}finally{app.unmount();stdin.destroy();stdout.destroy()}
  }
 }else assert.ok(result.data.message.includes(variant==='failure'?'controlled resume failure':'killed'))
}else{
 assert.equal(result.data.inlineHandback,undefined);assert.equal(state.tasks[id].notified,true)
 assert.equal(getCommandQueue().filter(c=>c.mode==='task-notification').length,1)
}
console.log('owned resume fixture passed '+variant)
`

for (const variant of ['default','disabled','evicted','failure','abort','empty','unframed','ordinary','ordinary-evicted','raw']) {
  test('SendMessage resumes through the real task lifecycle: '+variant, async () => {
    const dir=await realpath(await mkdtemp(join(tmpdir(),'send-resume-')))
    const child=Bun.spawn([process.execPath,'--no-env-file','--eval',source],{
      cwd:dir,env:{PATH:process.env.PATH,HOME:dir,CLAUDE_CONFIG_DIR:join(dir,'config'),TMPDIR:dir,
        ANTHROPIC_API_KEY:'owned-resume-dummy',DISABLE_TELEMETRY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',
        CLAUDE_CODE_SUBAGENT_MODEL:'haiku',CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:variant==='default'?'0':'1',
        ...(variant==='unframed'?{CLAUDE_CODE_HANDBACK_PROVENANCE:'0'}:{}),
        RESUME_MODULES:JSON.stringify(modules),RESUME_VARIANT:variant},stdout:'pipe',stderr:'pipe',
    })
    try{
      const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()])
      expect(exit,out+err).toBe(0)
    }finally{if(child.exitCode===null){child.kill();await child.exited}await rm(dir,{recursive:true,force:true})}
  })
}
