import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
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
  dependencyOverrides: Record<string, unknown> = {},
) {
  let id = 0
  const diagnostics: string[] = []
  const events: Record<string, unknown>[] = []
  const classicInputs: string[] = []
  const calls = { captures: 0, releases: 0, slash: 0, bash: 0 }
  const classicResults: Record<string, any>[] = []
  const attachmentMessages: Record<string, any>[] = []
  const classicHook: { run?: () => void | Promise<void> } = {}
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
    createHash,
    persistToolResult: async (content: string, toolUseID: string) => ({
      filepath: `/fixture/${toolUseID}.txt`, originalSize: content.length,
      isJson: false, preview: content.slice(0, 32), hasMore: content.length > 32,
    }),
    generatePreview: (content: string) => ({ preview: content.slice(0, 32), hasMore: content.length > 32 }),
    PREVIEW_SIZE_BYTES: 32,
    buildLargeToolResultMessage: (result: { filepath: string; preview: string }) =>
      `Full output saved to: ${result.filepath}\nPreview: ${result.preview}`,
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
      await classicHook.run?.()
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
    getAttachmentMessages: async function* () { yield* attachmentMessages },
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
    ...dependencyOverrides,
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
    classicHook,
    attachmentMessages,
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

// Fake only the controller boundary; message construction, middleware receipts,
// classic hook handling and queue admission still run production functions.
function armAsk(context: object, text = 'selected diff snapshot') {
  let armed = true
  let carrying = false
  const finishes: boolean[] = []
  const budgets: string[][] = []
  Object.assign(context, {
    diff: {
      beginAsk(context: readonly string[]) {
        budgets.push([...context])
        if (!armed || carrying) return undefined
        carrying = true
        let finished = false
        return {
          text,
          finish(accepted: boolean) {
            expect(finished).toBe(false)
            finished = true
            expect(carrying).toBe(true)
            carrying = false
            finishes.push(accepted)
            if (accepted) armed = false
          },
        }
      },
    },
  })
  return { text, finishes, budgets }
}

function additionalContexts(result: any): string[] {
  return result.messages.flatMap((message: any) =>
    message.type === 'attachment' && message.attachment.type === 'hook_additional_context'
      ? message.attachment.content
      : [],
  )
}

describe('processUserInput Diff Ask admission', () => {
  test.each(['classic', 'Mod'])('%s keeps the controller-fitted Ask without classic hook truncation', async path => {
    const modContext = ['m'.repeat(16000)]
    const f = fixture(path === 'Mod' ? [async (event, next) => next({ ...event, context: modContext })] : [])
    const ask = armAsk(f.context, 'd'.repeat(16000))
    const result = await f.run()
    expect(result.shouldQuery).toBe(true)
    expect(additionalContexts(result)).toEqual(path === 'Mod' ? [...modContext, ask.text] : [ask.text])
    expect(ask.budgets).toEqual([path === 'Mod' ? modContext : []])
    expect(ask.finishes).toEqual([true])
    expect(f.diagnostics).toEqual([])
  })

  test('a later Mod next can admit the Ask released by an earlier blocked next', async () => {
    const admissions: any[] = []
    const f = fixture([async (event, next) => {
      await next({ ...event, text: 'blocked' })
      f.classicResults.length = 0
      return next({ ...event, text: 'accepted' })
    }])
    const ask = armAsk(f.context)
    f.classicResults.push({ blockingError: 'denied' })
    const result = await f.run({ onPromptAdmission: (settled: any) => admissions.push(settled) })
    expect(result.shouldQuery).toBe(true)
    expect(admissions.map(settled => settled.shouldQuery)).toEqual([false, true])
    expect(additionalContexts(admissions[0])).toEqual([])
    expect(additionalContexts(admissions[1])).toEqual([ask.text])
    expect(ask.finishes).toEqual([false, true])
    expect(f.diagnostics).toEqual([])
  })

  test('classic enqueue consumes Ask before a model runs and dequeue keeps the admitted attachment', async () => {
    const f = fixture()
    Object.assign(f.context, { mods: undefined })
    const ask = armAsk(f.context)
    const queue: any[] = []
    const queries: any[][] = []
    const { QueryGuard } = await import('../QueryGuard.js')
    const guard = new QueryGuard()
    const generation = guard.tryStart()!
    const { handlePromptSubmit } = loadFunctions('../handlePromptSubmit.ts', {
      processUserInput: f.processUserInput,
      parseReferences: () => [], expandPastedTextRefs: (text: string) => text,
      isValidImagePaste: (item: any) => item.type === 'image',
      logEvent: () => {}, startQueryProfile: () => {}, queryCheckpoint: () => {},
      createAbortController: () => new AbortController(),
      enqueue: (command: any) => {
        expect(ask.finishes).toEqual([true])
        queue.push(command)
      },
      runWithWorkload: (_: unknown, run: () => unknown) => run(),
      fileHistoryEnabled: () => false,
    }, '{ handlePromptSubmit }')
    const params = {
      input: 'original', mode: 'prompt', messages: [], commands: [],
      queryGuard: guard, getToolUseContext: () => f.context,
      mainLoopModel: 'fixture', querySource: 'repl_main_thread',
      setToolJSX: () => {}, setAbortController: () => {}, setUserInputOnProcessing: () => {},
      onQuery: async (...args: any[]) => { queries.push(args) },
    }
    await handlePromptSubmit(params)
    expect(queue).toHaveLength(1)
    expect(additionalContexts(queue[0].admitted)).toEqual([ask.text])
    expect(queries).toEqual([])
    guard.end(generation)
    const nextAsk = armAsk(f.context, 'armed after queue admission')
    await handlePromptSubmit({ ...params, queuedCommands: queue.splice(0) })
    expect(queries).toHaveLength(1)
    expect(additionalContexts({ messages: queries[0]![0] })).toEqual([ask.text])
    expect(f.classicInputs).toEqual(['original'])
    expect(ask.finishes).toEqual([true])
    expect(nextAsk.budgets).toEqual([])
    expect(nextAsk.finishes).toEqual([])
  })

  test('a controller-declined Ask keeps full Mod context and admits without a lease', async () => {
    const modContext = ['x'.repeat(32000)]
    const f = fixture([async (event, next) => next({ ...event, context: modContext })])
    const budgets: string[][] = []
    Object.assign(f.context, { diff: { beginAsk(context: readonly string[]) {
      budgets.push([...context])
      return undefined
    } } })
    const result = await f.run()
    expect(result.shouldQuery).toBe(true)
    expect(additionalContexts(result)).toEqual(modContext)
    expect(result.admission.context).toEqual(modContext)
    expect(budgets).toEqual([modContext])
    expect(f.diagnostics).toEqual([])
  })

  test('a Mod drop before next leaves Ask available for a later prompt', async () => {
    let drop = true
    const f = fixture([async (event, next) => drop ? { drop: 'not admitted' } : next(event)])
    const ask = armAsk(f.context)
    const admissions: any[] = []
    const dropped = await f.run({ onPromptAdmission: (settled: any) => admissions.push(settled) })
    expect(dropped.shouldQuery).toBe(false)
    expect(admissions).toEqual([])
    expect(ask.budgets).toEqual([])
    expect(ask.finishes).toEqual([])
    drop = false
    const result = await f.run()
    expect(result.shouldQuery).toBe(true)
    expect(additionalContexts(result)).toEqual([ask.text])
    expect(ask.finishes).toEqual([true])
  })

  test.each(['classic', 'Mod'])('%s noneligible paths leave the armed Ask untouched', async path => {
    for (const options of [
      { input: '/skill' },
      { input: '/deferred', deferCommands: true },
      { input: 'pwd', mode: 'bash' },
      { skipHooks: true },
      { remote: true },
      { agent: true },
    ]) {
      const f = fixture(path === 'Mod' ? [async (event, next) => next(event)] : [], true)
      const ask = armAsk(f.context)
      if (options.remote) Object.assign(f.context, { runRemoteShellCommand: () => {} })
      if (options.agent) Object.assign(f.context, { agentId: 'subagent' })
      const result = await f.run(options)
      expect(additionalContexts(result)).not.toContain(ask.text)
      expect(ask.budgets).toEqual([])
      expect(ask.finishes).toEqual([])
      Object.assign(f.context, { runRemoteShellCommand: undefined, agentId: undefined })
      expect(additionalContexts(await f.run())).toEqual([ask.text])
      expect(ask.finishes).toEqual([true])
    }
  })

  test.each(['sequential', 'concurrent', 'unawaited'])('Mod %s next carries Ask once and an outer drop cannot roll back admission', async style => {
    const admissions: any[] = []
    const f = fixture([async (event, next) => {
      const one = next({ ...event, text: 'one' })
      if (style === 'sequential') await one
      const two = next({ ...event, text: 'two' })
      if (style !== 'unawaited') await Promise.all([one, two])
      return { drop: 'outer drop' }
    }])
    const ask = armAsk(f.context)
    const result = await f.run({ onPromptAdmission: (settled: any) => admissions.push(settled) })
    expect(result.shouldQuery).toBe(false)
    expect(admissions.map(settled => settled.admission.text)).toEqual(['one', 'two'])
    expect(admissions.every(settled => settled.shouldQuery)).toBe(true)
    expect(additionalContexts(admissions[0])).toEqual([ask.text])
    expect(additionalContexts(admissions[1])).toEqual([])
    expect(additionalContexts(result)).toEqual([ask.text])
    expect(ask.finishes).toEqual([true])
    expect(f.diagnostics).toEqual([])
    expect(f.calls.releases).toBe(1)
  })

  test.each(['classic', 'Mod'])('%s block, stop and throw release Ask for the next accepted prompt', async path => {
    for (const failure of ['block', 'stop', 'throw']) {
      const f = fixture(path === 'Mod' ? [async (event, next) => next(event)] : [])
      const ask = armAsk(f.context)
      const admissions: any[] = []
      if (failure === 'throw') f.classicHook.run = () => { throw new Error('classic failure') }
      else f.classicResults.push(failure === 'block' ? { blockingError: 'denied' } : { preventContinuation: true })
      const pending = f.run({ onPromptAdmission: (settled: any) => admissions.push(settled) })
      if (failure === 'throw') {
        await expect(pending).rejects.toThrow('classic failure')
        expect(admissions).toEqual([])
      } else {
        const result = await pending
        expect(result.shouldQuery).toBe(false)
        expect(additionalContexts(result)).not.toContain(ask.text)
        expect(admissions).toHaveLength(1)
        expect(admissions[0].admission.drop).toBeDefined()
      }
      expect(ask.finishes).toEqual([false])
      f.classicResults.length = 0
      f.classicHook.run = undefined
      const retried = await f.run()
      expect(retried.shouldQuery).toBe(true)
      expect(additionalContexts(retried)).toEqual([ask.text])
      expect(ask.finishes).toEqual([false, true])
    }
  })

  test.each(['classic', 'Mod'])('%s cancellation racing admission settles Ask exactly once', async path => {
    // Sweep microtask timings rather than relying on a particular number of
    // awaits inside production: cancellation either precedes or follows admission.
    for (let delay = 0; delay < 20; delay++) {
      const f = fixture(path === 'Mod' ? [async (event, next) => next(event)] : [])
      const ask = armAsk(f.context)
      const admissions: any[] = []
      const abortedAtAdmission: boolean[] = []
      const cancelled = new Error('cancel at admission')
      f.classicHook.run = () => {
        const cancel = (remaining: number) => {
          if (remaining === 0) f.controller.abort(cancelled)
          else queueMicrotask(() => cancel(remaining - 1))
        }
        cancel(delay)
      }
      await f.run({ onPromptAdmission: (settled: any) => {
        abortedAtAdmission.push(f.controller.signal.aborted)
        admissions.push(settled)
      } }).catch((error: unknown) => { expect(error).toBe(cancelled) })
      expect(abortedAtAdmission).not.toContain(true)
      expect(ask.finishes).toEqual([admissions.length > 0])
    }
  })

  test('an already cancelled classic prompt releases Ask without running hooks', async () => {
    const f = fixture()
    const ask = armAsk(f.context)
    f.controller.abort(new Error('already cancelled'))
    const admissions: any[] = []
    await expect(f.run({ onPromptAdmission: (settled: any) => admissions.push(settled) }))
      .rejects.toThrow('already cancelled')
    expect(f.classicInputs).toEqual([])
    expect(admissions).toEqual([])
    expect(ask.finishes).toEqual([false])
  })

  test('classic cancellation while hooks run releases Ask and admits nothing', async () => {
    const f = fixture()
    const ask = armAsk(f.context)
    const admissions: any[] = []
    f.classicHook.run = () => { f.controller.abort(new Error('cancel before admission')) }
    await expect(f.run({ onPromptAdmission: (settled: any) => admissions.push(settled) }))
      .rejects.toThrow('cancel before admission')
    expect(admissions).toEqual([])
    expect(ask.finishes).toEqual([false])
    f.classicHook.run = undefined
    f.context.abortController = new AbortController()
    const retried = await f.run()
    expect(retried.shouldQuery).toBe(true)
    expect(additionalContexts(retried)).toEqual([ask.text])
    expect(ask.finishes).toEqual([false, true])
  })

  test('Mod admission budgets Ask against entered context without changing its receipt', async () => {
    const modContext = ['m'.repeat(31900)]
    const f = fixture([async (event, next) => {
      const receipt = await next({ ...event, text: 'rewritten', context: modContext })
      expect(receipt).toEqual({ text: 'rewritten', context: modContext, origin: { kind: 'unclassified' } })
      return receipt
    }])
    const ask = armAsk(f.context)
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fixture-image' } }
    const existing = { type: 'attachment', attachment: { type: 'fixture', content: 'existing' } }
    f.attachmentMessages.push(existing)
    const admissions: any[] = []
    const result = await f.run({
      input: [image, { type: 'text', text: 'original' }],
      onPromptAdmission: (settled: any) => {
        expect(ask.finishes).toEqual([true])
        admissions.push(settled)
      },
    })
    expect(result.shouldQuery).toBe(true)
    expect(additionalContexts(result)).toEqual([...modContext, ask.text])
    expect(additionalContexts(admissions[0])).toEqual([...modContext, ask.text])
    expect(userTexts(result)).toEqual([[image, { type: 'text', text: 'rewritten' }]])
    expect(result.messages).toContain(existing)
    expect(ask.budgets).toEqual([modContext])
    expect(f.diagnostics).toEqual([])
    expect(ask.finishes).toEqual([true])
  })

  test('classic admission carries Ask once without Mods and preserves images and attachments', async () => {
    const f = fixture()
    Object.assign(f.context, { mods: undefined })
    const ask = armAsk(f.context)
    const image = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'fixture-image' },
    }
    const existing = { type: 'attachment', attachment: { type: 'fixture', content: 'existing' } }
    f.attachmentMessages.push(existing)
    f.classicResults.push({ additionalContexts: ['classic context'] })
    const admissions: any[] = []
    const result = await f.run({
      input: [image, { type: 'text', text: 'explain this' }],
      pastedContents: { 1: { id: 1, type: 'image', content: 'pasted-image', mediaType: 'image/jpeg' } },
      onPromptAdmission: (settled: any) => {
        expect(ask.finishes).toEqual([true])
        admissions.push(settled)
      },
    })
    expect(result.shouldQuery).toBe(true)
    expect(admissions).toEqual([result])
    expect(userTexts(result)[0]).toEqual([
      image,
      { type: 'text', text: 'explain this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'pasted-image' } },
    ])
    expect(result.messages).toContain(existing)
    expect(additionalContexts(result)).toEqual(expect.arrayContaining([ask.text, 'classic context']))
    expect(ask.budgets).toEqual([[]])
    expect(additionalContexts(await f.run())).toEqual(['classic context'])
    expect(ask.finishes).toEqual([true])
  })
})

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
    const added = ['hunk notes\n' + 'x'.repeat(100001), 'y'.repeat(100000)]
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
    expect(attachments[0].content).toHaveLength(1)
    expect(attachments[0].content[0]).toContain('Full output saved to:')
    expect(attachments[0].content[0]).toContain('Preview')
    expect(attachments[0].content[0]).not.toContain('y'.repeat(100000))
    expect(attachments[1].content[0]).toContain('[output truncated')
    expect(f.calls.slash).toBe(0)
  })

  test.each([
    { length: 100000, persisted: false },
    { length: 100001, persisted: true },
  ])('persists one context item only past the 100000-character boundary', async ({ length, persisted }) => {
    const writes: string[] = []
    const f = fixture(
      [async (event, next) => next({ ...event, context: ['x'.repeat(length)] })],
      false,
      {
        persistToolResult: async (content: string, toolUseID: string) => {
          writes.push(content)
          return {
            filepath: `/fixture/${toolUseID}.txt`,
            originalSize: content.length,
            isJson: false,
            preview: content.slice(0, 32),
            hasMore: content.length > 32,
          }
        },
      },
    )
    const result = await f.run()
    expect(writes).toHaveLength(persisted ? 1 : 0)
    expect(additionalContexts(result)[0]).toEqual(
      persisted ? expect.stringContaining('Full output saved to:') : 'x'.repeat(length),
    )
  })

  test.each([
    { length: 100000, persisted: false },
    { length: 100001, persisted: true },
  ])('persists aggregate context only past the 200000-character boundary', async ({ length, persisted }) => {
    const writes: string[] = []
    const context = ['x'.repeat(length), 'y'.repeat(100000)]
    const f = fixture(
      [async (event, next) => next({ ...event, context })],
      false,
      {
        persistToolResult: async (content: string, toolUseID: string) => {
          writes.push(content)
          return {
            filepath: `/fixture/${toolUseID}.txt`,
            originalSize: content.length,
            isJson: false,
            preview: content.slice(0, 32),
            hasMore: content.length > 32,
          }
        },
      },
    )
    const result = await f.run()
    expect(writes).toHaveLength(persisted ? 1 : 0)
    expect(additionalContexts(result)).toEqual(
      persisted
        ? [expect.stringContaining('Full output saved to:')]
        : context,
    )
    if (persisted) expect(writes[0]).toBe(JSON.stringify(context))
  })

  test('reports context persistence failure without inventing a saved path or rerunning the prompt', async () => {
    let calls = 0
    const f = fixture(
      [async (event, next) => {
        calls++
        return next({ ...event, context: ['x'.repeat(100001)] })
      }],
      false,
      {
        persistToolResult: async () => ({ error: 'fixture write failed' }),
      },
    )
    const result = await f.run()
    expect(calls).toBe(1)
    expect(additionalContexts(result)[0]).toContain('fixture write failed')
    expect(additionalContexts(result)[0]).toContain('showing only the head')
    expect(additionalContexts(result)[0]).not.toContain('Full output saved to:')
  })

  test('does not publish context when cancellation wins during persistence', async () => {
    const persisted = Promise.withResolvers<Record<string, unknown>>()
    const f = fixture(
      [async (event, next) => next({ ...event, context: ['x'.repeat(100001)] })],
      false,
      { persistToolResult: () => persisted.promise },
    )
    const running = f.run()
    await Promise.resolve()
    await Promise.resolve()
    f.controller.abort()
    persisted.resolve({
      filepath: '/fixture/context.txt',
      originalSize: 100001,
      isJson: false,
      preview: 'x'.repeat(32),
      hasMore: true,
    })
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
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

  test('uses proactive prompt attachment descriptors when no binary blocks exist', async () => {
    const f = fixture([async (event, next) => next(event)])
    await f.run({
      promptSubmitMetadata: {
        origin: { kind: 'plugin', name: 'fixture' },
        wait: false,
        attachments: [
          {
            type: 'document',
            mediaType: 'application/pdf',
            filename: 'notes.pdf',
          },
        ],
      },
    })
    expect(f.events[0]?.attachments).toEqual([
      {
        type: 'document',
        mediaType: 'application/pdf',
        filename: 'notes.pdf',
      },
    ])
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
      expect(ask.finishes).toEqual([true])
      expect(additionalContexts(queue[0].admitted)).toEqual(['private context', ask.text])
      expect(receipt.text).toBe('rewritten')
      expect(queries).toEqual([])
      return { ...receipt, text: 'too late' }
    }])
    const ask = armAsk(f.context)
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
    const nextAsk = armAsk(f.context, 'new snapshot after enqueue')
    await functions.handlePromptSubmit({ ...params, queuedCommands: queue.splice(0) })
    expect(nextAsk.budgets).toEqual([])
    expect(nextAsk.finishes).toEqual([])
    expect(ask.budgets).toEqual([['private context']])
    expect(ask.finishes).toEqual([true])
    expect(additionalContexts({ messages: queries[0]![0] })).toEqual(['private context', ask.text])
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
