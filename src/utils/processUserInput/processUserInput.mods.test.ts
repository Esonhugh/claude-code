import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { dispatchModEvent } from '../../services/mods/dispatch.js'
import { runModPromptSubmit } from '../../services/mods/promptAdapter.js'
import type { ModDispatchHook } from '../../services/mods/types.js'

// Execute the production functions, including processUserInputBase and
// processTextPrompt, without importing the CLI/UI bootstrap graph.
function loadFunctions(
  path: string,
  dependencies: Record<string, unknown>,
  name: string,
) {
  const source = ts.createSourceFile(
    path,
    readFileSync(new URL(path, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
  const transformed = ts.transform(source, [
    context => root => {
      const visit: ts.Visitor = node => {
        if (ts.isImportDeclaration(node)) return undefined
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword
        ) {
          return ts.factory.createCallExpression(
            ts.factory.createPropertyAccessExpression(
              ts.factory.createIdentifier('Promise'),
              'resolve',
            ),
            undefined,
            [ts.factory.createIdentifier('commandModules')],
          )
        }
        if (ts.isFunctionDeclaration(node)) {
          return ts.factory.updateFunctionDeclaration(
            node,
            node.modifiers?.filter(
              modifier => modifier.kind !== ts.SyntaxKind.ExportKeyword,
            ),
            node.asteriskToken,
            node.name,
            node.typeParameters,
            node.parameters,
            node.type,
            ts.visitNode(node.body, visit) as ts.Block,
          )
        }
        return ts.visitEachChild(node, visit, context)
      }
      return ts.visitNode(root, visit) as ts.SourceFile
    },
  ])
  const code = ts.transpileModule(
    ts.createPrinter().printFile(transformed.transformed[0]!),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText
  transformed.dispose()
  return new Function(
    ...Object.keys(dependencies),
    'exports',
    `${code}\nreturn ${name}`,
  )(...Object.values(dependencies), {})
}

function fixture(
  handlers: ModDispatchHook['invoke'][] = [],
  commandShouldQuery = false,
) {
  let id = 0
  const diagnostics: string[] = []
  const events: Record<string, unknown>[] = []
  const classicInputs: string[] = []
  const calls = { captures: 0, releases: 0, slash: 0, bash: 0 }
  const classicResults: Record<string, any>[] = []
  const controller = new AbortController()
  const createUserMessage = (options: Record<string, unknown>) => ({
    type: 'user',
    uuid: options.uuid ?? `message-${++id}`,
    message: { content: options.content },
    isMeta: options.isMeta,
    imagePasteIds: options.imagePasteIds,
  })
  const dependencies = {
    randomUUID: () => `id-${++id}`,
    createUserMessage,
    createAttachmentMessage: (attachment: unknown) => ({
      type: 'attachment',
      attachment,
    }),
    createSystemMessage: (content: string, level: string) => ({
      type: 'system',
      content,
      level,
    }),
    createCommandInputMessage: (content: string) => ({
      type: 'system',
      content,
    }),
    getContentText: (input: any) =>
      typeof input === 'string'
        ? input
        : input
            .filter((block: any) => block.type === 'text')
            .map((block: any) => block.text)
            .join('\n'),
    queryCheckpoint: () => {},
    logEvent: () => {},
    feature: () => false,
    executeUserPromptSubmitHooks: async function* (text: string) {
      classicInputs.push(text)
      yield* classicResults
    },
    getUserPromptSubmitHookBlockingMessage: () => 'Blocked by classic hook',
    isValidImagePaste: (item: any) => item.type === 'image',
    storeImages: async () => new Map(),
    maybeResizeAndDownsampleImageBlock: async (block: unknown) => ({ block }),
    createImageMetadataText: () => undefined,
    toArray: async (items: AsyncIterable<unknown>) => {
      const result = []
      for await (const item of items) result.push(item)
      return result
    },
    getAttachmentMessages: async function* () {},
    hasUltracodeKeyword: () => false,
    isUltracodeKeywordTriggerEnabled: () => false,
    hasUltraplanKeyword: () => false,
    replaceUltraplanKeyword: (text: string) => text,
    parseSlashCommand: (text: string) => ({ commandName: text.slice(1) }),
    findCommand: () => undefined,
    isBridgeSafeCommand: () => false,
    getCommandName: () => 'fixture',
    commandModules: {
      processSlashCommand: async (text: string) => {
        calls.slash++
        return {
          messages: [createUserMessage({ content: text })],
          shouldQuery: commandShouldQuery,
          resultText: 'slash result',
        }
      },
      processBashCommand: async (text: string) => {
        calls.bash++
        return {
          messages: [createUserMessage({ content: text })],
          shouldQuery: false,
          resultText: 'bash result',
        }
      },
    },
  }
  const processTextPrompt = loadFunctions(
    './processTextPrompt.ts',
    {
      ...dependencies,
      setPromptId: () => {},
      startInteractionSpan: () => {},
      logOTelEvent: () => {},
      redactIfDisabled: (value: string) => value,
      matchesNegativeKeyword: () => false,
      matchesKeepGoingKeyword: () => false,
    },
    'processTextPrompt',
  )
  const processUserInput = loadFunctions(
    './processUserInput.ts',
    { ...dependencies, processTextPrompt, runModPromptSubmit },
    'processUserInput',
  )
  const context = {
    abortController: controller,
    getAppState: () => ({
      toolPermissionContext: { mode: 'default' },
      settings: {},
    }),
    options: { commands: [] },
    mods: {
      capture: () => {
        calls.captures++
        return {
          hasHooks: () => handlers.length > 0,
          release: () => {
            calls.releases++
          },
          dispatch: (
            event: string,
            input: Record<string, unknown>,
            core: any,
            options: any,
          ) => {
            expect(event).toBe('prompt.submit')
            events.push(structuredClone(input))
            return dispatchModEvent({
              event,
              input,
              core,
              ...options,
              hooks: handlers.map((invoke, index) => ({
                plugin: `fixture-${index}`,
                tier: 'user',
                registration: { id: index + 1, event, hasCatch: false },
                invoke,
              })),
              onFailure: (_plugin, error) => diagnostics.push(String(error)),
            })
          },
        }
      },
    },
  }
  return {
    run: (options: Record<string, unknown> = {}) =>
      processUserInput({
        input: 'original',
        mode: 'prompt',
        context,
        setToolJSX: () => {},
        ...options,
      }),
    context,
    controller,
    processUserInput,
    classicResults,
    classicInputs,
    calls,
    diagnostics,
    events,
  }
}

function userTexts(result: any) {
  return result.messages
    .filter((message: any) => message.type === 'user')
    .map((message: any) => message.message.content)
}

describe('processUserInput prompt.submit', () => {
  test('a drop without next does not submit or run classic hooks', async () => {
    const f = fixture([async () => ({ drop: 'not now' })])
    const result = await f.run()
    expect(result.shouldQuery).toBe(false)
    expect(userTexts(result)).toEqual([])
    expect(f.classicInputs).toEqual([])
    expect(
      result.messages.some((message: any) =>
        message.content?.includes('not now'),
      ),
    ).toBe(true)
    expect(f.calls.captures).toBe(1)
    expect(f.calls.releases).toBe(1)
  })

  test('rewrites actual model content and passes full downward context separately from classic truncation', async () => {
    const added = ['hunk notes\n' + 'x'.repeat(15989), 'y'.repeat(16000)]
    const f = fixture([
      async (event, next) =>
        next({ ...event, text: '/not-a-command', context: added }),
    ])
    f.classicResults.push({ additionalContexts: ['c'.repeat(10001)] })
    const result = await f.run()
    expect(result.shouldQuery).toBe(true)
    expect(userTexts(result)).toEqual(['/not-a-command'])
    expect(f.classicInputs).toEqual(['/not-a-command'])
    expect(result.admission).toEqual({
      text: '/not-a-command',
      context: added,
      origin: { kind: 'unclassified' },
    })
    const attachments = result.messages
      .filter((message: any) => message.type === 'attachment')
      .map((message: any) => message.attachment)
    expect(attachments[0].hookName).toBe('prompt.submit')
    expect(attachments[0].content).toEqual(added)
    expect(attachments[1].content[0]).toContain('[output truncated')
    expect(f.calls.slash).toBe(0)
  })

  test('a synthetic success without next enters nothing', async () => {
    const f = fixture([
      async () => ({ text: 'synthetic', context: ['not entered'] }),
    ])
    const result = await f.run()
    expect(result.shouldQuery).toBe(false)
    expect(result.messages).toEqual([])
    expect(f.classicInputs).toEqual([])
  })

  test.each(['text', 'context', 'mutated context'])(
    'post-next %s change is diagnostic only',
    async kind => {
      const f = fixture([
        async (event, next) => {
          const result: any = await next({ ...event, context: ['entered'] })
          if (kind === 'text') return { ...result, text: 'too late' }
          if (kind === 'mutated context') {
            result.context.push('too late')
            return result
          }
          return { ...result, context: [...result.context, 'too late'] }
        },
      ])
      const result = await f.run()
      expect(userTexts(result)).toEqual(['original'])
      expect(result.messages[1].attachment.content).toEqual(['entered'])
      expect(f.classicInputs).toEqual(['original'])
      expect(
        f.diagnostics.some(message => message.includes('after next')),
      ).toBe(true)
    },
  )

  test.each(['block', 'stop'])(
    'classic %s cannot be bypassed by synthetic Mod success',
    async kind => {
      const f = fixture([
        async (event, next) => {
          await next(event)
          return { text: 'synthetic success' }
        },
      ])
      f.classicResults.push(
        kind === 'block'
          ? { blockingError: 'denied' }
          : { preventContinuation: true, stopReason: 'stop' },
      )
      const result = await f.run()
      expect(result.shouldQuery).toBe(false)
      expect(f.classicInputs).toEqual(['original'])
      expect(JSON.stringify(result.messages)).toContain(
        kind === 'block'
          ? 'Blocked by classic hook'
          : 'Operation stopped by hook',
      )
      expect(JSON.stringify(result.messages)).not.toContain('synthetic success')
    },
  )

  test('drop after next preserves entered content and classic side effects', async () => {
    const f = fixture([
      async (event, next) => {
        await next({ ...event, text: 'entered' })
        return { drop: 'hide outcome' }
      },
    ])
    const result = await f.run()
    expect(result.shouldQuery).toBe(false)
    expect(userTexts(result)).toEqual(['entered'])
    expect(f.classicInputs).toEqual(['entered'])
  })

  test('multiple explicit next calls each enter once, even if the hook then fails', async () => {
    const f = fixture([
      async (event, next) => {
        await next({ ...event, text: 'one' })
        await next({ ...event, text: 'two' })
        throw new Error('after both')
      },
    ])
    const result = await f.run()
    expect(userTexts(result)).toEqual(['one', 'two'])
    expect(
      new Set(
        result.messages
          .filter((message: any) => message.type === 'user')
          .map((message: any) => message.uuid),
      ).size,
    ).toBe(2)
    expect(f.classicInputs).toEqual(['one', 'two'])
    expect(f.diagnostics).toHaveLength(1)
  })

  test('awaits an unawaited next before releasing the snapshot', async () => {
    const f = fixture([
      async (event, next) => {
        void next(event)
        return { drop: 'stopped' }
      },
    ])
    const result = await f.run()
    expect(result.shouldQuery).toBe(false)
    expect(userTexts(result)).toEqual(['original'])
    expect(f.classicInputs).toEqual(['original'])
    expect(f.calls.releases).toBe(1)
  })

  test.each(['before', 'after'])(
    'abort %s next never replays core and releases the snapshot',
    async when => {
      const f = fixture([
        async (event, next) => {
          if (when === 'after') await next(event)
          f.controller.abort(new Error('cancel prompt'))
          return next(event)
        },
      ])
      await expect(f.run()).rejects.toThrow('cancel prompt')
      expect(f.classicInputs).toEqual(when === 'after' ? ['original'] : [])
      expect(f.calls.releases).toBe(1)
    },
  )

  test.each([
    { name: 'slash', input: '/status' },
    { name: 'bash', input: 'pwd', mode: 'bash' },
    { name: 'remote shell', remote: true },
    { name: 'skipHooks', skipHooks: true },
  ])('preserves $name path', async ({ name, remote, ...options }) => {
    const f = fixture([async () => ({ drop: 'must not run' })])
    if (remote) Object.assign(f.context, { runRemoteShellCommand: () => {} })
    const result = await f.run(options)
    expect(f.events).toEqual([])
    expect(f.calls.captures).toBe(0)
    expect(result.shouldQuery).toBe(
      name === 'remote shell' || name === 'skipHooks',
    )
  })

  test('querying slash commands keep classic hooks without allowing Mod rerouting', async () => {
    const f = fixture([async () => ({ drop: 'must not run' })], true)
    const result = await f.run({ input: '/skill' })
    expect(result.shouldQuery).toBe(true)
    expect(f.calls.slash).toBe(1)
    expect(f.events).toEqual([])
    expect(f.classicInputs).toEqual(['/skill'])
  })

  test('no matching Mods keeps classic hooks and releases the unused snapshot', async () => {
    const f = fixture()
    const result = await f.run()
    expect(result.shouldQuery).toBe(true)
    expect(userTexts(result)).toEqual(['original'])
    expect(f.classicInputs).toEqual(['original'])
    expect(f.events).toEqual([])
    expect(f.calls.releases).toBe(1)
    expect(result.admission).toEqual({ text: 'original', origin: { kind: 'unclassified' } })
  })

  test('remote slash-as-text still submits and cannot execute a command via rewrite', async () => {
    const f = fixture([
      async (event, next) => next({ ...event, text: '/changed' }),
    ])
    const result = await f.run({
      input: '/remote',
      skipSlashCommands: true,
      promptSubmitMetadata: { origin: { kind: 'bridge' }, wait: false },
    })
    expect(userTexts(result)).toEqual(['/changed'])
    expect(f.calls.slash).toBe(0)
    expect(f.events[0]?.origin).toEqual({ kind: 'bridge' })
  })

  test('unknown bridge slash remains plain text and still traverses prompt.submit', async () => {
    const f = fixture([
      async (event, next) => next({ ...event, text: 'rewritten' }),
    ])
    const result = await f.run({
      input: '/unknown',
      bridgeOrigin: true,
      skipSlashCommands: true,
    })
    expect(userTexts(result)).toEqual(['rewritten'])
    expect(f.calls.slash).toBe(0)
  })

  test('does not invent user provenance or turn IDs for unstamped system input', async () => {
    const f = fixture([async (event, next) => next(event)])
    await f.run({ isMeta: true, uuid: 'message-not-turn' })
    expect(f.events[0]).toEqual({
      text: 'original',
      origin: { kind: 'unclassified' },
      wait: false,
    })
  })

  test('carries explicit ingress metadata without using message uuid as turnId', async () => {
    const f = fixture([async (event, next) => next(event)])
    await f.run({
      uuid: 'message-id',
      promptSubmitMetadata: {
        origin: { kind: 'scheduled-trigger' },
        wait: true,
        turnId: 'turn-in-flight',
      },
    })
    expect(f.events[0]).toEqual({
      text: 'original',
      origin: { kind: 'scheduled-trigger' },
      wait: true,
      turnId: 'turn-in-flight',
    })
  })

  test('rewrites text without losing images, document blocks or paste names', async () => {
    const image = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'image-bytes' },
    }
    const document = {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: 'document-bytes',
      },
    }
    const f = fixture([
      async (event, next) => next({ ...event, text: 'rewritten' }),
    ])
    const result = await f.run({
      input: [image, { type: 'text', text: 'original' }, document],
      pastedContents: {
        1: {
          id: 1,
          type: 'image',
          content: 'paste-bytes',
          mediaType: 'image/jpeg',
          filename: 'photo.jpg',
        },
      },
    })
    const content = userTexts(result)[0]
    expect(content[0]).toEqual(image)
    expect(content[1]).toEqual({ type: 'text', text: 'rewritten' })
    expect(content[2]).toEqual(document)
    expect(content[3].source.data).toBe('paste-bytes')
    expect(f.events[0]?.attachments).toEqual([
      { type: 'image', mediaType: 'image/png' },
      { type: 'document', mediaType: 'application/pdf' },
      { type: 'image', mediaType: 'image/jpeg', filename: 'photo.jpg' },
    ])
    expect(JSON.stringify(f.events)).not.toContain('bytes')
  })

  test.each([
    ['string', 'invalid'],
    ['sparse', Array(1)],
    ['empty entry', ['']],
    ['32001 characters', ['x'.repeat(32001)]],
  ])(
    'rejects %s downward context at core before any classic hook',
    async (_name, invalid) => {
      const f = fixture([
        async (event, next) => {
          await expect(next({ ...event, context: invalid })).rejects.toThrow('prompt.submit context')
          return {drop:'rejected before classic hooks'}
        },
      ])
      const result = await f.run()
      expect(result.shouldQuery).toBe(false)
      expect(userTexts(result)).toEqual([])
      expect(f.classicInputs).toEqual([])
      expect(f.calls.releases).toBe(1)
    },
  )

  test.each([
    ['string', 'invalid'],
    ['sparse', Array(1)],
    ['empty entry', ['']],
    ['32001 characters', ['x'.repeat(32001)]],
  ])('unhandled invalid %s next recovers with the untouched prompt once', async (_name, invalid) => {
    const f = fixture([async (event, next) => next({...event, text:'must not enter', context:invalid})])
    const result = await f.run()
    expect(userTexts(result)).toEqual(['original'])
    expect(f.classicInputs).toEqual(['original'])
    expect(f.diagnostics).toHaveLength(1)
    expect(f.diagnostics[0]).toContain('prompt.submit context')
    expect(f.calls.releases).toBe(1)
  })

  test.each([
    ['string', 'invalid'],
    ['sparse', Array(1)],
    ['empty entry', ['']],
    ['32001 characters', ['x'.repeat(32001)]],
  ])(
    'invalid %s result context does not replay next',
    async (_name, invalid) => {
      const f = fixture([
        async (event, next) => ({
          ...((await next(event)) as object),
          context: invalid,
        }),
      ])
      const result = await f.run()
      expect(userTexts(result)).toEqual(['original'])
      expect(f.classicInputs).toEqual(['original'])
      expect(f.diagnostics).toHaveLength(1)
      expect(f.calls.releases).toBe(1)
    },
  )

  test('preserves audio/nontext blocks and exposes only attachment descriptors', async () => {
    const audio = {
      type: 'audio',
      source: {
        type: 'base64',
        media_type: 'audio/wav',
        data: 'private bytes',
      },
    }
    const f = fixture([async (event, next) => next(event)])
    const result = await f.run({ input: [audio] })
    expect(userTexts(result)).toEqual([[audio]])
    expect(f.events[0]?.attachments).toEqual([
      { type: 'audio', mediaType: 'audio/wav' },
    ])
    expect(JSON.stringify(f.events)).not.toContain('private bytes')
  })

  test('real ingress queues before next resolves, survives turn completion, and never repeats hooks', async () => {
    let resume!: () => void
    let entered!: () => void
    const enteredHook = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { resume = resolve })
    const queue: any[] = []
    const queries: any[][] = []
    const f = fixture([async (event, next) => {
      entered()
      await gate
      const receipt: any = await next({ ...event, text: 'rewritten', context: ['private context'] })
      expect(queue).toHaveLength(1)
      expect(receipt.text).toBe('rewritten')
      expect(queries).toEqual([])
      return { ...receipt, text: 'too late' }
    }])
    const { QueryGuard } = await import('../QueryGuard.js')
    const guard = new QueryGuard()
    const generation = guard.tryStart()!
    const functions = loadFunctions('../handlePromptSubmit.ts', {
      processUserInput: f.processUserInput,
      parseReferences: () => [], expandPastedTextRefs: (text: string) => text,
      isValidImagePaste: (item: any) => item.type === 'image',
      logEvent: () => {}, startQueryProfile: () => {}, queryCheckpoint: () => {},
      createAbortController: () => new AbortController(),
      enqueue: (command: any) => queue.push(command),
      runWithWorkload: (_: unknown, run: () => unknown) => run(),
      fileHistoryEnabled: () => false,
    }, '{ handlePromptSubmit }')
    const params = {
      input: 'original', mode: 'prompt', messages: [], commands: [],
      queryGuard: guard, getToolUseContext: () => f.context,
      mainLoopModel: 'fixture', querySource: 'repl_main_thread',
      setToolJSX: () => {}, setAbortController: () => {}, setUserInputOnProcessing: () => {},
      onQuery: async (...args: any[]) => { queries.push(args) },
      promptSubmitMetadata: { origin: { kind: 'composer' }, wait: true, turnId: 'running' },
    }
    const pending = functions.handlePromptSubmit(params)
    await enteredHook
    expect(queue).toEqual([])
    guard.end(generation)
    resume()
    await pending
    expect(queue[0].admitted.admission).toEqual({ text: 'rewritten', context: ['private context'], origin: { kind: 'composer' } })
    await functions.handlePromptSubmit({ ...params, queuedCommands: queue.splice(0) })
    expect(f.classicInputs).toEqual(['rewritten'])
    expect(f.events).toHaveLength(1)
    expect(f.events[0]?.turnId).toBe('running')
    expect(queries).toHaveLength(1)
    expect(userTexts({ messages: queries[0]![0] })).toEqual(['rewritten'])
    expect(queries[0]![0][1].attachment.content).toEqual(['private context'])
    expect(queries[0]![8]).toEqual({ text: 'rewritten' })
    expect(f.calls.releases).toBe(1)
  })

  test('each explicit next commits once even when the hook returns a drop', async () => {
    const admitted: any[] = []
    const f = fixture([async (event, next) => {
      await next({ ...event, text: 'one' })
      expect(admitted.map(result => result.admission.text)).toEqual(['one'])
      await next({ ...event, text: 'two' })
      expect(admitted.map(result => result.admission.text)).toEqual(['one', 'two'])
      return { drop: 'post-admission response' }
    }])
    await f.run({ onPromptAdmission: (result: any) => admitted.push(result) })
    expect(f.classicInputs).toEqual(['one', 'two'])
    expect(admitted).toHaveLength(2)
    expect(new Set(admitted.map(result => result.messages[0].uuid)).size).toBe(2)
  })

  test.each(['block', 'stop'])('settled classic %s is not converted to a queued success', async kind => {
    const admissions: any[] = []
    const f = fixture([async (event, next) => {
      const receipt: any = await next(event)
      expect(receipt.drop).toContain(kind === 'block' ? 'Blocked by classic hook' : 'Operation stopped')
      return { text: 'synthetic success' }
    }])
    f.classicResults.push(kind === 'block' ? { blockingError: 'denied' } : { preventContinuation: true })
    const result = await f.run({ onPromptAdmission: (settled: any) => admissions.push(settled) })
    expect(admissions).toHaveLength(1)
    expect(admissions[0].shouldQuery).toBe(false)
    expect(admissions[0].admission.drop).toBeDefined()
    expect(result.admission).toEqual(admissions[0].admission)
    expect(result.shouldQuery).toBe(false)
  })

  test.each(['/status', 'pwd'])('deferred command %s has no early command or hook side effects', async input => {
    const f = fixture([async (event, next) => next(event)])
    const result = await f.run({ input, mode: input === 'pwd' ? 'bash' : 'prompt', deferCommands: true })
    expect(result.deferred).toBe(true)
    expect(f.calls.slash).toBe(0)
    expect(f.calls.bash).toBe(0)
    expect(f.classicInputs).toEqual([])
  })

  test('image-only input stays nontext unless explicitly rewritten', async () => {
    const image = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'bytes' },
    }
    const f = fixture([async (event, next) => next(event)])
    const result = await f.run({ input: [image] })
    expect(userTexts(result)).toEqual([[image]])
    expect(f.events[0]?.text).toBe('')
  })
})
