import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Keep process-wide module mocks and skill discovery state inside owned child processes.
// The latest official skill worker does not reserve ordinary Agent capacity.
const childSource = [
  "import assert from 'node:assert/strict'",
  "import { mock } from 'bun:test'",
  'const {setOriginalCwd,setProjectRoot,setCwdState}=await import(' + JSON.stringify(new URL('../../bootstrap/state.ts', import.meta.url).href) + ')',
  'const {enableConfigs}=await import(' + JSON.stringify(new URL('../config.ts', import.meta.url).href) + ')',
  'setOriginalCwd(process.cwd());setProjectRoot(process.cwd());setCwdState(process.cwd());enableConfigs()',
  'const {getDefaultAppState}=await import(' + JSON.stringify(new URL('../../state/AppStateStore.ts', import.meta.url).href) + ')',
  'const {getEmptyToolPermissionContext}=await import(' + JSON.stringify(new URL('../../Tool.ts', import.meta.url).href) + ')',
  'const {GENERAL_PURPOSE_AGENT}=await import(' + JSON.stringify(new URL('../../tools/AgentTool/built-in/generalPurposeAgent.ts', import.meta.url).href) + ')',
  'const {createAssistantMessage}=await import(' + JSON.stringify(new URL('../messages.ts', import.meta.url).href) + ')',
  "const scenario=process.env.FORK_CONCURRENCY_CASE;const failure=scenario.endsWith('failure');const identityOnly=scenario==='identity';const viaSkill=scenario.startsWith('skill')",
  'let state={...getDefaultAppState(),runningSubagents:1,toolPermissionContext:getEmptyToolPermissionContext()};let executions=0;let publications=0;let runtimeId;let progressIds=[];let counts=[]',
  'mock.module(' + JSON.stringify(new URL('../../tools/AgentTool/runAgent.ts', import.meta.url).href) + ",()=>({async *runAgent(options){executions++;counts.push(state.runningSubagents);runtimeId=options.override?.agentId;if(failure)throw new Error('fork stream failed');yield createAssistantMessage({content:[{type:'tool_use',id:'fork-read',name:'Read',input:{file_path:'probe.txt'}}]});yield createAssistantMessage({content:'fork finished'})}}))",
  'mock.module(' + JSON.stringify(new URL('../../tools/AgentTool/UI.tsx', import.meta.url).href) + ',()=>({renderToolUseProgressMessage(messages){progressIds.push(...messages.map(m=>m.data.agentId));return null}}))',
  'const {processSlashCommand}=await import(' + JSON.stringify(new URL('./processSlashCommand.tsx', import.meta.url).href) + ')',
  "const command={name:'fork-counter',type:'prompt',description:'probe',progressMessage:'probe',contentLength:0,source:'builtin',context:'fork',background:false,async getPromptForCommand(){return [{type:'text',text:'probe'}]}}",
  "const context={options:{commands:[command],tools:[],isNonInteractiveSession:false,mainLoopModel:'claude-sonnet-4-6',agentDefinitions:{activeAgents:[GENERAL_PURPOSE_AGENT]}},messages:[],abortController:new AbortController(),getAppState:()=>state,setAppState:fn=>{publications++;state=fn(state)},setResponseLength:()=>{}}",
  'const {assertSubagentCapacity}=await import(' + JSON.stringify(new URL('../subagentConcurrency.ts', import.meta.url).href) + ')',
  "assert.throws(()=>assertSubagentCapacity(context),{name:'AgentPreconditionError'});let result",
  'if(viaSkill){state={...state,mcp:{...state.mcp,commands:[{...command,source:"mcp",loadedFrom:"mcp"}]}};const {SkillTool}=await import('+JSON.stringify(new URL("../../tools/SkillTool/SkillTool.ts",import.meta.url).href)+');let error;try{result=await SkillTool.call({skill:"fork-counter"},context,async()=>({behavior:"allow"}),createAssistantMessage({content:"invoke skill"}),progress=>progressIds.push(progress.data.agentId))}catch(caught){error=caught}if(failure){assert.match(String(error),/fork stream failed/)}else{assert.equal(error,undefined);assert.equal(result.data.status,"forked");assert.equal(result.data.agentId,runtimeId);assert.match(result.data.result,/fork finished/)}}else{result=await processSlashCommand("/fork-counter",[],[],[],context,()=>{},undefined,undefined,async()=>({behavior:"allow"}));assert.match(JSON.stringify(result.messages),failure?/fork stream failed/:/fork finished/)}',
  'assert.equal(executions,1);assert.equal(state.runningSubagents,1);if(!identityOnly){assert.deepEqual(counts,[1]);assert.equal(publications,0)}',
  'if(!failure){assert.ok(runtimeId);assert.ok(progressIds.length>0);assert.ok(progressIds.every(id=>id===runtimeId))}',
  "assert.throws(()=>assertSubagentCapacity(context),{name:'AgentPreconditionError'})",
].join('\n')

for (const scenario of ['success', 'failure', 'identity', 'skill-success', 'skill-failure']) {
  test('forked command preserves existing capacity and uses its progress identity: ' + scenario, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'fork-concurrency-')))
    const child = Bun.spawn([process.execPath, '--no-env-file', '--eval', childSource], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'config'), XDG_CONFIG_HOME: join(directory, 'xdg'), XDG_CACHE_HOME: join(directory, 'cache'), TMPDIR: directory, ANTHROPIC_API_KEY: 'owned-fork-concurrency-dummy', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '1', FORK_CONCURRENCY_CASE: scenario },
      stdout: 'pipe', stderr: 'pipe',
    })
    try {
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(exitCode, stdout + stderr).toBe(0)
    } finally {
      if (child.exitCode === null) { child.kill(); await child.exited }
      await rm(directory, { recursive: true, force: true })
    }
  })
}
