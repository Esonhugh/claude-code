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

test('a waking poll event starts a turn as an empty prompt; one that does not wake waits', () => {
  const executed: QueuedCommand[][] = []
  const executeInput = async (cmds: QueuedCommand[]) => void executed.push(cmds)
  const event = (wake: boolean, startsTurn?: false): QueuedCommand => ({
    value: '<event/>',
    mode: 'poll-event',
    priority: wake ? 'next' : 'later',
    isMeta: true,
    pollEvent: { kind: 'repl-eval', envelope: '<event/>', nonce: 'n', wake, ...(startsTurn === false && { startsTurn }), timestamp: '' },
  })
  enqueue(event(false))
  enqueue(event(true, false))
  expect(processQueueIfReady({ executeInput }).processed).toBe(false)
  enqueue(event(true))
  expect(processQueueIfReady({ executeInput }).processed).toBe(true)
  expect(executed).toEqual([[{ value: [], mode: 'prompt', isMeta: true, pollEmptyDispatch: true, skipSubmissionHooks: true }]])
  // The events stay queued for the turn's first request to fold in.
  expect(getCommandQueueSnapshot()).toHaveLength(3)
  // Still the head after its dispatch: the turn did not take it, so no second one.
  expect(processQueueIfReady({ executeInput }).processed).toBe(false)
  // A prompt queued beside the events goes as itself.
  enqueue({ value: 'A', mode: 'prompt' })
  expect(processQueueIfReady({ executeInput }).processed).toBe(true)
  expect(executed[1]!.map(c => c.value)).toEqual(['A'])
})
