import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const modules = Object.fromEntries(Object.entries({
  boot: '../../bootstrap/state.ts', config: '../../utils/config.ts', app: '../../state/AppStateStore.ts',
  tool: '../../Tool.ts', files: '../../utils/fileStateCache.ts', messages: '../../utils/messages.ts',
  agent: './AgentTool.tsx', runner: './runAgent.ts', definition: './built-in/generalPurposeAgent.ts', pins: '../../utils/sendMessagePins.ts',
}).map(([key, path]) => [key, new URL(path, import.meta.url).href]))
const source = `
import assert from 'node:assert/strict'
import {mock} from 'bun:test'
const m=JSON.parse(process.env.PIN_NAME_MODULES)
const boot=await import(m.boot);boot.setOriginalCwd(process.cwd());boot.setProjectRoot(process.cwd());boot.setIsInteractive(true)
const {enableConfigs}=await import(m.config);enableConfigs()
const {createAssistantMessage}=await import(m.messages)
mock.module(m.runner,()=>({async *runAgent(){yield createAssistantMessage({content:'SYNC-NAME-REPORT'})}}))
const {getDefaultAppState}=await import(m.app),{getEmptyToolPermissionContext}=await import(m.tool),{createFileStateCacheWithSizeLimit}=await import(m.files),{GENERAL_PURPOSE_AGENT}=await import(m.definition)
let state={...getDefaultAppState(),toolPermissionContext:getEmptyToolPermissionContext()}
const write=update=>{state=update(state)}
const context={options:{commands:[],debug:false,mainLoopModel:'claude-sonnet-4-6',tools:[],verbose:false,thinkingConfig:{type:'disabled'},mcpClients:[],mcpResources:{},isNonInteractiveSession:true,agentDefinitions:{activeAgents:[{...GENERAL_PURPOSE_AGENT,background:false}],inactiveAgents:[]}},messages:[],abortController:new AbortController(),readFileState:createFileStateCacheWithSizeLimit(10),getAppState:()=>state,setAppState:()=>{},setAppStateForTasks:write,getAppStateForTasks:()=>state,setInProgressToolUseIDs:()=>{},setResponseLength:()=>{},updateFileHistoryState:()=>{},updateAttributionState:()=>{}}
const {AgentTool}=await import(m.agent)
const result=await AgentTool.call({name:'sync-name',prompt:'complete',description:'sync named worker',subagent_type:'general-purpose',run_in_background:false},context,async()=>({behavior:'allow'}),{message:{id:'msg_parent'}})
assert.equal(result.data.status,'completed')
assert.equal(state.agentNameRegistry.get('sync-name'),result.data.agentId)
const {resolveSubagentRecipient}=await import(m.pins)
assert.equal(resolveSubagentRecipient(state,'sync-name').recipient.id,result.data.agentId)
assert.equal(state.runningSubagents,0)
console.log('sync name remains addressable after completion')
`
for (const disabled of ['0', '1']) test('completed synchronous Agent registers its name, background disabled='+disabled, async () => {
  const dir=await realpath(await mkdtemp(join(tmpdir(),'agent-pin-name-')))
  const child=Bun.spawn([process.execPath,'--no-env-file','--eval',source],{cwd:dir,env:{PATH:process.env.PATH,HOME:dir,CLAUDE_CONFIG_DIR:join(dir,'config'),TMPDIR:dir,ANTHROPIC_API_KEY:'owned-pin-name-dummy',DISABLE_TELEMETRY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:disabled,CLAUDE_CODE_FORK_SUBAGENT:'0',PIN_NAME_MODULES:JSON.stringify(modules)},stdout:'pipe',stderr:'pipe'})
  try {const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(exit,out+err).toBe(0)}finally{if(child.exitCode===null){child.kill();await child.exited}await rm(dir,{recursive:true,force:true})}
})
