import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const modules = Object.fromEntries(Object.entries({
  command: './index.ts', call: './subtask.tsx',
  bootstrap: '../../bootstrap/state.ts', config: '../../utils/config.ts',
  app: '../../state/AppStateStore.ts', tool: '../../Tool.ts',
  files: '../../utils/fileStateCache.ts', messages: '../../utils/messages.ts',
  runner: '../../tools/AgentTool/runAgent.ts', slash: '../../utils/processUserInput/processSlashCommand.tsx',
  launcher: '../../utils/conversationFork.ts',
  coordinator: '../../coordinator/coordinatorMode.ts', model: '../../utils/model/agent.ts',
  agents: '../../services/mods/agents.ts', storage: '../../utils/sessionStorage.ts', resume: '../../tools/AgentTool/resumeAgent.ts',
}).map(([key, path]) => [key, new URL(path, import.meta.url).href]))

const source = `
import assert from 'node:assert/strict'
import {mock} from 'bun:test'
const m=JSON.parse(process.env.FORK_COMMAND_MODULES),variant=process.env.FORK_COMMAND_VARIANT
const boot=await import(m.bootstrap);boot.setOriginalCwd(process.cwd());boot.setProjectRoot(process.cwd());boot.setIsInteractive(variant!=='headless')
const {enableConfigs}=await import(m.config);enableConfigs()
if(variant==='coordinator'){const original=await import(m.coordinator);mock.module(m.coordinator,()=>({...original,isCoordinatorMode:()=>true}))}
const {default:command}=await import(m.command)
assert.equal(command.type,'local-jsx');assert.equal(command.argumentHint,'<task>');assert.equal(command.isEnabled(),variant!=='headless')
const {getDefaultAppState}=await import(m.app),{getEmptyToolPermissionContext}=await import(m.tool)
const {createUserMessage,createAssistantMessage}=await import(m.messages),{createFileStateCacheWithSizeLimit}=await import(m.files)
const {getAgentModel}=await import(m.model)
const executions=[],started=Promise.withResolvers(),finish=Promise.withResolvers()
mock.module(m.runner,()=>({async *runAgent(params){executions.push({...params,effectiveModel:params.resolvedModel??getAgentModel(params.agentDefinition.model,params.toolUseContext.options.mainLoopModel,params.model,params.permissionMode)});started.resolve();await finish.promise;if(variant==='failure')throw new Error('controlled slash fork failure');yield createAssistantMessage({content:'FORK-COMMAND-DONE'})}}))
let state={...getDefaultAppState(),toolPermissionContext:getEmptyToolPermissionContext(),runningSubagents:1}
const rootSet=fn=>{state=fn(state)},permit=async()=>({behavior:'allow'})
const context={options:{commands:[command],debug:false,mainLoopModel:'claude-sonnet-4-6',tools:[],verbose:false,thinkingConfig:{type:'disabled'},mcpClients:[],mcpResources:{},isNonInteractiveSession:variant==='headless',agentDefinitions:{activeAgents:[],inactiveAgents:[]}},messages:[createUserMessage({content:'INHERITED-PARENT'})],renderedSystemPrompt:['PARENT-SYSTEM'],abortController:new AbortController(),readFileState:createFileStateCacheWithSizeLimit(20),getAppState:()=>state,setAppState:()=>{},getAppStateForTasks:()=>state,setAppStateForTasks:rootSet,setResponseLength:()=>{},setInProgressToolUseIDs:()=>{},updateFileHistoryState:()=>{},updateAttributionState:()=>{},setMessages:()=>{}}
const {processSlashCommand}=await import(m.slash)
const run=input=>processSlashCommand(input,[],[],[],context,()=>{},undefined,undefined,permit)
const usage=await run('/subtask   ');assert.equal(usage.shouldQuery,false);assert.equal(usage.resultText,'Usage: /subtask \\\\<task\\\\>');assert.equal(executions.length,0)
if(variant==='coordinator'){
 process.env.CLAUDE_CODE_COORDINATOR_MODE='1';const {call}=await import(m.call);let output;assert.equal(await call(text=>{output=text},context,'directive'),null);assert.equal(output,'Subtasks are not available in coordinator sessions. Use /branch instead.');assert.equal(executions.length,0)
}else if(variant==='headless'){
 assert.equal(command.isEnabled(),false)
}else{
 const result=await run('/subtask   Review THE files   ');assert.equal(result.shouldQuery,false);assert.match(result.resultText,/^\u2442 forked review-the-files \\(....\\)$/)
 await started.promise;assert.equal(executions.length,1);const p=executions[0],id=p.override.agentId
 assert.match(id,/^areview-the-files-[0-9a-f]{16}$/);assert.equal(state.agentNameRegistry.get('review-the-files'),id);assert.equal(state.tasks[id].status,'running');assert.equal(state.tasks[id].isBackgrounded,true);assert.equal(state.runningSubagents,2)
 assert.equal(p.forkContextMessages,context.messages);assert.equal(p.override.systemPrompt,context.renderedSystemPrompt);assert.equal(p.resolvedModel,'claude-sonnet-4-6');assert.equal(p.useExactTools,true);assert.equal(p.availableTools,context.options.tools);assert.equal(p.querySource,'agent:builtin:fork');assert.equal(p.isAsync,true);assert.equal(p.spawnDepth,1);assert.equal(p.canUseTool,permit)
 assert.notEqual(p.override.abortController,context.abortController);context.abortController.abort('interrupt');assert.equal(p.override.abortController.signal.aborted,false)
 finish.resolve();for(let i=0;i<100&&state.tasks[id].status==='running';i++)await Bun.sleep(5)
 assert.equal(state.tasks[id].status,variant==='failure'?'failed':'completed');assert.equal(state.runningSubagents,1)
 if(variant!=='failure'){
  const {listModAgents}=await import(m.agents)
  for(const [patch,names,expected] of [[{},state.agentNameRegistry,'idle'],[{keepaliveReasons:new Set(['flag:idle-window'])},state.agentNameRegistry,'idle'],[{keepaliveReasons:new Set(['agent:child'])},state.agentNameRegistry,'waiting'],[{finalizing:true},state.agentNameRegistry,'running'],[{},new Map(),'completed']]){
   const tasks={...state.tasks,[id]:{...state.tasks[id],...patch}};assert.equal((await listModAgents(tasks,names)).find(a=>a.id===id).status,expected)
  }
 }
 const {launchConversationFork}=await import(m.launcher);context.abortController=new AbortController()
 const second=await launchConversationFork('Review THE files',context,permit);assert.equal(second.name,'review-the-files-2');assert.notEqual(second.agentId,id)
 for(let i=0;i<100&&state.tasks[second.agentId].status==='running';i++)await Bun.sleep(5)
 assert.equal(state.tasks[second.agentId].status,variant==='failure'?'failed':'completed');assert.equal(state.runningSubagents,1)
 if(variant!=='failure'){
  const storage=await import(m.storage);await storage.recordSidechainTranscript([...context.messages,createAssistantMessage({content:'ORIGINAL-FORK-DONE'})],id);await storage.flushSessionStorage();await storage.writeAgentMetadata(id,{agentType:'fork',model:context.options.mainLoopModel,name:'review-the-files',description:'Review THE files',spawnDepth:1})
  const {resumeAgentBackground}=await import(m.resume);await resumeAgentBackground({agentId:id,prompt:'FOLLOW-UP',toolUseContext:context,canUseTool:permit})
  for(let i=0;i<100&&executions.length<3;i++)await Bun.sleep(5);assert.equal(executions.length,3);assert.equal(executions[2].effectiveModel,context.options.mainLoopModel)
  for(let i=0;i<100&&state.tasks[id].status==='running';i++)await Bun.sleep(5);assert.equal(state.tasks[id].status,'completed');assert.equal(state.runningSubagents,1)
 }
}
`

for (const variant of ['default', 'off', 'coordinator', 'headless', 'failure']) {
  test('conversation fork command: ' + variant, async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'fork-command-')))
    const child = Bun.spawn([process.execPath, '--no-env-file', '--eval', source], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir, CLAUDE_CONFIG_DIR: join(dir, 'config'), TMPDIR: dir,
        ANTHROPIC_API_KEY: 'owned-fork-command-dummy', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_SUBAGENT_MODEL: 'haiku', CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '1',
        ...(variant === 'off' ? { CLAUDE_CODE_FORK_SUBAGENT: '0', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' } : {}),
        FORK_COMMAND_MODULES: JSON.stringify(modules), FORK_COMMAND_VARIANT: variant },
      stdout: 'pipe', stderr: 'pipe',
    })
    try {
      const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(exit, out + err).toBe(0)
    } finally {
      if (child.exitCode === null) { child.kill(); await child.exited }
      await rm(dir, { recursive: true, force: true })
    }
  })
}
