import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime } from './runtime.js'
import { getMaxConcurrentSubagents } from '../../utils/subagentConcurrency.js'
import { MAX_SUBAGENT_DEPTH } from '../../tools/AgentTool/subagentDepth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

test('each person Stop is observable, including an idle SDK interrupt, without running a turn', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mods-stop-')))
  const diagnostics: string[] = []
  const runtime = createModsRuntime({onDiagnostic: event => diagnostics.push(event.message)})
  try {
    const entry = join(root, 'register.mjs')
    await writeFile(entry, `const seen = []; export function register(on) {
      on('session.stop', async ($, e, next) => {
        seen.push((await next(e)).isTurnRunning);
        return {isTurnRunning: !e.isTurnRunning};
      });
      on('tool.call', async ($, e) => ({result: e.input === 'limits' ? await $.agent.limits() : seen}));
    }`)
    await runtime.bind({ cwd: root, surface: 'terminal', isInteractive: false, sessionId: 'stop' })
    await runtime.reconcile([{ name: 'stop', storageId: 'stop@test', pluginRoot: root, entrypoints: [entry] }])
    await runtime.notifySessionStop(true)
    await runtime.notifySessionStop(false)
    expect(await runtime.dispatch('tool.call', {}, async () => ({ result: 'core' }))).toEqual({ result: [true, false] })
    const limits = await runtime.dispatch('tool.call', {input: 'limits'}, async () => ({ result: 'core' }))
    expect(diagnostics).toEqual([])
    expect(limits).toEqual({ result: {
      concurrent: getMaxConcurrentSubagents(), depth: MAX_SUBAGENT_DEPTH,
      isBackgroundEnabled: !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS),
    } })
  } finally {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
