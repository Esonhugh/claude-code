import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childSource = `
  import assert from 'node:assert/strict'
  const { z } = await import(${JSON.stringify(import.meta.resolve('zod/v4'))})
  const state = await import(${JSON.stringify(new URL('../../bootstrap/state.ts', import.meta.url).href)})
  const { enableConfigs } = await import(${JSON.stringify(new URL('../../utils/config.ts', import.meta.url).href)})
  state.setOriginalCwd(process.cwd())
  enableConfigs()
  const { getDefaultAppState } = await import(${JSON.stringify(new URL('../../state/AppStateStore.ts', import.meta.url).href)})
  const { createModToolHost } = await import(${JSON.stringify(new URL('./toolHost.ts', import.meta.url).href)})
  const scenario = JSON.parse(process.env.MODS_AUTHOR_GATE_CASE)
  const observed = { calls: 0, permissions: 0, hooks: 0 }
  const tool = {
    name: scenario.name === 'Task' ? 'Agent' : scenario.name,
    aliases: scenario.name === 'Task' ? ['Task'] : [],
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ value: z.string() }),
    maxResultSizeChars: Infinity,
    isConcurrencySafe: () => true,
    checkPermissions: async () => ({ behavior: 'ask', message: 'Confirm fixture' }),
    call: async input => { observed.calls++; return { data: input } },
    mapToolResultToToolResultBlockParam: (data, id) => ({ type: 'tool_result', tool_use_id: id, content: 'mapped:' + data.value }),
  }
  let app = getDefaultAppState()
  const context = {
    options: { tools: scenario.available ? [tool] : [], mcpClients: [], isNonInteractiveSession: true },
    abortController: new AbortController(), messages: [],
    getAppState: () => app,
    setAppState: updater => { app = typeof updater === 'function' ? updater(app) : updater },
    setInProgressToolUseIDs: () => {},
  }
  const snapshot = {
    hasHooks: () => true,
    dispatch: async (_event, input, core) => { observed.hooks++; return core(input) },
    release: () => { throw new Error('host must not release the borrowed snapshot') },
  }
  const host = createModToolHost(context, async () => { observed.permissions++; return { behavior: 'allow' } })
  if (scenario.reason) {
    await assert.rejects(host.call({ tool: scenario.name, value: 'probe' }, snapshot, new AbortController().signal, 'author'),
      { message: 'author: tool.call: ' + scenario.reason + ' (host check)' })
    assert.deepEqual(observed, { calls: 0, permissions: 0, hooks: 0 })
  } else {
    const result = await host.call({ tool: scenario.name, value: 'probe' }, snapshot, new AbortController().signal, 'author')
    assert.equal(result.text, 'mapped:probe')
    assert.deepEqual(result.result, { value: 'probe' })
    assert.equal(observed.calls, 1)
    assert.equal(observed.permissions, 1)
    assert.ok(observed.hooks > 0)
  }
`

const reasons = [
  ['Agent', 'runs the Agent tool: that is $.agent.spawn'],
  ['Task', 'runs the Agent tool: that is $.agent.spawn'],
  ['AskUserQuestion', 'runs the AskUserQuestion tool: that is $.ui.ask'],
  ['Workflow', 'runs the Workflow tool, whose agents run outside the at-once bound on spawns: $.agent.spawn is the door'],
  ['WorkflowTool', 'runs the Workflow tool, whose agents run outside the at-once bound on spawns: $.agent.spawn is the door'],
] as const

for (const scenario of [
  ...reasons.flatMap(([name, reason]) => (name === 'Task' ? [true] : [true, false]).map(available => ({ name, reason, available }))),
  { name: 'AuthorFixture', available: true, reason: undefined },
]) {
  test(`author tool.call gate: ${scenario.name}, available=${scenario.available}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mods-author-gate-')))
    try {
      const child = Bun.spawn([process.execPath, '--eval', childSource], {
        cwd: root,
        env: {
          PATH: process.env.PATH, HOME: root, TMPDIR: root,
          CLAUDE_CONFIG_DIR: join(root, 'config'), NODE_ENV: 'production',
          ANTHROPIC_API_KEY: 'mods-author-gate-unused-key',
          MODS_AUTHOR_GATE_CASE: JSON.stringify(scenario),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
          DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
      expect(code).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
