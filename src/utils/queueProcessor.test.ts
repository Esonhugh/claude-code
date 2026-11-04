import { afterEach, expect, test } from 'bun:test'
import type { QueuedCommand } from '../types/textInputTypes.js'
import { QueryGuard } from './QueryGuard.js'
import { handlePromptSubmit } from './handlePromptSubmit.js'
import { clearCommandQueue, enqueue, getCommandQueueSnapshot } from './messageQueueManager.js'
import { processQueueIfReady } from './queueProcessor.js'

afterEach(() => clearCommandQueue())

function drain(): string[][] {
  const turns: string[][] = []
  let processed = true
  while (processed) {
    processed = processQueueIfReady({ executeInput: async cmds => { turns.push(cmds.map(c => String(c.value))) } }).processed
  }
  return turns
}

test('prompts queued during a turn go together', () => {
  enqueue({ value: 'A', mode: 'prompt' })
  enqueue({ value: 'B', mode: 'prompt' })
  expect(drain()).toEqual([['A', 'B']])
})

test('prompts queued behind /compact run as their own turns', () => {
  enqueue({ value: 'A', mode: 'prompt', runsAlone: true })
  enqueue({ value: 'B', mode: 'prompt', runsAlone: true })
  enqueue({ value: 'C', mode: 'prompt' })
  expect(drain()).toEqual([['A'], ['B'], ['C']])
})

test('a prompt submitted while a local command runs is queued to run alone', async () => {
  const queryGuard = new QueryGuard()
  queryGuard.reserve()
  await handlePromptSubmit({
    input: 'after compact',
    mode: 'prompt',
    queryGuard,
    commands: [],
    messages: [],
  } as unknown as Parameters<typeof handlePromptSubmit>[0])
  const queued = getCommandQueueSnapshot() as QueuedCommand[]
  expect(queued.map(c => [c.value, c.runsAlone, c.admitted])).toEqual([['after compact', true, undefined]])
})
