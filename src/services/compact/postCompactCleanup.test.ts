import { afterEach, expect, spyOn, test } from 'bun:test'
import * as classifierApprovals from '../../utils/classifierApprovals.js'
import * as betaTracing from '../../utils/telemetry/betaSessionTracing.js'
import * as microCompact from './microCompact.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'

const spies = () => [
  spyOn(microCompact, 'resetMicrocompactState'),
  spyOn(classifierApprovals, 'clearClassifierApprovals'),
  spyOn(betaTracing, 'clearBetaTracingState'),
]
let made: ReturnType<typeof spies> = []

afterEach(() => {
  for (const spy of made.splice(0)) spy.mockRestore()
})

test('subagent compaction leaves the main thread microcompact, classifier and tracing state', () => {
  made = spies()
  runPostCompactCleanup('agent:general-purpose', 'a1')
  runPostCompactCleanup('hook_agent')
  for (const spy of made) expect(spy).not.toHaveBeenCalled()
})

test('main compaction resets them', () => {
  made = spies()
  runPostCompactCleanup('repl_main_thread')
  for (const spy of made) expect(spy).toHaveBeenCalledTimes(1)
})
