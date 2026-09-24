import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Command } from '../../types/command.js'
import {
  createCommandInputMessage,
  createUserMessage,
  createCompactBoundaryMessage,
} from '../../utils/messages.js'
import {
  processSlashCommand,
  type SlashCommandResult,
} from '../../utils/processUserInput/processSlashCommand.js'
import type { ProcessUserInputContext } from '../../utils/processUserInput/processUserInput.js'
import { dispatchModEvent } from './dispatch.js'
import type { ModDispatchHook } from './types.js'
import type { ModSnapshot } from './runtime.js'
import { runImmediateModCommand, runModCommand } from './commandAdapter.js'

let savedAnthropicApiKey: string | undefined
beforeEach(() => {
  savedAnthropicApiKey = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'test-api-key'
})
afterEach(() => {
  if (savedAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = savedAnthropicApiKey
})

function snapshot(...handlers: ModDispatchHook['invoke'][]): ModSnapshot {
  return {
    hasHooks: event => event === 'command.run' && handlers.length > 0,
    release() {},
    dispatch: (event, input, core, options) =>
      dispatchModEvent({
        event,
        input,
        core,
        ...options,
        hooks: handlers.map((invoke, index) => ({
          plugin: `test-${index}`,
          tier: 'user',
          registration: { id: index + 1, event: 'command.run', hasCatch: false },
          invoke,
        })),
      }),
  }
}
const command: Command = {
  type: 'local',
  name: 'fixture',
  description: 'fixture',
  supportsNonInteractive: true,
  load: async () => ({ call: async () => ({ type: 'text', value: 'unused' }) }),
}
const input = {
  command: command.name,
  args: 'original',
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: false, columns: 80 },
}

function hostResult(text = 'host'): SlashCommandResult {
  return {
    command,
    messages: [
      createUserMessage({ content: 'context' }),
      createCommandInputMessage(
        `<local-command-stdout>${text}</local-command-stdout>`,
      ),
    ],
    shouldQuery: true,
    allowedTools: ['Read'],
    model: 'host-model',
    effort: 'high',
    nextInput: '/next',
    submitNextInput: true,
    resultText: text,
  }
}

function context(commands: Command[]): ProcessUserInputContext {
  return {
    options: {
      commands,
      tools: [],
      isNonInteractiveSession: false,
      mcpResources: {},
    },
    abortController: new AbortController(),
    messages: [],
    getAppState: () => ({
      sessionState: { sessionHooks: {} },
      fileHistory: { snapshots: [] },
    }),
    setAppState() {},
  } as unknown as ProcessUserInputContext
}

