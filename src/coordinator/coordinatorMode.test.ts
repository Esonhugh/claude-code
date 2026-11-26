import { expect, test } from 'bun:test'

const modules = {
  bootstrap: new URL('../bootstrap/state.ts', import.meta.url).href,
  coordinator: new URL('./coordinatorMode.ts', import.meta.url).href,
  worker: new URL('./workerAgent.ts', import.meta.url).href,
}

// feature('COORDINATOR_MODE') is a build-time flag, so run in a child with it on.
const source = `
import assert from 'node:assert/strict'
const m=JSON.parse(process.env.COORD_MODULES)
const boot=await import(m.bootstrap),{isCoordinatorMode,matchSessionMode,getCoordinatorUserContext}=await import(m.coordinator),{getWorkerSystemPrompt}=await import(m.worker)
const reset=(interactive,env)=>{boot.setIsInteractive(interactive);delete process.env.CLAUDE_CODE_COORDINATOR_MODE;delete process.env.CLAUDE_CODE_REMOTE;Object.assign(process.env,env)}
reset(false,{});assert.equal(isCoordinatorMode(),false)
reset(false,{CLAUDE_CODE_COORDINATOR_MODE:'1'});assert.equal(isCoordinatorMode(),true)
reset(true,{CLAUDE_CODE_COORDINATOR_MODE:'1'});assert.equal(isCoordinatorMode(),false)
reset(true,{CLAUDE_CODE_COORDINATOR_MODE:'1',CLAUDE_CODE_REMOTE:'1'});assert.equal(isCoordinatorMode(),true)
reset(true,{});assert.equal(matchSessionMode('coordinator'),undefined);assert.equal(process.env.CLAUDE_CODE_COORDINATOR_MODE,undefined)
reset(false,{});assert.equal(matchSessionMode('coordinator'),'Entered coordinator mode to match resumed session.');assert.equal(isCoordinatorMode(),true)
reset(false,{CLAUDE_CODE_COORDINATOR_MODE:'1'});assert.equal(matchSessionMode('normal'),'Exited coordinator mode to match resumed session.');assert.equal(isCoordinatorMode(),false)
// Workers are told about the Agent tool only when they may nest below themselves.
reset(false,{CLAUDE_CODE_COORDINATOR_MODE:'1'});assert.match(getCoordinatorUserContext([]).workerToolsContext,/tools: Agent, Bash, /);assert.match(getWorkerSystemPrompt(),/you may use it to fan out/)
process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH='1';assert.match(getCoordinatorUserContext([]).workerToolsContext,/tools: Bash, /);assert.doesNotMatch(getWorkerSystemPrompt(),/fan out/)
`

test('coordinator mode runs only in headless or remote sessions, like official', async () => {
  const child = Bun.spawn([process.execPath, '--feature', 'COORDINATOR_MODE', '--no-env-file', '--eval', source], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, COORD_MODULES: JSON.stringify(modules) },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(code, stdout + stderr).toBe(0)
})

test('coordinator keeps Skill, ListAgents and Workflow like official', async () => {
  const { applyCoordinatorToolFilter } = await import('../utils/toolPool.js')
  const tools = ['Agent', 'Bash', 'Goal', 'ListAgents', 'Read', 'SendMessage', 'Skill', 'TaskStop', 'Workflow'].map(name => ({ name }))
  expect(applyCoordinatorToolFilter(tools as never).map(t => t.name)).toEqual(['Agent', 'Goal', 'ListAgents', 'SendMessage', 'Skill', 'TaskStop', 'Workflow'])
})

test('coordinator prompt lists Workflow, Skill and peers only when those tools are present', async () => {
  const { getCoordinatorSystemPrompt } = await import('./coordinatorMode.js')
  const bare = getCoordinatorSystemPrompt(['Agent', 'SendMessage', 'TaskStop'])
  expect(bare).not.toContain('- **Skill**')
  expect(bare).not.toContain('- **Workflow**')
  expect(bare).not.toContain('- **ListAgents / SendMessage**')

  const full = getCoordinatorSystemPrompt(['Agent', 'ListAgents', 'SendMessage', 'Skill', 'TaskStop', 'Workflow'])
  expect(full).toContain('- **TaskStop** - Stop a running worker\n- **Workflow** (if available) - Run a multi-step subagent pipeline')
  expect(full).toContain("calls when a matching workflow exists\n- **Skill** - Load a skill's full instructions inline (read-only")
  expect(full).toContain('call the `mcp__claude-code-remote__` one.\n- **ListAgents / SendMessage** (cross-session, if ListAgents is available)')
  expect(full).toContain('a peer requested.\n\nWhen calling Agent:')
})

test('coordinator adds brief tools under CLAUDE_CODE_BRIEF and named extras from CLAUDE_CODE_COORDINATOR_EXTRA_TOOLS', async () => {
  const { applyCoordinatorToolFilter } = await import('../utils/toolPool.js')
  const tools = [{ name: 'Agent' }, { name: 'Bash' }, { name: 'Read', aliases: ['ReadFile'] }, { name: 'SendUserFile' }, { name: 'SendUserMessage' }, { name: 'mcp__srv__ping' }]
  const saved = { brief: process.env.CLAUDE_CODE_BRIEF, extra: process.env.CLAUDE_CODE_COORDINATOR_EXTRA_TOOLS }
  try {
    delete process.env.CLAUDE_CODE_BRIEF
    delete process.env.CLAUDE_CODE_COORDINATOR_EXTRA_TOOLS
    expect(applyCoordinatorToolFilter(tools as never).map(t => t.name)).toEqual(['Agent'])
    process.env.CLAUDE_CODE_BRIEF = '1'
    process.env.CLAUDE_CODE_COORDINATOR_EXTRA_TOOLS = ' ReadFile , mcp__srv__ping,'
    expect(applyCoordinatorToolFilter(tools as never).map(t => t.name)).toEqual(['Agent', 'Read', 'SendUserFile', 'SendUserMessage', 'mcp__srv__ping'])
  } finally {
    for (const [key, value] of [['CLAUDE_CODE_BRIEF', saved.brief], ['CLAUDE_CODE_COORDINATOR_EXTRA_TOOLS', saved.extra]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('coordinator prompt tells it to leave the worker model alone when the session forces inheritance', async () => {
  const { getCoordinatorSystemPrompt } = await import('./coordinatorMode.js')
  const saved = process.env.CLAUDE_CODE_COORDINATOR_FORCE_WORKER_INHERIT_MODEL
  try {
    delete process.env.CLAUDE_CODE_COORDINATOR_FORCE_WORKER_INHERIT_MODEL
    expect(getCoordinatorSystemPrompt([])).toContain('- Omit the model parameter so workers inherit the session model')
    process.env.CLAUDE_CODE_COORDINATOR_FORCE_WORKER_INHERIT_MODEL = '1'
    const forced = getCoordinatorSystemPrompt([])
    expect(forced).toContain('- The model parameter is ignored on this session. Do not set it.')
    expect(forced).not.toContain('Omit the model parameter')
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_COORDINATOR_FORCE_WORKER_INHERIT_MODEL
    else process.env.CLAUDE_CODE_COORDINATOR_FORCE_WORKER_INHERIT_MODEL = saved
  }
})
