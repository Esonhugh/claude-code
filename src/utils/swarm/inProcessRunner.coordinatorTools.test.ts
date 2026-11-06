import { expect, test } from 'bun:test'

const modules = {
  bootstrap: new URL('../../bootstrap/state.ts', import.meta.url).href,
  appState: new URL('../../state/AppStateStore.ts', import.meta.url).href,
  runner: new URL('./inProcessRunner.ts', import.meta.url).href,
}

// feature('COORDINATOR_MODE') is a build-time flag, so run in a child with it on.
const source = `
import assert from 'node:assert/strict'
const m=JSON.parse(process.env.COORD_MODULES)
const boot=await import(m.bootstrap),{getDefaultAppState}=await import(m.appState),{getTeammateBaseTools}=await import(m.runner)
boot.setIsInteractive(false)
const leaderTools=['Agent','SendMessage','Skill','TaskStop'].map(name=>({name}))
const context={options:{tools:leaderTools},getAppState:()=>getDefaultAppState()}
assert.equal(getTeammateBaseTools(context),leaderTools)
process.env.CLAUDE_CODE_COORDINATOR_MODE='1'
const names=getTeammateBaseTools(context).map(t=>t.name)
for (const name of ['Bash','Read','Edit','SendMessage']) assert.ok(names.includes(name),name+' missing: '+names.join(','))
`

test("a coordinator's teammate gets the worker tool pool, not the coordinator's", async () => {
  const child = Bun.spawn([process.execPath, '--feature', 'COORDINATOR_MODE', '--no-env-file', '--eval', source], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', COORD_MODULES: JSON.stringify(modules) },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(code, stdout + stderr).toBe(0)
}, 30_000)