describe('existing slash executor wrapped by command.run', () => {
  test('local-jsx keeps onDone effects and never renders JSX after an early completion', async () => {
    let calls = 0
    let hooks = 0
    const ui: Command = {
      type: 'local-jsx',
      name: 'panel',
      description: 'panel',
      load: async () => ({
        call: async onDone => {
          calls++
          onDone('panel output', {
            display: 'system',
            shouldQuery: true,
            metaMessages: ['context'],
            nextInput: '/next',
            submitNextInput: true,
          })
          return 'late JSX'
        },
      }),
    }
    const rendered: unknown[] = []
    const result = await processSlashCommand(
      '/panel',
      [],
      [],
      [],
      context([ui]),
      value => {
        rendered.push(value)
      },
      undefined,
      false,
      undefined,
      {
        snapshot: snapshot(async (e, next) => {
          hooks++
          const value = (await next(e)) as { text?: string; ref?: number }
          expect(value.text).toBe('panel output')
          return { ...value, text: 'transformed' }
        }),
        origin: input.origin,
        presentation: input.presentation,
      },
    )
    expect(hooks).toBe(1)
    expect(calls).toBe(1)
    expect(rendered).toEqual([])
    expect(result).toMatchObject({
      shouldQuery: true,
      nextInput: '/next',
      submitNextInput: true,
      resultText: 'transformed',
    })
    expect(
      result.messages.some(
        message =>
          message.type === 'user' &&
          message.isMeta &&
          message.message.content === 'context',
      ),
    ).toBe(true)
    expect(
      result.messages.some(
        message =>
          message.type === 'system' &&
          message.content ===
            '<local-command-stdout>transformed</local-command-stdout>',
      ),
    ).toBe(true)
  })

  test('compact output is exposed while boundary, summaries and retained UUIDs survive a transform', async () => {
    const boundary = createCompactBoundaryMessage('manual', 100)
    const summary = createUserMessage({
      content: 'summary',
      isCompactSummary: true,
    })
    const retained = createUserMessage({ content: 'retained' })
    let calls = 0
    const compact: Command = {
      ...command,
      name: 'compact-fixture',
      load: async () => ({
        call: async () => {
          calls++
          return {
            type: 'compact' as const,
            displayText: 'compacted',
            compactionResult: {
              boundaryMarker: boundary,
              summaryMessages: [summary],
              messagesToKeep: [retained],
              attachments: [],
              hookResults: [],
            },
          }
        },
      }),
    }
    const receipts: unknown[] = []
    const result = await processSlashCommand(
      '/compact-fixture',
      [],
      [],
      [],
      context([compact]),
      () => {},
      undefined,
      false,
      undefined,
      {
        snapshot: snapshot(async (e, next) => {
          const value = await next(e)
          receipts.push(value)
          return { ...(value as object), text: 'replacement' }
        }),
        origin: input.origin,
        presentation: input.presentation,
      },
    )
    expect(receipts).toEqual([{ text: 'compacted', ref: 1 }])
    expect(calls).toBe(1)
    expect(result.messages.slice(0, 3)).toEqual([boundary, summary, retained])
    expect(result.messages[0]).toBe(boundary)
    expect(result.messages.at(-1)).toMatchObject({
      message: {
        content: '<local-command-stdout>replacement</local-command-stdout>',
      },
    })
  })

  test('prompt execution preserves its model, effort, permissions and supplied UUID', async () => {
    let calls = 0
    const prompt: Command = {
      type: 'prompt',
      name: 'prompt-fixture',
      description: 'prompt',
      source: 'builtin',
      progressMessage: 'prompt',
      contentLength: 1,
      allowedTools: ['Read'],
      model: 'host-model',
      effort: 'high',
      getPromptForCommand: async args => {
        calls++
        return [{ type: 'text', text: `prompt ${args}` }]
      },
    }
    const uuid = '533629e8-cedf-4093-9e9b-23684c41d9ce'
    const receipts: unknown[] = []
    const result = await processSlashCommand(
      '/prompt-fixture original',
      [],
      [],
      [],
      context([prompt]),
      () => {},
      uuid,
      false,
      undefined,
      {
        snapshot: snapshot(async (e, next) => {
          const value = await next(e)
          receipts.push(value)
          return value
        }),
        origin: input.origin,
        presentation: input.presentation,
      },
    )
    expect(receipts).toEqual([{ text: undefined, ref: 1 }])
    expect(calls).toBe(1)
    expect(result).toMatchObject({
      shouldQuery: true,
      allowedTools: ['Read'],
      model: 'host-model',
      effort: 'high',
    })
    expect(result.messages[0]!.uuid).toBe(uuid)
    expect(
      result.messages.some(
        message =>
          message.type === 'attachment' &&
          message.attachment.type === 'command_permissions',
      ),
    ).toBe(true)
  })

  test('prompt commands with shouldQuery false expose their printed output', async () => {
    const prompt: Command = {
      type: 'prompt',
      name: 'print-fixture',
      description: 'print',
      source: 'builtin',
      progressMessage: 'print',
      contentLength: 1,
      shouldQueryForCommand: () => false,
      getPromptForCommand: async () => [
        { type: 'text', text: 'printed prompt' },
      ],
    }
    const receipts: unknown[] = []
    await processSlashCommand(
      '/print-fixture',
      [],
      [],
      [],
      context([prompt]),
      () => {},
      undefined,
      false,
      undefined,
      {
        snapshot: snapshot(async (e, next) => {
          const value = await next(e)
          receipts.push(value)
          return value
        }),
        origin: input.origin,
        presentation: input.presentation,
      },
    )
    expect(receipts).toEqual([{ text: 'printed prompt', ref: 1 }])
  })

  test('an open local-jsx pane is installed once and its completion is awaited through hook failure', async () => {
    let done!: (result?: string) => void
    let opened!: () => void
    const ready = new Promise<void>(resolve => {
      opened = resolve
    })
    let calls = 0
    const ui: Command = {
      type: 'local-jsx',
      name: 'open-panel',
      description: 'panel',
      load: async () => ({
        call: async onDone => {
          calls++
          done = onDone
          return 'pane'
        },
      }),
    }
    const renders: unknown[] = []
    const running = processSlashCommand(
      '/open-panel',
      [],
      [],
      [],
      context([ui]),
      value => {
        renders.push(value)
        opened()
      },
      undefined,
      false,
      undefined,
      {
        snapshot: snapshot(async (e, next) => {
          await next(e)
          throw new Error('after panel')
        }),
        origin: input.origin,
        presentation: input.presentation,
      },
    )
    await ready
    expect(calls).toBe(1)
    expect(renders).toHaveLength(1)
    done('closed')
    const result = await running
    expect(result.resultText).toBe('closed')
    expect(calls).toBe(1)
    expect(renders).toHaveLength(1)
  })

  test.each(['local', 'local-jsx', 'prompt'] as const)(
    'retains existing %s exception behavior without rerunning its implementation',
    async type => {
      let calls = 0
      const fail = async () => {
        calls++
        throw new Error('fixture failure')
      }
      const failing: Command =
        type === 'prompt'
          ? {
              type,
              name: 'failure',
              description: 'failure',
              source: 'builtin',
              progressMessage: '',
              contentLength: 0,
              getPromptForCommand: fail,
            }
          : {
              type,
              name: 'failure',
              description: 'failure',
              supportsNonInteractive: true,
              load: async () => ({ call: fail }),
            }
      const renders: unknown[] = []
      const result = await processSlashCommand(
        '/failure',
        [],
        [],
        [],
        context([failing]),
        value => {
          renders.push(value)
        },
        undefined,
        false,
        undefined,
        {
          snapshot: snapshot(async (e, next) => {
            await next(e)
            throw new Error('hook failure')
          }),
          origin: input.origin,
          presentation: input.presentation,
        },
      )
      expect(calls).toBe(1)
      expect(result.shouldQuery).toBe(false)
      if (type === 'local-jsx') {
        expect(result.messages).toEqual([])
        expect(renders).toEqual([
          { jsx: null, shouldHidePromptInput: false, clearLocalJSX: true },
        ])
      } else
        expect(JSON.stringify(result.messages)).toContain(
          '<local-command-stderr>Error: fixture failure</local-command-stderr>',
        )
    },
  )

  test('short-circuits a real UI command without loading or rendering it', async () => {
    let loads = 0
    const ui: Command = {
      type: 'local-jsx',
      name: 'blocked-panel',
      description: 'panel',
      load: async () => {
        loads++
        throw new Error('must not load')
      },
    }
    const result = await processSlashCommand(
      '/blocked-panel',
      [],
      [],
      [],
      context([ui]),
      () => {
        throw new Error('must not render')
      },
      undefined,
      false,
      undefined,
      {
        snapshot: snapshot(async () => ({ text: 'intercepted' })),
        origin: input.origin,
        presentation: input.presentation,
      },
    )
    expect(loads).toBe(0)
    expect(result.resultText).toBe('intercepted')
  })

  test('the real slash entry captures runtime hooks without an injected test invocation', async () => {
    let calls = 0
    let released = 0
    const local: Command = {...command, load: async () => ({call: async () => { calls++; return {type:'text' as const, value:'host'} }})}
    const ctx = context([local])
    const snap = snapshot(async (event, next) => {
      expect(event.origin).toEqual({kind:'sdk'})
      expect(event.presentation).toEqual({isFullscreen:false, columns:96})
      return {...await next(event) as object, text:'hook output'}
    })
    snap.release = () => { released++ }
    ctx.mods = {capture: () => snap} as any
    ctx.modCommand = {origin:{kind:'sdk'}, presentation:{isFullscreen:false, columns:96}}
    const result = await processSlashCommand('/fixture', [], [], [], ctx, () => {})
    expect(result.resultText).toBe('hook output')
    expect(calls).toBe(1)
    expect(released).toBe(1)
  })

  test('resolves aliases before dispatch and executes the existing local loader once', async () => {
    const calls: string[] = []
    const local: Command = {
      ...command,
      aliases: ['alias'],
      load: async () => ({
        call: async args => {
          calls.push(args)
          return { type: 'text' as const, value: `printed ${args}` }
        },
      }),
    }
    const result = await processSlashCommand(
      '/alias before',
      [],
      [],
      [],
      context([local]),
      () => {},
      undefined,
      false,
      undefined,
      {
        snapshot: snapshot(async (e, next) => {
          expect(e.command).toBe('fixture')
          return next({ ...e, args: 'after' })
        }),
        origin: input.origin,
        presentation: input.presentation,
      },
    )
    expect(calls).toEqual(['after'])
    expect(result.resultText).toBe('printed after')
    expect(result.messages.at(-1)).toMatchObject({
      content: '<local-command-stdout>printed after</local-command-stdout>',
    })
  })
})

