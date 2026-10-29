import { expect, test } from 'bun:test'

const modules = {
  bootstrap: new URL('../bootstrap/state.ts', import.meta.url).href,
  coordinator: new URL('./coordinatorMode.ts', import.meta.url).href,
}

// feature('COORDINATOR_MODE') is a build-time flag, so run in a child with it on.
const source = `
import assert from 'node:assert/strict'
const m=JSON.parse(process.env.COORD_MODULES)
const boot=await import(m.bootstrap),{isCoordinatorMode,matchSessionMode}=await import(m.coordinator)
const reset=(interactive,env)=>{boot.setIsInteractive(interactive);delete process.env.CLAUDE_CODE_COORDINATOR_MODE;delete process.env.CLAUDE_CODE_REMOTE;Object.assign(process.env,env)}
reset(false,{});assert.equal(isCoordinatorMode(),false)
reset(false,{CLAUDE_CODE_COORDINATOR_MODE:'1'});assert.equal(isCoordinatorMode(),true)
reset(true,{CLAUDE_CODE_COORDINATOR_MODE:'1'});assert.equal(isCoordinatorMode(),false)
reset(true,{CLAUDE_CODE_COORDINATOR_MODE:'1',CLAUDE_CODE_REMOTE:'1'});assert.equal(isCoordinatorMode(),true)
reset(true,{});assert.equal(matchSessionMode('coordinator'),undefined);assert.equal(process.env.CLAUDE_CODE_COORDINATOR_MODE,undefined)
reset(false,{});assert.equal(matchSessionMode('coordinator'),'Entered coordinator mode to match resumed session.');assert.equal(isCoordinatorMode(),true)
reset(false,{CLAUDE_CODE_COORDINATOR_MODE:'1'});assert.equal(matchSessionMode('normal'),'Exited coordinator mode to match resumed session.');assert.equal(isCoordinatorMode(),false)
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
