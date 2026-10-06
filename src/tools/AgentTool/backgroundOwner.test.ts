import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Each process owns its task registry, command queue and persistence/config roots.
const childSource = [
  "import assert from 'node:assert/strict'",
  'const {enableConfigs}=await import('+JSON.stringify(new URL('../../utils/config.ts',import.meta.url).href)+');enableConfigs()',
  'const {getDefaultAppState}=await import('+JSON.stringify(new URL('../../state/AppStateStore.ts',import.meta.url).href)+')',
  'const {getEmptyToolPermissionContext}=await import('+JSON.stringify(new URL('../../Tool.ts',import.meta.url).href)+')',
  'const {GENERAL_PURPOSE_AGENT}=await import('+JSON.stringify(new URL('./built-in/generalPurposeAgent.ts',import.meta.url).href)+')',
  'const tasks=await import('+JSON.stringify(new URL('../../tasks/LocalAgentTask/LocalAgentTask.tsx',import.meta.url).href)+')',
  'const {runAsyncAgentLifecycle}=await import('+JSON.stringify(new URL('./agentToolUtils.ts',import.meta.url).href)+')',
  'const {createAssistantMessage}=await import('+JSON.stringify(new URL('../../utils/messages.ts',import.meta.url).href)+')',
  'const {getCommandQueue}=await import('+JSON.stringify(new URL('../../utils/messageQueueManager.ts',import.meta.url).href)+')',
  'const {takeSubagentConcurrencySlot}=await import('+JSON.stringify(new URL('../../utils/subagentConcurrency.ts',import.meta.url).href)+')',
  "const scenario=process.env.OWNER_CASE;let state={...getDefaultAppState(),toolPermissionContext:getEmptyToolPermissionContext()};const set=fn=>{state=fn(state)};const context={getAppState:()=>state,getAppStateForTasks:()=>state,setAppState:set,setAppStateForTasks:set,abortController:new AbortController(),options:{tools:[]}}",
  "const add=(id,owner)=>tasks.registerAsyncAgent({agentId:id,description:id,prompt:id,selectedAgent:GENERAL_PURPOSE_AGENT,setAppState:set,parentAgentId:owner,ownerAgentId:owner,spawnDepth:owner?2:1})",
  "add('aparent');add('achild','aparent');if(scenario==='multiple')add('asecond','aparent');let resumed=0;let resumedPrompts=[];let cleanups=0;const rootNotifications=()=>getCommandQueue().filter(c=>c.mode==='task-notification'&&c.agentId===undefined)",
  "const result=id=>({agentId:id,content:[{type:'text',text:'child-result'}],totalDurationMs:1,totalTokens:1,totalToolUseCount:0})",
  "const finishChild=id=>{tasks.completeAgentTask(result(id),set);tasks.enqueueAgentNotification({taskId:id,description:id,status:'completed',finalMessage:'child-result',setAppState:set})}",
  "const tick=async()=>{for(let i=0;i<10;i++)await new Promise(r=>setTimeout(r,0))}",
  "const resume=async prompt=>{resumed++;resumedPrompts.push(prompt);if(scenario==='resume-failure')throw new Error('controlled resume failure');const released=takeSubagentConcurrencySlot(context);add('aparent');await lifecycle('after-child',released)}",
  "const lifecycle=(answer,onRunSettled)=>runAsyncAgentLifecycle({taskId:'aparent',abortController:state.tasks.aparent.abortController,makeStream:async function*(){yield createAssistantMessage({content:answer})},metadata:{prompt:'parent',resolvedAgentModel:'claude-haiku-4-5-20251001',startTime:Date.now(),agentType:'general-purpose',isBuiltInAgent:true,isAsync:true},description:'aparent',toolUseContext:context,rootSetAppState:set,agentIdForCleanup:'aparent',enableSummarization:false,getWorktreeResult:async()=>{cleanups++;return {}},onRunSettled,resume})",
  "if(scenario==='ownership'){assert.ok(state.tasks.aparent.keepaliveReasons?.has('agent:achild'))}",
  "else if(scenario==='route'){set(s=>({...s,tasks:{...s.tasks,aparent:{...s.tasks.aparent,status:'completed',keepaliveReasons:new Set(['agent:achild'])}}}));finishChild('achild');await tick();assert.equal(rootNotifications().length,0);assert.equal(getCommandQueue()[0].agentId,'aparent')}",
  "else if(scenario==='list'){const {listModAgents}=await import("+JSON.stringify(new URL('../../services/mods/agents.ts',import.meta.url).href)+");assert.equal((await listModAgents(state.tasks)).find(t=>t.id==='aparent').status,'running');await lifecycle('before-child',takeSubagentConcurrencySlot(context));assert.equal((await listModAgents(state.tasks)).find(t=>t.id==='aparent').status,'waiting');finishChild('achild');await tick();assert.equal((await listModAgents(state.tasks)).find(t=>t.id==='aparent').status,'completed')}",
  "else if(scenario==='stop'){await lifecycle('before-child',takeSubagentConcurrencySlot(context));const {TaskStopTool}=await import("+JSON.stringify(new URL('../TaskStopTool/TaskStopTool.ts',import.meta.url).href)+");assert.equal((await TaskStopTool.validateInput({task_id:'aparent'},context)).result,true);const stopped=await TaskStopTool.call({task_id:'aparent'},context);assert.equal(stopped.data.task_id,'aparent');await tick();assert.equal(state.tasks.aparent.status,'killed');assert.equal(cleanups,1);assert.equal(rootNotifications().length,1);assert.match(String(rootNotifications()[0].value),/<usage>/);assert.match(String(rootNotifications()[0].value),/before-child/);finishChild('achild');await tick();assert.equal(resumed,0)}",
  "else if(scenario==='resume-failure'){await lifecycle('before-child',takeSubagentConcurrencySlot(context));finishChild('achild');await tick();assert.equal(resumed,1);assert.equal(state.tasks.aparent.status,'failed');assert.equal(cleanups,1);assert.equal(state.runningSubagents,0);assert.equal(rootNotifications().length,2);const failureNote=rootNotifications().find(c=>String(c.value).includes('controlled resume failure'));assert.ok(failureNote);assert.match(String(failureNote.value),/<usage>/);assert.match(String(failureNote.value),/before-child/);assert.equal(state.tasks.aparent.notified,true)}",
  "else if(scenario==='lineage'){add('alineage');set(s=>({...s,tasks:{...s.tasks,achild:{...s.tasks.achild,parentAgentId:'alineage'}}}));finishChild('achild');await tick();assert.equal(rootNotifications().length,0);assert.equal(getCommandQueue()[0].agentId,'aparent');assert.equal(getCommandQueue()[0].taskId,'achild')}",
  "else if(scenario==='kill'){set(s=>({...s,tasks:{...s.tasks,aparent:{...s.tasks.aparent,status:'completed',keepaliveReasons:new Set(['agent:achild'])}}}));tasks.killAsyncAgent('aparent',set);assert.equal(state.tasks.aparent.status,'killed')}",
  "else {if(scenario==='early')finishChild('achild');const release=takeSubagentConcurrencySlot(context);await lifecycle('before-child',release);await tick();if(scenario!=='early'){assert.equal(state.tasks.aparent.status,'completed');assert.equal(state.tasks.aparent.notified,false);assert.equal(rootNotifications().length,0);assert.equal(cleanups,0);assert.equal(state.runningSubagents,0);if(scenario==='cancel'){tasks.killAsyncAgent('aparent',set)}finishChild('achild');await tick()}assert.equal(resumed,scenario==='cancel'?0:1);if(scenario==='multiple'){assert.ok(state.tasks.aparent.keepaliveReasons.has('agent:asecond'));assert.equal(rootNotifications().length,0);finishChild('asecond');await tick();assert.equal(resumed,2)}if(scenario!=='cancel'){assert.equal(state.runningSubagents,0);assert.equal(state.tasks.aparent.notified,true);assert.equal(rootNotifications().length,1);assert.match(String(rootNotifications()[0].value),/after-child/);assert.equal(cleanups,1);assert.ok(resumedPrompts.every(p=>p.includes('<task-notification>')))}}",
].join('\n')

for (const scenario of ['ownership','route','kill','late','early','multiple','cancel','list','stop','resume-failure','lineage']) {
  test('background owner lifecycle: '+scenario, async () => {
    const directory=await realpath(await mkdtemp(join(tmpdir(),'agent-owner-')))
    const child=Bun.spawn([process.execPath,'--no-env-file','--eval',childSource],{cwd:directory,env:{PATH:process.env.PATH,HOME:directory,CLAUDE_CONFIG_DIR:join(directory,'config'),XDG_CONFIG_HOME:join(directory,'xdg'),XDG_CACHE_HOME:join(directory,'cache'),TMPDIR:directory,DISABLE_TELEMETRY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',OWNER_CASE:scenario},stdout:'pipe',stderr:'pipe'})
    try {
      const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()])
      expect(code,stdout+stderr).toBe(0)
    } finally {
      if(child.exitCode===null){child.kill();await child.exited}
      await rm(directory,{recursive:true,force:true})
    }
  })
}