describe('immediate command entry', () => {
  test('renders without waiting for dismissal and retains completion options and snapshot', async () => {
    let dismiss!: import('../../types/command.js').LocalJSXCommandOnDone
    let released = 0
    const completions: unknown[] = []
    const ui: Command = {
      type: 'local-jsx', name: 'panel', description: 'panel', immediate: true,
      load: async () => ({call: async (onDone, _context, args) => {
        expect(args).toBe('rewritten')
        dismiss = onDone
        return 'panel JSX'
      }}),
    }
    const ctx = context([ui])
    const snap = snapshot(async (e, next) => ({...await next({...e, args:'rewritten'}) as object, text:'hook output'}))
    snap.release = () => { released++ }
    ctx.mods = {capture: () => snap} as any
    const jsx = await runImmediateModCommand(ui, (text, options) => completions.push({text, options}), ctx, 'initial')
    expect(jsx).toBe('panel JSX')
    expect(released).toBe(0)
    expect(completions).toEqual([])
    const options = {display:'system' as const, metaMessages:['keep'], nextInput:'/next', submitNextInput:true}
    dismiss('host output', options)
    await Bun.sleep(0)
    expect(completions).toEqual([{text:'hook output', options}])
    expect(released).toBe(1)
  })

  test('short-circuit never loads the immediate command and early completion never renders stale JSX', async () => {
    for (const intercept of [true, false]) {
      let loads = 0
      let releases = 0
      const completions: unknown[] = []
      const ui: Command = {
        type:'local-jsx', name:'panel', description:'panel', immediate:true,
        load:async () => { loads++; return {call:async onDone => {onDone('host', {display:'skip'}); return 'stale JSX'}} },
      }
      const ctx = context([ui])
      const snap = snapshot(async (e, next) => intercept ? {text:'intercepted'} : next(e))
      snap.release = () => { releases++ }
      ctx.mods = {capture:() => snap} as any
      const jsx = await runImmediateModCommand(ui, (text, options) => completions.push({text, options}), ctx, '')
      await Bun.sleep(0)
      expect(jsx).toBeNull()
      expect(loads).toBe(intercept ? 0 : 1)
      expect(completions).toEqual([{text:intercept ? 'intercepted' : 'host', options:intercept ? undefined : {display:'skip'}}])
      expect(releases).toBe(1)
    }
  })

  test('cancellation during a slow immediate loader cannot invoke the command after release', async () => {
    const loading = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    let calls = 0
    let releases = 0
    const ui: Command = {type:'local-jsx', name:'panel', description:'panel', immediate:true,
      load:async () => {entered.resolve(); await loading.promise; return {call:async () => {calls++; return 'late panel'}}}}
    const ctx = context([ui])
    const snap = snapshot(async (e, next) => next(e))
    snap.release = () => { releases++ }
    ctx.mods = {capture:() => snap} as any
    const running = runImmediateModCommand(ui, () => {}, ctx, '')
    await entered.promise
    ctx.abortController.abort()
    expect(await running).toBeNull()
    expect(releases).toBe(1)
    loading.resolve()
    await Bun.sleep(0)
    expect(calls).toBe(0)
  })

  test('a dispatch failure after JSX is ready closes the pane and reports the failure once', async () => {
    let dismiss!: import('../../types/command.js').LocalJSXCommandOnDone
    let releases = 0
    const completions: unknown[] = []
    const ui: Command = {type:'local-jsx', name:'panel', description:'panel', immediate:true,
      load:async () => ({call:async onDone => {dismiss=onDone; return 'panel'}})}
    const ctx = context([ui])
    const snap: ModSnapshot = {
      hasHooks: () => true,
      release: () => {releases++},
      dispatch: async (_event, input, core) => {await core(input); throw Error('completion failed')},
    }
    ctx.mods = {capture:() => snap} as any
    expect(await runImmediateModCommand(ui, (...args) => completions.push(args), ctx, '')).toBe('panel')
    dismiss('host output')
    await Bun.sleep(0)
    expect(completions).toEqual([['Error running /panel: completion failed', {display:'system'}]])
    expect(releases).toBe(1)
    dismiss('late')
    await Bun.sleep(0)
    expect(completions).toHaveLength(1)
  })

  test('a dispatch failure before JSX is ready rejects the caller without a second completion', async () => {
    let releases = 0
    let loads = 0
    const completions: unknown[] = []
    const ui: Command = {type:'local-jsx', name:'panel', description:'panel', immediate:true,
      load:async () => {loads++; return {call:async () => 'panel'}}}
    const ctx = context([ui])
    const snap: ModSnapshot = {
      hasHooks: () => true,
      release: () => {releases++},
      dispatch: async () => {throw Error('before mount')},
    }
    ctx.mods = {capture:() => snap} as any
    await expect(runImmediateModCommand(ui, (...args) => completions.push(args), ctx, '')).rejects.toThrow('before mount')
    expect(completions).toEqual([])
    expect(releases).toBe(1)
    expect(loads).toBe(0)
  })

  test('cancellation releases an open immediate command exactly once', async () => {
    let releases = 0
    let lateDone!: import('../../types/command.js').LocalJSXCommandOnDone
    const completions: unknown[] = []
    const ui: Command = {type:'local-jsx', name:'panel', description:'panel', immediate:true,
      load:async () => ({call:async onDone => {lateDone = onDone; return 'panel'}})}
    const ctx = context([ui])
    const snap = snapshot(async (e, next) => next(e))
    snap.release = () => { releases++ }
    ctx.mods = {capture:() => snap} as any
    expect(await runImmediateModCommand(ui, (...args) => completions.push(args), ctx, '')).toBe('panel')
    ctx.abortController.abort()
    await Bun.sleep(0)
    lateDone('too late')
    expect(releases).toBe(1)
    expect(completions).toHaveLength(1)
    expect(completions[0]).toEqual([undefined, {display:'skip'}])
  })
})

