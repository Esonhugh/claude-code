import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childSource = [
  "import assert from 'node:assert/strict'",
  "import { mock } from 'bun:test'",
  'const {setOriginalCwd}=await import(' + JSON.stringify(new URL('../../bootstrap/state.ts', import.meta.url).href) + ')',
  'const {enableConfigs}=await import(' + JSON.stringify(new URL('../config.ts', import.meta.url).href) + ')',
  'setOriginalCwd(process.cwd());enableConfigs()',
  'const {getDefaultAppState}=await import(' + JSON.stringify(new URL('../../state/AppStateStore.ts', import.meta.url).href) + ')',
  'const {getEmptyToolPermissionContext}=await import(' + JSON.stringify(new URL('../../Tool.ts', import.meta.url).href) + ')',
  'const {GENERAL_PURPOSE_AGENT}=await import(' + JSON.stringify(new URL('../../tools/AgentTool/built-in/generalPurposeAgent.ts', import.meta.url).href) + ')',
  'const {createAssistantMessage}=await import(' + JSON.stringify(new URL('../messages.ts', import.meta.url).href) + ')',
  "const failure=process.env.FORK_CONCURRENCY_CASE==='failure'",
  'let state={...getDefaultAppState(),runningSubagents:1,toolPermissionContext:getEmptyToolPermissionContext()};let executions=0',
  'mock.module(' + JSON.stringify(new URL('../../tools/AgentTool/runAgent.ts', import.meta.url).href) + ",()=>({async *runAgent(){executions++;assert.equal(state.runningSubagents,2);if(failure)throw new Error('fork stream failed');yield createAssistantMessage({content:'fork finished'})}}))",
  'const {processSlashCommand}=await import(' + JSON.stringify(new URL('./processSlashCommand.tsx', import.meta.url).href) + ')',
  "const command={name:'fork-counter',type:'prompt',description:'probe',progressMessage:'probe',contentLength:0,source:'builtin',context:'fork',async getPromptForCommand(){return [{type:'text',text:'probe'}]}}",
  "const context={options:{commands:[command],tools:[],isNonInteractiveSession:false,mainLoopModel:'claude-sonnet-4-6',agentDefinitions:{activeAgents:[GENERAL_PURPOSE_AGENT]}},messages:[],abortController:new AbortController(),getAppState:()=>state,setAppState:fn=>{state=fn(state)},setResponseLength:()=>{}}",
  "const result=await processSlashCommand('/fork-counter',[],[],[],context,()=>{},undefined,undefined,async()=>({behavior:'allow'}))",
  'assert.equal(executions,1);assert.equal(state.runningSubagents,1)',
  "assert.match(JSON.stringify(result.messages),failure?/fork stream failed/:/fork finished/)",
].join('\n')

for (const scenario of ['success', 'failure']) {
  test('forked command reserves without a new-launch guard and releases: ' + scenario, async () => {
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
