import { expect, test } from 'bun:test'
import { getMonitorPrompt } from './prompt.js'

test('Monitor prompt keeps its rules in a short description', () => {
  const prompt = getMonitorPrompt()

  for (const rule of [
    'use Bash with `run_in_background`',
    '`grep --line-buffered`',
    'Silence is not success',
    'Only stdout is the event stream',
    'Monitors that emit too much are stopped',
    're-arm it to keep watching',
    'TaskStop',
  ]) expect(prompt).toContain(rule)
  expect(prompt.length).toBeLessThan(2_400)
})
