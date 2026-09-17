import { describe, expect, test } from 'bun:test'
import {
  runModPromptSubmit,
  type PromptSubmitDispatchOptions,
  type PromptSubmitInput,
} from './promptAdapter.js'
import type { ModInput } from './types.js'

const initial: PromptSubmitInput = {
  text: 'original',
  origin: { kind: 'plugin', name: 'fixture' },
  wait: true,
  turnId: 'running-turn',
  attachments: [
    { type: 'image', mediaType: 'image/png', filename: 'image.png' },
  ],
}

// This is the adapter/runtime boundary contract, NOT another dispatcher.
// Real dispatch traversal is covered by processUserInput.mods.test.ts.
async function inspectContract(
  check: (
    options: PromptSubmitDispatchOptions,
    input: ModInput,
    core: (input: ModInput) => Promise<unknown>,
  ) => Promise<unknown>,
) {
  const entries: PromptSubmitInput[] = []
  const result = await runModPromptSubmit({
    input: initial,
    signal: new AbortController().signal,
    snapshot: {
      hasHooks: () => true,
      release: () => {},
      dispatch: async (_event, input, core, options) =>
        check(options as PromptSubmitDispatchOptions, input, core),
    },
    core: async input => {
      entries.push(input)
      return { shouldQuery: true, messages: [] }
    },
  })
  return { ...result, entries }
}

describe('prompt.submit runtime boundary contract', () => {
  test.each([
    ['string', 'not an array'],
    ['sparse', Array(2)],
    ['empty entry', ['']],
    ['nontext entry', [123]],
    ['32001 chars', ['x'.repeat(16000), 'y'.repeat(16001)]],
  ])(
    'rejects %s context before entering downstream',
    async (_name, context) => {
      const result = await inspectContract(async (options, input) => {
        expect(() =>
          options.validateInput({ ...input, context }, input),
        ).toThrow('prompt.submit context')
        return { drop: 'invalid next was rejected' }
      })
      expect(result.entries).toEqual([])
    },
  )

  test('accepts 32000 characters and empty context array without truncation', async () => {
    await inspectContract(async (options, input, core) => {
      options.validateInput({ ...input, context: [] }, input)
      const next = {
        ...input,
        context: ['a'.repeat(16000), 'b'.repeat(16000)],
      }
      options.validateInput(next, input)
      const result: any = await core(next)
      expect(result.context).toEqual(next.context)
      return result
    })
  })

  test.each([
    { context: undefined },
    { context: [] },
    { context: ['duplicate'] },
  ])('cannot delete received duplicate context: %j', async ({ context }) => {
    const result = await inspectContract(async (options, input) => {
      const received = { ...input, context: ['duplicate', 'duplicate'] }
      expect(() =>
        options.validateInput({ ...received, context }, received),
      ).toThrow('cannot remove received context')
      return { drop: 'rejected before next' }
    })
    expect(result.entries).toEqual([])
  })

  test('allows reordering and adding context while retaining its multiset', async () => {
    await inspectContract(async (options, input, core) => {
      const received = { ...input, context: ['one', 'two', 'one'] }
      const next = { ...input, context: ['two', 'one', 'extra', 'one'] }
      options.validateInput(next, received)
      const result = await core(next)
      options.validateResult!(result, [])
      return result
    })
  })

  test.each([
    ['origin', { kind: 'composer' }],
    ['origin', { kind: 'plugin', name: 'another-plugin' }],
    ['attachments', []],
    [
      'attachments',
      [{ type: 'image', mediaType: 'image/jpeg', filename: 'image.png' }],
    ],
    ['turnId', 'another-turn'],
    ['turnId', undefined],
    ['wait', false],
  ])('pins %s down every next', async (key, value) => {
    const result = await inspectContract(async (options, input) => {
      expect(() =>
        options.validateInput({ ...input, [key]: value }, input),
      ).toThrow(`cannot rewrite ${key}`)
      return { drop: 'rejected' }
    })
    expect(result.entries).toEqual([])
  })

  test('restores omitted pinned fields at each continuation boundary', async () => {
    await inspectContract(async (options, input, core) => {
      const rewritten = options.restoreInput({ text: 'rewritten' }, input)
      expect(rewritten).toEqual({
        text: 'rewritten',
        origin: initial.origin,
        wait: true,
        turnId: 'running-turn',
        attachments: initial.attachments,
      })
      options.validateInput(rewritten, input)
      return core(rewritten)
    })
  })

  test('pins against an immutable initial snapshot, not the hook-mutated object', async () => {
    await inspectContract(async (options, input) => {
      ;(input.origin as { name: string }).name = 'forged'
      expect(() => options.validateInput(input, input)).toThrow(
        'cannot rewrite origin',
      )
      return { drop: 'rejected' }
    })
    expect(initial.origin).toEqual({ kind: 'plugin', name: 'fixture' })
  })

  test('result may omit origin but cannot forge one', async () => {
    await inspectContract(async (options, input, core) => {
      const below = await core(input)
      expect(() =>
        options.validateResult!({ text: input.text }, [below]),
      ).not.toThrow()
      expect(() =>
        options.validateResult!(
          { text: input.text, origin: { kind: 'composer' } },
          [below],
        ),
      ).toThrow('cannot set another origin')
      return below
    })
  })

  test('result validation uses second argument and retains duplicates', async () => {
    await inspectContract(async (options, input, core) => {
      const below = await core({ ...input, context: ['same', 'same'] })
      expect(() =>
        options.validateResult!({ text: input.text, context: ['same'] }, [
          below,
        ]),
      ).toThrow('cannot remove received context')
      return below
    })
  })

  test('post-next edits of an in-place mutated receipt cannot modify the submitted snapshot', async () => {
    const result = await inspectContract(async (options, input, core) => {
      const below: any = await core({ ...input, context: ['entered'] })
      below.context.push('late')
      expect(() => options.validateResult!(below, [below])).toThrow(
        'after next',
      )
      return below
    })
    expect(result.entries[0]?.context).toEqual(['entered'])
  })

  test('retains the settled core drop even if middleware reports success', async () => {
    const result = await runModPromptSubmit({
      input: initial,
      signal: new AbortController().signal,
      snapshot: {
        hasHooks: () => true,
        release: () => {},
        dispatch: async (_event, input, core) => {
          expect(await core(input)).toEqual({ drop: 'blocked by core' })
          return { text: 'synthetic success' }
        },
      },
      core: async () => ({ messages: [], shouldQuery: false, resultText: 'blocked by core' }),
    })
    expect(result.submissions[0]?.admission).toEqual({ drop: 'blocked by core' })
  })

  test('admission completes before the receipt unwinds through middleware', async () => {
    let admitted = false
    const result = await runModPromptSubmit({
      input: initial,
      signal: new AbortController().signal,
      snapshot: {
        hasHooks: () => true,
        release: () => {},
        dispatch: async (_event, input, core) => {
          const receipt = await core(input)
          expect(admitted).toBe(true)
          return receipt
        },
      },
      core: async () => ({ messages: [], shouldQuery: true }),
      admit: result => {
        expect(result.admission).toEqual({ text: initial.text, origin: initial.origin })
        admitted = true
      },
    })
    expect(result.submissions).toHaveLength(1)
  })

  test.each([
    null,
    'text',
    {},
    { drop: false },
    { drop: 'no', text: 'yes' },
    { text: 42 },
    { text: 'ok', context: [''] },
  ])('rejects invalid result %j', async value => {
    await inspectContract(async (options, input, core) => {
      const below = await core(input)
      expect(() => options.validateResult!(value, [below])).toThrow()
      return below
    })
  })
})