describe('command.run host result adapter', () => {
  test('a synthetic answer does not execute core, including an empty panel answer', async () => {
    let calls = 0
    for (const text of ['synthetic', '', undefined]) {
      const result = await runModCommand({
        snapshot: snapshot(async () => ({ text })),
        input,
        command,
        core: async () => {
          calls++
          return hostResult()
        },
      })
      expect(result.shouldQuery).toBe(false)
      expect(result.resultText).toBe(text)
      expect(result.messages.length).toBe(text === undefined ? 0 : 2)
      if (text !== undefined)
        expect(result.messages.at(-1)).toMatchObject({
          content: `<local-command-stdout>${text}</local-command-stdout>`,
        })
    }
    expect(calls).toBe(0)
  })
  test('transformed stdout preserves UUIDs, context and every non-text host field', async () => {
    const original = hostResult()
    const result = await runModCommand({
      snapshot: snapshot(async (e, next) => ({
        ...((await next(e)) as object),
        text: 'changed',
      })),
      input,
      command,
      core: async () => original,
    })
    const stdout = original.messages[1]!
    if (stdout.type !== 'system' || stdout.subtype !== 'local_command') throw new Error('Expected local command stdout')
    expect(result).toEqual({
      ...original,
      resultText: 'changed',
      messages: [
        original.messages[0],
        {
          ...stdout,
          content: '<local-command-stdout>changed</local-command-stdout>',
        },
      ],
    })
    expect(result.messages[0]).toBe(original.messages[0])
    expect(original.resultText).toBe('host')
    expect(original.messages[1]).toMatchObject({
      content: '<local-command-stdout>host</local-command-stdout>',
    })
  })

  test.each([
    ['command', { command: 'other' }],
    ['origin', { origin: { kind: 'plugin', name: 'forged' } }],
    ['presentation', { presentation: { isFullscreen: true, columns: 120 } }],
    ['args', { args: 123 }],
  ])('rejects rewritten %s at core before executing', async (_key, patch) => {
    let calls = 0
    await expect(
      runModCommand({
        // Exercise the adapter's final guard independently of dispatcher recovery.
        snapshot: {
          hasHooks: () => true,
          release() {},
          dispatch: (_event, e, core) => core({ ...e, ...patch }),
        },
        input,
        command,
        core: async () => {
          calls++
          return hostResult()
        },
      }),
    ).rejects.toThrow('command.run')
    expect(calls).toBe(0)
  })

  test('text added to a silent run never overwrites stdout retained from an older command', async () => {
    const original = { ...hostResult('older command'), resultText: undefined }
    const result = await runModCommand({
      snapshot: snapshot(async (e, next) => ({
        ...((await next(e)) as object),
        text: 'new output',
      })),
      input,
      command,
      core: async () => original,
    })
    expect(result.messages.slice(0, original.messages.length)).toEqual(
      original.messages,
    )
    expect(result.messages.at(-1)).toMatchObject({
      content: '<local-command-stdout>new output</local-command-stdout>',
    })
  })

  test('explicit next calls get completion-ordered refs and select the exact earlier result', async () => {
    let finishSlow!: () => void
    const gate = new Promise<void>(resolve => {
      finishSlow = resolve
    })
    const slow = hostResult('slow')
    const fast = hostResult('fast')
    const refs: unknown[] = []
    const calls: string[] = []
    const result = await runModCommand({
      snapshot: snapshot(async (e, next) => {
        const first = next({ ...e, args: 'slow' })
        const second = (await next({ ...e, args: 'fast' })) as { ref: number }
        finishSlow()
        const completed = (await first) as { ref: number }
        refs.push(completed.ref, second.ref)
        return { ref: second.ref }
      }),
      input,
      command,
      core: async args => {
        calls.push(args)
        if (args === 'slow') {
          await gate
          return slow
        }
        return fast
      },
    })
    expect(calls).toEqual(['slow', 'fast'])
    expect(refs).toEqual([2, 1])
    expect(result).toBe(fast)
  })

  test.each([
    null,
    [],
    { text: 123 },
    { ref: 0 },
    { ref: -1 },
    { ref: 1.5 },
    { ref: '1' },
    { ref: 2 },
  ])(
    'invalid result %j after next retains the executed result without replay',
    async invalid => {
      let calls = 0
      const original = hostResult()
      const result = await runModCommand({
        snapshot: snapshot(async (e, next) => {
          await next(e)
          return invalid
        }),
        input,
        command,
        core: async () => {
          calls++
          return original
        },
      })
      expect(calls).toBe(1)
      expect(result).toBe(original)
    },
  )

  test('an error after next keeps the host result; a rejected core stays rejected without replay', async () => {
    let calls = 0
    const original = hostResult()
    const throwing = snapshot(async (e, next) => {
      await next(e)
      throw new Error('after next')
    })
    expect(
      await runModCommand({
        snapshot: throwing,
        input,
        command,
        core: async () => {
          calls++
          return original
        },
      }),
    ).toBe(original)
    expect(calls).toBe(1)
    const error = new Error('core failed')
    await expect(
      runModCommand({
        snapshot: throwing,
        input,
        command,
        core: async () => {
          calls++
          throw error
        },
      }),
    ).rejects.toBe(error)
    expect(calls).toBe(2)
  })

  test('a synthetic outer hook does not run core even when it called a short-circuiting inner hook', async () => {
    let calls = 0
    const result = await runModCommand({
      snapshot: snapshot(
        async (e, next) => {
          await next(e)
          return { text: 'outer' }
        },
        async () => ({ text: 'inner' }),
      ),
      input,
      command,
      core: async () => {
        calls++
        return hostResult()
      },
    })
    expect(calls).toBe(0)
    expect(result.resultText).toBe('outer')
  })

  test('omitted presentation retains the initial stamp and worker-cloned origins compare by value', async () => {
    const original = hostResult()
    const result = await runModCommand({
      snapshot: snapshot(async (e, next) => {
        const { presentation: _presentation, ...rewritten } = structuredClone(e)
        return next(rewritten)
      }),
      input,
      command,
      core: async () => original,
    })
    expect(result).toBe(original)
  })

  test('waits for an unawaited next before returning and preserves its irreversible fields', async () => {
    let finish!: () => void
    const gate = new Promise<void>(resolve => {
      finish = resolve
    })
    let settled = false
    const original = hostResult()
    const running = runModCommand({
      snapshot: snapshot(async (e, next) => {
        void next(e)
        return { text: 'after' }
      }),
      input,
      command,
      core: async () => {
        await gate
        return original
      },
    }).then(result => {
      settled = true
      return result
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    finish()
    const result = await running
    expect(result).toMatchObject({
      shouldQuery: true,
      nextInput: '/next',
      submitNextInput: true,
      resultText: 'after',
    })
    expect(result.messages[0]).toBe(original.messages[0])
  })

  test('a transformed ref selects that run rather than the last completed execution', async () => {
    const first = hostResult('first')
    const last = hostResult('last')
    const result = await runModCommand({
      snapshot: snapshot(async (e, next) => {
        const selected = (await next({ ...e, args: 'first' })) as object
        await next({ ...e, args: 'last' })
        return { ...selected, text: 'changed first' }
      }),
      input,
      command,
      core: async args => (args === 'first' ? first : last),
    })
    expect(result.messages[0]).toBe(first.messages[0])
    expect(result.messages[1]!.uuid).toBe(first.messages[1]!.uuid)
    expect(result.resultText).toBe('changed first')
  })

  test('an invalid synthetic ref falls through once rather than naming another invocation', async () => {
    let calls = 0
    const original = hostResult()
    const result = await runModCommand({
      snapshot: snapshot(async () => ({ ref: 1, text: 'forged' })),
      input,
      command,
      core: async () => {
        calls++
        return original
      },
    })
    expect(calls).toBe(1)
    expect(result).toBe(original)
  })

  test('a sensitive synthetic command never prints its arguments', async () => {
    const result = await runModCommand({
      snapshot: snapshot(async () => ({ text: 'hidden' })),
      input,
      command: { ...command, isSensitive: true },
      core: async () => hostResult(),
    })
    expect(JSON.stringify(result.messages)).not.toContain('original')
    expect(JSON.stringify(result.messages)).toContain('***')
  })

  test('rewrites only args and passes the complete host result back verbatim', async () => {
    const original = hostResult()
    const calls: string[] = []
    const result = await runModCommand({
      snapshot: snapshot(async (e, next) => {
        expect(e).toEqual(input)
        const value = await next({ ...e, args: 'rewritten' })
        expect(value).toEqual({ text: 'host', ref: 1 })
        return value
      }),
      input,
      command,
      core: async args => {
        calls.push(args)
        return original
      },
    })
    expect(calls).toEqual(['rewritten'])
    expect(result).toBe(original)
    expect(result.messages[0]).toBe(original.messages[0])
  })
})
