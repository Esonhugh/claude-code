import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as React from 'react'
import { PassThrough } from 'node:stream'
import { render } from '../ink.js'
import { useInputBuffer, type UseInputBufferResult } from '../hooks/useInputBuffer.js'
import { runImmediateModCommand } from '../services/mods/commandAdapter.js'
import { fillPromptBox } from '../services/mods/promptAdapter.js'
import { isCommandImmediate } from '../types/command.js'
import { DiffController } from '../services/diff/controller.js'

// Execute the actual callbacks without importing REPL's startup/services graph.
function extract(path: string, name: string, kind: 'callback' | 'function' | 'effect' = 'callback') {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const matches: ts.Node[] = []
  function visit(node: ts.Node) {
    if (kind === 'callback' && ts.isVariableDeclaration(node) && node.name.getText(file) === name &&
      node.initializer && ts.isCallExpression(node.initializer)) {
      matches.push(node.initializer.arguments[0]!)
    }
    if (kind === 'function' && ts.isFunctionDeclaration(node) && node.name?.text === name) matches.push(node)
    if (kind === 'effect' && ts.isCallExpression(node) && node.expression.getText(file) === 'useEffect' &&
      node.arguments[0]?.getText(file).includes(name)) matches.push(node.arguments[0])
    ts.forEachChild(node, visit)
  }
  visit(file)
  expect(matches).toHaveLength(1)
  const text = matches[0]!.getText(file).replace(/^export /, '')
  const js = ts.transpileModule(`const extracted = (${text});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
    transformers: { before: [context => root => {
      const visit = (node: ts.Node): ts.VisitResult<ts.Node> =>
        ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? ts.factory.updateCallExpression(node, ts.factory.createIdentifier('importModule'), node.typeArguments, node.arguments)
          : ts.visitEachChild(node, visit, context)
      return ts.visitNode(root, visit) as ts.SourceFile
    }] },
  }).outputText
  return (scope: Record<string, any>) => new Function('scope', `with (scope) { ${js}; return extracted; }`)(scope)
}

const makeSubmit = extract('./REPL.tsx', 'onSubmit')
const makeHandle = extract('../utils/handlePromptSubmit.ts', 'handlePromptSubmit', 'function')
const makeExecute = extract('../utils/handlePromptSubmit.ts', 'executeUserInput', 'function')
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}
const noop = () => {}


test('Mods prompt host reads and fills the live mounted PromptInput bridge', async () => {
  let services: any
  const inputValueRef = { current: 'A😀B' }
  const modPromptBlockedRef = { current: false }
  const setInputWithCursorCalls: unknown[] = []
  const insertTextRef = {
    current: {
      cursorOffset: 3,
      insert: noop,
      setInputWithCursor: (text: string, cursor: number) => {
        inputValueRef.current = text
        insertTextRef.current.cursorOffset = cursor
        setInputWithCursorCalls.push([text, cursor])
      },
    },
  }
  const awaitMods = extract('./REPL.tsx', 'awaitMods')({
    modsSession: {
      bind: async (_binding: unknown, _set: unknown, host: unknown) => {
        services = host
      },
    },
    getCwd: () => '/repo',
    getOriginalCwd: () => '/repo',
    getSessionId: () => 'session',
    setAppState: noop,
    messagesRef: { current: [] },
    modToolContextRef: { current: noop },
    inputValueRef,
    insertTextRef,
    modPromptBlockedRef,
    fillPromptBox,
  })
  await awaitMods()
  const prompt = services.prompt()
  expect(prompt.read()).toEqual({ text: 'A😀B', cursor: 3 })
  expect(prompt.fill({ text: 'x', mode: 'insert' })).toBe(true)
  expect(setInputWithCursorCalls).toEqual([['A😀xB', 4]])
  expect(prompt.read()).toEqual({ text: 'A😀xB', cursor: 4 })
  modPromptBlockedRef.current = true
  expect(prompt.isBlocked()).toBe(true)
})

test('successful edits reach the transcript and auto-open diff without a Mods runtime', async () => {
  let state = { diffSidebarVisible: false }
  let messages: any[] = []
  const surfaces: any[] = []
  const errors: unknown[] = []
  const diff = new DiffController({ cwd: '/synthetic' })
  diff.autoOpen = async surface => { surfaces.push(surface); return true }
  const onEvent = extract('./REPL.tsx', 'onQueryEvent')({
    handleMessageFromStream: (event: any, append: any) => append(event),
    diffController: diff, store: { getState: () => state },
    modsSession: { runtime: undefined, ui: { getSnapshot: () => [] } },
    getSessionId: () => 'synthetic-session', process: { stdout: { columns: 144 } },
    isFullscreenEnvEnabled: () => true, fileHistoryEnabled: () => true,
    MIN_DIFF_SIDEBAR_COLUMNS: 110, logError: (error: unknown) => errors.push(error),
    setAppState: (fn: any) => { state = fn(state) },
    setMessages: (fn: any) => { messages = fn(messages) },
    isCompactBoundaryMessage: () => false, feature: () => false,
    setResponseLength: noop, setStreamMode: noop, setStreamingToolUses: noop,
    setStreamingThinking: noop, onStreamingText: undefined,
  })
  const assistant = { type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'edit-1', name: 'Edit', input: {} },
  ] } }
  const result = { type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'edit-1', content: 'done' },
  ] } }
  try {
    onEvent(assistant)
    onEvent(result)
    await Promise.resolve()
    await Promise.resolve()
    expect(messages).toEqual([assistant, result])
    expect(surfaces).toEqual([{ columns: 144, isFullscreen: true, hasDock: false, checkpointing: true }])
    expect(state.diffSidebarVisible).toBe(true)
    expect(errors).toEqual([])
  } finally {
    diff.dispose()
  }
})

test('diff open preference is global while base stays repository scoped', async () => {
  let config: any = { diffPreferences: { '/repo-a': { mode: 'branch' }, '/repo-b': { mode: 'uncommitted' } } }
  let cwd = '/repo-a'
  const makeDiff = extract('./REPL.tsx', '[diffController]')({
    isRemoteExecutionSession: false, DiffController, initialMessages: [],
    getCwd: () => cwd, addNotification: noop,
    getGlobalConfig: () => config,
    saveGlobalConfig: (fn: any) => { config = fn(config) },
  })
  const first = makeDiff() as DiffController
  first.setOpenPreference(false)
  expect(config.diffSidebarOpen).toBe(false)
  expect(config.diffPreferences).toEqual({ '/repo-a': { mode: 'branch' }, '/repo-b': { mode: 'uncommitted' } })
  cwd = '/repo-b/subdir'
  const second = makeDiff() as DiffController
  // A global close must suppress opening without probing this other repository.
  second.refresh = () => { throw new Error('unexpected Git probe') }
  expect(await second.autoOpen({ columns: 144, isFullscreen: true, checkpointing: true, hasDock: false })).toBe(false)
  second.setOpenPreference(true)
  expect(config.diffSidebarOpen).toBe(true)
  first.dispose()
  second.dispose()
})

test('startup resume dates the diff baseline from activation, not historical messages', async () => {
  const starts: number[] = []
  class ObservedController extends DiffController {
    constructor(options: ConstructorParameters<typeof DiffController>[0]) {
      super({ ...options, createBackend: async options => { starts.push(options.sessionStartMs); return null } })
    }
  }
  const before = Date.now()
  const diff = extract('./REPL.tsx', '[diffController]')({
    isRemoteExecutionSession: false, DiffController: ObservedController,
    initialMessages: [{ timestamp: '2020-01-01T00:00:00Z' }],
    getCwd: () => '/repo', addNotification: noop, getGlobalConfig: () => ({}), saveGlobalConfig: noop,
  })() as DiffController
  await diff.refresh()
  expect(starts[0]).toBeGreaterThanOrEqual(before)
  diff.dispose()
})

test('diff keeps open intent across temporary width and dock restrictions but respects an explicit close', () => {
  const source = readFileSync(new URL('./REPL.tsx', import.meta.url), 'utf8')
  const file = ts.createSourceFile('REPL.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let layout = ''
  let visible = ''
  function visit(node: ts.Node) {
    if (ts.isBlock(node)) {
      const start = node.statements.findIndex(statement => ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(declaration => declaration.name.getText(file) === 'canShowDiffSidebar'))
      if (start !== -1) {
        const statements = [node.statements[start]!]
        for (const statement of node.statements.slice(start + 1)) {
          if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression) ||
            statement.expression.expression.getText(file) !== 'useEffect') break
          statements.push(statement)
        }
        layout = statements.map(statement => statement.getText(file)).join('\n')
      }
    }
    if (ts.isJsxAttribute(node) && node.name.getText(file) === 'sidebarPane' &&
      node.initializer && ts.isJsxExpression(node.initializer) &&
      node.initializer.expression && ts.isConditionalExpression(node.initializer.expression)) {
      visible = node.initializer.expression.condition.getText(file)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  expect(layout).not.toBe('')
  expect(visible).not.toBe('')
  const js = ts.transpileModule(`${layout}\nreturn ${visible};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  let state = { diffSidebarVisible: true }
  let fullscreen = true
  const scope = {
    get diffSidebarVisible() { return state.diffSidebarVisible },
    modTerminalSize: { columns: 144 }, modDock: [] as unknown[],
    MIN_DIFF_SIDEBAR_COLUMNS: 110, isFullscreenEnvEnabled: () => fullscreen,
    useEffect: (effect: () => void) => effect(),
    setAppState: (update: (previous: typeof state) => typeof state) => { state = update(state) },
  }
  const renderSidebar = () => new Function('scope', `with (scope) { ${js} }`)(scope)
  expect(renderSidebar()).toBe(true)
  scope.modTerminalSize.columns = 109
  expect(renderSidebar()).toBe(false)
  expect(state.diffSidebarVisible).toBe(true)
  scope.modTerminalSize.columns = 110
  expect(renderSidebar()).toBe(true)
  scope.modDock = [{}]
  expect(renderSidebar()).toBe(false)
  expect(state.diffSidebarVisible).toBe(true)
  scope.modDock = []
  expect(renderSidebar()).toBe(true)
  fullscreen = false
  expect(renderSidebar()).toBe(false)
  fullscreen = true
  expect(renderSidebar()).toBe(true)
  state.diffSidebarVisible = false
  for (const columns of [109, 110, 144]) {
    scope.modTerminalSize.columns = columns
    expect(renderSidebar()).toBe(false)
  }
})

test('Diff dialog owns scroll keys while unrelated overlays keep transcript scrolling', () => {
  const source = readFileSync(new URL('./REPL.tsx', import.meta.url), 'utf8')
  const file = ts.createSourceFile('REPL.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let expression = ''
  let declaration = ''
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'diffDialogActive')
      declaration = `const ${node.getText(file)};`
    if (ts.isJsxAttribute(node) && node.name.getText(file) === 'isKeyboardActive' &&
      node.initializer && ts.isJsxExpression(node.initializer))
      expression = node.initializer.expression!.getText(file)
    ts.forEachChild(node, visit)
  }
  visit(file)
  expect(expression).not.toBe('')
  const js = ts.transpileModule(`${declaration}\nreturn ${expression};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  const state = { activeOverlays: new Set<string>() }
  const scope = { modPaneFocused: false, useAppState: (select: (s: typeof state) => unknown) => select(state) }
  const active = () => new Function('scope', `with (scope) { ${js} }`)(scope)
  expect(active()).toBe(true)
  state.activeOverlays.add('diff-dialog')
  expect(active()).toBe(false)
  state.activeOverlays.clear()
  state.activeOverlays.add('other-dialog')
  expect(active()).toBe(true)
  scope.modPaneFocused = true
  expect(active()).toBe(false)
})

test('diff lifecycle follows session identity, not compaction row keys', () => {
  const resets: string[] = []
  let state = { diffSidebarVisible: true }
  const scope = {
    diffSession: { current: 'session-a' }, diffSessionId: 'session-a',
    conversationId: 'new-compact-row-key', diffCwd: '/repo',
    diffController: { cwd: '/repo', reset: (cwd: string) => resets.push(cwd) },
    setAppState: (fn: any) => { state = fn(state) },
  }
  const effect = extract('./REPL.tsx', 'diffSession.current', 'effect')(scope)
  effect()
  expect(resets).toEqual([])
  expect(state.diffSidebarVisible).toBe(true)
  scope.diffSessionId = 'session-b'
  effect()
  expect(resets).toEqual(['/repo'])
  expect(state.diffSidebarVisible).toBe(false)
})

test('successful same-ID resume resets diff without waiting for identity change', async () => {
  let resets = 0
  let state: any = { diffSidebarVisible: true }
  let replaced = false
  const diffSession = { current: 'same-id' }
  const resume = extract('./REPL.tsx', 'resume')({
    deserializeMessages: (messages: any) => [...messages], feature: () => false,
    getSessionEndHookTimeoutMs: () => 1000, executeSessionEndHooks: async () => {},
    processSessionStartHooks: async () => [], mainThreadAgentDefinition: undefined,
    mainLoopModel: 'synthetic', copyPlanForResume: noop, restoreSessionStateFromLog: noop,
    restoreAgentFromSession: () => ({}), initialMainThreadAgentDefinition: undefined,
    agentDefinitions: {}, setMainThreadAgentDefinition: noop,
    setAppState: (fn: any) => { state = fn(state) }, computeStandaloneAgentContext: noop,
    updateSessionName: noop, restoreReadFileState: noop, getOriginalCwd: () => '/repo',
    getCwd: () => '/repo', resetLoadingState: noop, setAbortController: noop,
    setConversationId: noop, getStoredSessionCosts: noop, saveCurrentSessionCosts: noop,
    resetCostState: noop, switchSession: noop, asSessionId: (id: string) => id,
    importModule: async () => ({ renameRecordingForSession: async () => {} }),
    resetSessionFilePointer: async () => {}, clearSessionMetadata: noop,
    restoreSessionMetadata: noop, haikuTitleAttemptedRef: { current: false },
    setHaikuTitle: noop, exitRestoredWorktree: noop, restoreWorktreeForResume: noop,
    adoptResumedSessionFile: noop, restoreRemoteAgentTasks: noop, store: { getState: () => state },
    setMessages: () => { replaced = true }, modsSession: undefined,
    restoreGoalSessionFromLog: noop, contentReplacementStateRef: { current: null },
    setToolJSX: noop, setInputValue: noop, logEvent: noop, diffSession,
    getSessionId: () => 'same-id', diffController: { reset: () => { resets++ } },
  })
  await resume('same-id', { messages: [] }, 'command')
  expect(replaced).toBe(true)
  expect(resets).toBe(1)
  expect(state.diffSidebarVisible).toBe(false)
  expect(diffSession.current).toBe('same-id')
})

test('rewind resets diff state even though the session ID is unchanged', () => {
  const target = { type: 'user', uuid: 'target' }
  let resets = 0
  let state = { diffSidebarVisible: true, toolPermissionContext: { mode: 'default' } }
  const rewind = extract('./REPL.tsx', 'rewindConversationTo')({
    messagesRef: { current: [target] }, logEvent: noop, setMessages: noop,
    setConversationId: noop, randomUUID: () => 'new-rows', resetMicrocompactState: noop,
    feature: () => false, getCwd: () => '/repo',
    diffController: { reset: () => { resets++ } },
    setAppState: (fn: any) => { state = fn(state) },
  })
  rewind(target)
  expect(resets).toBe(1)
  expect(state.diffSidebarVisible).toBe(false)
})

function harness({ active = true, gap = 'mods', input = 'submitted', mode = 'prompt', stash = undefined as any,
  commands = [] as any[], result = {} as any, remote = false } = {}) {
  const mods = deferred()
  const hooks = deferred()
  if (gap !== 'mods') mods.resolve()
  if (gap !== 'hooks') hooks.resolve()
  const draft = { text: input, cursor: input.length, mode, paste: {} as any, undo: ['old'], history: 3, stash }
  const epoch = { current: 0 }
  const ref = { current: input }
  const modeRef = { current: mode }
  const pasteRef = { current: draft.paste }
  const stashRef = { current: stash }
  const mutate = (fn: () => void) => { epoch.current++; fn() }
  const setText = (v: string) => mutate(() => { draft.text = v; ref.current = v })
  const setMode = (v: string) => mutate(() => { draft.mode = v; modeRef.current = v })
  const setPaste = (v: any) => mutate(() => { draft.paste = typeof v === 'function' ? v(pasteRef.current) : v; pasteRef.current = draft.paste })
  const setStash = (v: any) => mutate(() => { draft.stash = v; stashRef.current = v })
  const helpers = {
    getCursorOffset: () => draft.cursor,
    setCursorOffset: (v: number) => mutate(() => { draft.cursor = v }),
    clearBuffer: () => mutate(() => { draft.undo = [] }),
    resetHistory: () => mutate(() => { draft.history = -1 }),
  }
  const guard = { isActive: active, reserve() { this.isActive = true }, cancelReservation() { this.isActive = false } }
  const executions: any[] = []
  const queued: any[] = []
  const history: any[] = []
  const remoteMessages: any[] = []
  const lowerScope: Record<string, any> = {
    parseReferences: (s: string) => [...s.matchAll(/\[Image #(\d+)\]/g)].map(m => ({ id: Number(m[1]) })), expandPastedTextRefs: (s: string) => s,
    isValidImagePaste: (c: any) => c.type === 'image', isCommandEnabled: () => true,
    getCommandName: (c: any) => c.name, logEvent: noop, logForDebugging: noop,
    enqueue: (v: any) => queued.push(v), startQueryProfile: noop, queryCheckpoint: noop,
    createAbortController: () => new AbortController(), runWithWorkload: (_: any, fn: any) => fn(),
    runImmediateModCommand, isCommandImmediate,
    processUserInput: async (p: any) => {
      executions.push(p)
      const settled = p.mode === 'prompt' && (p.skipSlashCommands || !p.input.startsWith('/'))
        ? { messages: [{ type: 'user', uuid: 'test-message', message: { content: p.input } }], shouldQuery: true, ...result }
        : { messages: [], shouldQuery: false, ...result }
      p.onPromptAdmission?.(settled)
      return settled
    },
    fileHistoryEnabled: () => false, createUserMessage: (p: any) => ({ ...p, uuid: 'test-message' }),
  }
  lowerScope.executeUserInput = makeExecute(lowerScope)
  lowerScope.handlePromptSubmit = makeHandle(lowerScope)
  const scope: Record<string, any> = {
    ...lowerScope, inputValueRef: ref, inputModeRef: modeRef,
    draftGenerationRef: epoch, pastedContentsRef: pasteRef, stashedPromptRef: stashRef,
    inputMode: mode, pastedContents: draft.paste, stashedPrompt: stash,
    setInputValue: setText, setInputMode: setMode, setPastedContents: setPaste, setStashedPrompt: setStash,
    repinScroll: noop, feature: () => false,
    modsSession: { runtime: { activePublicTurnId: active ? 'turn-active' : undefined } }, awaitMods: () => mods.promise,
    awaitPendingHooks: () => hooks.promise, commands, getCurrentCommands: () => commands, queryGuard: guard, isLoading: active,
    isExternalLoading: false, activeRemote: { isRemoteMode: remote, sendMessage: async (c: any) => { remoteMessages.push(c); return true } },
    sshRemote: { isRemoteMode: false }, isRemoteExecutionSession: false,
    getFeatureValue_CACHED_MAY_BE_STALE: () => 'off', idleHintShownRef: { current: false },
    lastQueryCompletionTimeRef: { current: 0 }, skipIdleCheckRef: { current: false },
    getGlobalConfig: () => ({}), getTotalInputTokens: () => 0,
    addToHistory: (v: any) => history.push(v), prependModeCharacterToInput: (s: string, m: string) => m === 'bash' ? '!' + s : s,
    prependToShellHistoryCache: noop, setIDESelection: noop, setSubmitCount: noop,
    tipPickedThisTurnRef: { current: false }, setUserInputOnProcessing: noop, resetTimingRefs: noop,
    setToolJSX: noop, getToolUseContext: () => ({}), messagesRef: { current: [] },
    mainLoopModel: 'test', ideSelection: { text: 'selection-at-submit' }, setAbortController: noop,
    abortController: undefined, onQuery: async () => {}, setAppState: noop, getQuerySourceForREPL: () => 'repl_main',
    onBeforeQuery: undefined, canUseTool: undefined, addNotification: noop, setMessages: noop,
    streamModeRef: { current: undefined }, hasInterruptibleToolInProgressRef: { current: false },
    isFullscreenEnvEnabled: () => true,
  }
  const submit = makeSubmit(scope)
  scope.onSubmitRef = { current: submit }
  return { submit, scope, lowerScope, helpers, draft, guard, executions, queued, history, epoch, remoteMessages,
    setText, setMode, setPaste, setStash, release: () => { mods.resolve(); hooks.resolve() } }
}

for (const gap of ['mods', 'hooks']) {
  test(`${gap}: active→idle consumes the draft once, before the barrier`, async () => {
    const h = harness({ gap })
    const pending = h.submit('submitted', h.helpers)
    // For the second gap, let the already-resolved Mods barrier advance.
    await Promise.resolve()
    expect(h.draft.text).toBe('')
    expect(h.draft.undo).toEqual([])
    h.guard.isActive = false
    h.release()
    await pending
    expect(h.executions).toHaveLength(1)
    expect(h.queued).toHaveLength(0)
    expect(h.draft.text).toBe('')
  })

  test(`${gap}: queueing must not clear a new draft or change submitted mode`, async () => {
    const h = harness({ gap, mode: 'bash' })
    const pending = h.submit('submitted', h.helpers)
    await Promise.resolve()
    h.setText('next draft')
    h.setMode('prompt')
    h.setPaste({ 7: { id: 7, type: 'image', content: 'new' } })
    h.helpers.setCursorOffset(2)
    h.draft.undo = ['next undo']
    h.release()
    await pending
    expect(h.queued).toHaveLength(1)
    expect(h.queued[0].mode).toBe('bash')
    expect(h.draft).toMatchObject({ text: 'next draft', cursor: 2, mode: 'prompt', undo: ['next undo'] })
    expect(h.draft.paste[7].content).toBe('new')
  })
}

test('commands activated during the Mods barrier are available before a React render', async () => {
  let calls = 0
  const h = harness({input:'/new-panel'})
  const pending = h.submit('/new-panel', h.helpers)
  const command = {name:'new-panel', type:'local-jsx', immediate:true,
    load:async () => ({call:(done:any) => {calls++; done()}})}
  h.scope.getCurrentCommands = () => [command]
  h.release()
  await pending
  expect(calls).toBe(1)
  expect(h.queued).toEqual([])
})

for (const active of [true, false]) {
  for (const wait of [false, true]) {
    test(`composer metadata survives ${active ? 'queue' : 'direct'} ${wait ? 'queue-submit' : 'plain'} dispatch`, async () => {
      const h = harness({active})
      const pending = h.submit('submitted', h.helpers, undefined, { wait })
      h.release()
      await pending
      const received = active ? h.queued[0] : h.executions[0]
      expect(received.promptSubmitMetadata).toEqual({
        origin: { kind: 'composer' },
        wait,
        ...(active ? { turnId: 'turn-active' } : {}),
      })
    })
  }
}

test('turnId is captured before barriers while scheduling uses the live guard', async () => {
  const h = harness()
  const pending = h.submit('submitted', h.helpers)
  h.scope.modsSession.runtime.activePublicTurnId = 'newer-turn'
  h.guard.isActive = false
  h.release()
  await pending
  expect(h.executions[0].promptSubmitMetadata.turnId).toBe('turn-active')
  expect(h.queued).toEqual([])
})

test('idle ingress does not acquire a later turnId when another turn starts during barriers', async () => {
  const h = harness({ active: false })
  const pending = h.submit('submitted', h.helpers)
  h.guard.isActive = true
  h.scope.modsSession.runtime.activePublicTurnId = 'later-turn'
  h.release()
  await pending
  expect(h.queued).toHaveLength(1)
  expect(h.queued[0].promptSubmitMetadata).toEqual({ origin: { kind: 'composer' }, wait: false })
  expect(h.executions[0].promptSubmitMetadata.turnId).toBeUndefined()
})

test('late nextInput must not overwrite a same-text new edit', async () => {
  const h = harness({ active: false, input: '/later', result: { nextInput: 'command result' } })
  const pending = h.submit('/later', h.helpers)
  h.setText('/later')
  h.release()
  await pending
  expect(h.draft.text).toBe('/later')
})

test('keybinding never consumes the existing draft even if its text equals the command', async () => {
  const h = harness({ active: false, input: '/config', mode: 'bash' })
  const before = structuredClone(h.draft)
  const pending = h.submit('/config', h.helpers, undefined, { fromKeybinding: true })
  h.release()
  await pending
  expect(h.draft).toEqual(before)
  expect(h.history).toEqual([])
})

const savedStash = { text: 'saved draft', cursorOffset: 2, pastedContents: { 4: { id: 4, type: 'text', content: 'saved' } } }

for (const active of [false, true]) {
  for (const input of ['normal', '/command']) {
    test(`stash restores once: ${active ? 'queued' : 'direct'} ${input}`, async () => {
      const h = harness({ active, input, stash: savedStash })
      const pending = h.submit(input, h.helpers)
      h.release()
      await pending
      expect(h.draft.text).toBe(savedStash.text)
      expect(h.draft.cursor).toBe(2)
      expect(h.draft.paste).toEqual(savedStash.pastedContents)
      expect(h.draft.stash).toBeUndefined()
      expect(h.executions).toHaveLength(active && input.startsWith('/') ? 0 : 1)
      expect(h.queued).toHaveLength(active ? 1 : 0)
    })
  }
}

const edits: Record<string, (h: ReturnType<typeof harness>) => void> = {
  text: h => h.setText('new draft'),
  'same text after editing': h => { h.setText('temporary'); h.setText('') },
  attachment: h => h.setPaste({ 7: { id: 7, type: 'image', content: 'new' } }),
  mode: h => h.setMode('bash'),
  cursor: h => h.helpers.setCursorOffset(0),
  undo: h => h.helpers.clearBuffer(),
  history: h => h.helpers.resetHistory(),
  stash: h => h.setStash({ ...savedStash, text: 'new stash' }),
}
for (const [name, edit] of Object.entries(edits)) {
  test(`late nextInput and stash preserve ${name} even with empty text`, async () => {
    const h = harness({ active: false, input: '/later', stash: savedStash, result: { nextInput: 'result' } })
    const pending = h.submit('/later', h.helpers)
    edit(h)
    const edited = structuredClone(h.draft)
    h.release()
    await pending
    expect(h.draft).toEqual(edited)
    expect(h.draft.stash).toBeDefined()
  })
}

test('legitimate nextInput wins over stash and keeps the stash available', async () => {
  const h = harness({ active: false, input: '/later', stash: savedStash, result: { nextInput: 'result' } })
  const pending = h.submit('/later', h.helpers)
  h.release()
  await pending
  expect(h.draft.text).toBe('result')
  expect(h.draft.cursor).toBe(6)
  expect(h.draft.stash).toEqual(savedStash)
})

test('submitNextInput enqueues exactly once without consuming the new draft', async () => {
  const h = harness({ active: false, input: '/later', result: { nextInput: 'result', submitNextInput: true } })
  const pending = h.submit('/later', h.helpers)
  h.setText('new draft')
  h.release()
  await pending
  expect(h.queued).toEqual([{ value: 'result', mode: 'prompt' }])
  expect(h.draft.text).toBe('new draft')
})

for (const active of [true, false]) {
  for (const transition of [false, true]) {
    test(`keybinding preserves every draft field: active=${active}, transition=${transition}`, async () => {
      let calls = 0
      const command = { name: 'config', type: 'local-jsx', immediate: true,
        load: async () => ({ call: (done: any) => { calls++; done(undefined, { nextInput: 'result' }) } }) }
      const h = harness({ active, input: '/config', mode: 'bash', commands: [command], stash: savedStash,
        result: { nextInput: 'result' } })
      h.setPaste(savedStash.pastedContents)
      const before = structuredClone(h.draft)
      const pending = h.submit('/config', h.helpers, undefined, { fromKeybinding: true })
      if (transition) h.guard.isActive = !active
      h.release()
      await pending
      expect(h.draft).toEqual(before)
      expect(h.history).toEqual([])
      expect(calls + h.executions.length).toBe(1)
    })
  }
}

test('keybinding accepts nextInput only into its untouched empty composer', async () => {
  const h = harness({ active: false, input: '', result: { nextInput: 'result' } })
  const pending = h.submit('/config', h.helpers, undefined, { fromKeybinding: true })
  h.release()
  await pending
  expect(h.draft.text).toBe('result')
})

for (const nextInput of [undefined, 'replacement']) {
  test(`immediate local-jsx restores stash or nextInput (${nextInput})`, async () => {
    const command = { name: 'config', type: 'local-jsx', immediate: true,
      load: async () => ({ call: (done: any) => done(undefined, { nextInput }) }) }
    const h = harness({ input: '/config', commands: [command], stash: savedStash })
    const pending = h.submit('/config', h.helpers)
    expect(h.draft.text).toBe('')
    h.release()
    await pending
    expect(h.executions).toEqual([])
    expect(h.queued).toEqual([])
    expect(h.draft.text).toBe(nextInput ?? savedStash.text)
    expect(h.draft.stash).toEqual(nextInput ? savedStash : undefined)
  })
}

test('immediate command load gap preserves a new draft and supports submitNextInput', async () => {
  const loading = deferred()
  const entered = deferred()
  const command = { name: 'config', type: 'local-jsx', immediate: true,
    load: async () => { entered.resolve(); await loading.promise; return {
      call: (done: any) => done(undefined, { nextInput: 'followup', submitNextInput: true }),
    } } }
  const h = harness({ input: '/config', commands: [command], stash: savedStash })
  const pending = h.submit('/config', h.helpers)
  h.release()
  await entered.promise
  h.setText('/config')
  loading.resolve()
  await pending
  expect(h.draft.text).toBe('/config')
  expect(h.draft.stash).toEqual(savedStash)
  expect(h.queued).toEqual([{ value: 'followup', mode: 'prompt' }])
})

test('dequeue executes real callback with NOOP editor helpers', async () => {
  const h = harness({ active: false, result: { nextInput: 'ignored' } })
  const before = structuredClone(h.draft)
  const executeQueued = extract('./REPL.tsx', 'executeQueuedInput')({ ...h.scope, messages: [] })
  await executeQueued([{ value: 'queued', mode: 'prompt' }])
  expect(h.executions).toHaveLength(1)
  expect(h.draft).toEqual(before)
  expect(h.history).toEqual([])
})

test('admitted queued prompt bypasses hooks on dequeue and carries settled turn text', async () => {
  const h = harness({ active: false })
  const queries: any[][] = []
  h.scope.onQuery = async (...args: any[]) => { queries.push(args) }
  const executeQueued = extract('./REPL.tsx', 'executeQueuedInput')({ ...h.scope, messages: [] })
  const message = { type: 'user', uuid: 'admitted-message', message: { content: 'rewritten' } }
  await executeQueued([{
    value: 'original',
    mode: 'prompt',
    admitted: {
      messages: [message],
      admission: { text: 'rewritten', context: ['reviewed'], origin: { kind: 'composer' } },
    },
  }])
  expect(h.executions).toEqual([])
  expect(queries).toHaveLength(1)
  expect(queries[0]![8]).toEqual({ text: 'rewritten' })
})

test('prompt admission runs before enqueue and the settled result is reused once', async () => {
  const h = harness()
  const gate = deferred()
  const entered = deferred()
  const message = { type: 'user', uuid: 'settled', message: { content: 'rewritten' } }
  const settled = { messages: [message], shouldQuery: true,
    admission: { text: 'rewritten', origin: { kind: 'composer' } } }
  h.lowerScope.processUserInput = async (p: any) => {
    h.executions.push(p)
    entered.resolve()
    await gate.promise
    p.onPromptAdmission?.(settled)
    expect(h.queued).toHaveLength(1)
    return settled
  }
  const pending = h.submit('submitted', h.helpers)
  h.release()
  await entered.promise
  expect(h.queued).toEqual([])
  h.setText('new draft')
  gate.resolve()
  await pending
  expect(h.queued[0].admitted.messages).toEqual([message])
  h.guard.isActive = false
  const queries: any[][] = []
  h.scope.onQuery = async (...args: any[]) => { queries.push(args) }
  const executeQueued = extract('./REPL.tsx', 'executeQueuedInput')({ ...h.scope, messages: [] })
  await executeQueued(h.queued.splice(0))
  expect(h.executions).toHaveLength(1)
  expect(queries[0]?.[0]).toEqual([message])
  expect(queries[0]?.[8]).toEqual({ text: 'rewritten' })
  expect(h.draft.text).toBe('new draft')
})

test('core refusal displays its reason without queueing or starting another turn', async () => {
  const warning = { type: 'system', content: 'blocked by core' }
  const h = harness({ result: { messages: [warning], shouldQuery: false, admission: { drop: 'blocked by core' } } })
  let messages: any[] = []
  h.scope.setMessages = (update: any) => { messages = update(messages) }
  h.scope.onQuery = async () => { throw new Error('refused input must not start a turn') }
  const pending = h.submit('submitted', h.helpers)
  h.release()
  await pending
  expect(h.queued).toEqual([])
  expect(messages).toEqual([warning])
  expect(h.guard.isActive).toBe(true)
})

test('batched admitted prompts retain each receipt and peer dequeue still skips hooks', async () => {
  const h = harness({ active: false })
  const queries: any[][] = []
  h.scope.onQuery = async (...args: any[]) => { queries.push(args) }
  const executeQueued = extract('./REPL.tsx', 'executeQueuedInput')({ ...h.scope, messages: [] })
  await executeQueued(['one', 'two'].map(text => ({
    value: `original ${text}`, mode: 'prompt',
    admitted: { shouldQuery: true, messages: [{ type: 'user', uuid: text, message: { content: text } }], admission: { text } },
  })))
  expect(h.executions).toEqual([])
  expect(queries[0]?.[0].map((message: any) => message.message.content)).toEqual(['one', 'two'])
  expect(queries[0]?.[8]).toEqual({ text: 'one\ntwo' })
  await executeQueued([{ value: '/peer-text', mode: 'prompt', skipSlashCommands: true, origin: { kind: 'peer' } }])
  expect(h.executions).toHaveLength(1)
  expect(h.executions[0].skipHooks).toBe(true)
  expect(h.executions[0].skipSlashCommands).toBe(true)
})

test('queued slash and bash keep deferred execution while remote slash text is admitted', async () => {
  for (const [mode, skipSlashCommands, input] of [
    ['prompt', false, '/status'], ['bash', false, 'pwd'], ['prompt', true, '/remote'],
  ] as const) {
    const h = harness({ input, mode })
    await h.lowerScope.handlePromptSubmit({
      ...h.scope, input, mode, skipSlashCommands,
      commands: [], messages: [], querySource: 'repl_main_thread',
      onInputChange: h.setText,
    })
    expect(h.queued).toHaveLength(1)
    if (skipSlashCommands) {
      expect(h.executions).toHaveLength(1)
      expect(h.executions[0].skipSlashCommands).toBe(true)
    } else {
      expect(h.executions).toEqual([])
      expect(h.queued[0].admitted).toBeUndefined()
    }
  }
})

test('a replacement turn racing admitted input preserves the whole result instead of replaying hooks', async () => {
  const queued: any[] = []
  const onQuery = extract('./REPL.tsx', 'onQuery')({
    isAgentSwarmsEnabled: () => false,
    queryGuard: { tryStart: () => null },
    logEvent: noop, enqueue: (command: any) => queued.push(command),
    getUserContentText: (content: string) => content,
  })
  const messages = [
    { type: 'user', uuid: 'settled', message: { content: 'rewritten' } },
    { type: 'attachment', attachment: { type: 'hook_additional_context', content: ['retained'] } },
  ]
  await onQuery(messages, new AbortController(), true, ['Read'], 'fixture', undefined, 'original', 'high', { text: 'rewritten' })
  expect(queued).toHaveLength(1)
  expect(queued[0].admitted).toMatchObject({ messages, shouldQuery: true, allowedTools: ['Read'], model: 'fixture', effort: 'high' })
})

test('admission failure never overwrites the running abort controller or a newer draft', async () => {
  const h = harness()
  const entered = deferred()
  const gate = deferred()
  const controller = new AbortController()
  h.scope.abortController = controller
  let replacements = 0
  h.scope.setAbortController = () => { replacements++ }
  h.scope.getToolUseContext = (_messages: any, _newMessages: any, current: AbortController) => {
    expect(current).not.toBe(controller)
    return {}
  }
  h.lowerScope.processUserInput = async () => {
    entered.resolve()
    await gate.promise
    throw new Error('admission failed')
  }
  const pending = h.submit('submitted', h.helpers)
  h.release()
  await entered.promise
  h.setText('new draft')
  gate.resolve()
  await expect(pending).rejects.toThrow('admission failed')
  expect(h.draft.text).toBe('new draft')
  expect(h.queued).toEqual([])
  expect(controller.signal.aborted).toBe(false)
  expect(replacements).toBe(0)
  expect(h.guard.isActive).toBe(true)
})

test('post-admission drop displays only the new warning and does not undo the queued prompt', async () => {
  const h = harness()
  const message = { type: 'user', uuid: 'settled', message: { content: 'entered' } }
  const warning = { type: 'system', content: 'post-next warning' }
  h.lowerScope.processUserInput = async (p: any) => {
    p.onPromptAdmission({ messages: [message], shouldQuery: true, admission: { text: 'entered' } })
    return { messages: [message, warning], shouldQuery: false }
  }
  let shown: any[] = []
  h.scope.setMessages = (update: any) => { shown = update(shown) }
  const pending = h.submit('submitted', h.helpers)
  h.release()
  await pending
  expect(shown).toEqual([warning])
  expect(h.queued).toHaveLength(1)
  expect(h.queued[0].admitted.messages).toEqual([message])
})

test('failure after admission reports the error without restoring a duplicate draft', async () => {
  const h = harness()
  h.lowerScope.processUserInput = async (p: any) => {
    p.onPromptAdmission({ messages: [{ type: 'user', uuid: 'entered', message: { content: 'entered' } }], shouldQuery: true })
    throw new Error('cancelled after admission')
  }
  const pending = h.submit('submitted', h.helpers)
  h.release()
  await expect(pending).rejects.toThrow('cancelled after admission')
  expect(h.queued).toHaveLength(1)
  expect(h.draft.text).toBe('')
})

test('reference attachments and IDE selection are snapshots before the barrier', async () => {
  const h = harness({ active: false, input: 'image [Image #1]', mode: 'bash' })
  const original = { 1: { id: 1, type: 'image', content: 'old' } }
  h.setPaste(original)
  const pending = h.submit('image [Image #1]', h.helpers)
  h.setPaste({ 2: { id: 2, type: 'image', content: 'new' } })
  h.scope.ideSelection = { text: 'new selection' }
  h.release()
  await pending
  expect(h.executions[0].pastedContents).toEqual(original)
  expect(h.executions[0].ideSelection).toEqual({ text: 'selection-at-submit' })
  expect(h.executions[0].mode).toBe('bash')
  expect(h.history[0].pastedContents).toEqual(original)
  expect(h.draft.paste[2].content).toBe('new')
})

test('remote sends the captured attachments without consuming later edits', async () => {
  const h = harness({ remote: true, input: 'image [Image #1]' })
  h.setPaste({ 1: { id: 1, type: 'image', content: 'old' } })
  const pending = h.submit('image [Image #1]', h.helpers)
  h.setText('new remote draft')
  h.setPaste({ 2: { id: 2, type: 'image', content: 'new' } })
  h.release()
  await pending
  expect(h.remoteMessages).toHaveLength(1)
  expect(h.remoteMessages[0][1].source.data).toBe('old')
  expect(h.draft.text).toBe('new remote draft')
  expect(h.executions).toEqual([])
})

for (const edit of [false, true]) {
  test(`remote send failure restores only the original owner (edit=${edit})`, async () => {
    const h = harness({ remote: true })
    h.scope.activeRemote.sendMessage = async () => false
    const pending = h.submit('submitted', h.helpers)
    if (edit) h.setText('new draft')
    h.release()
    await pending
    expect(h.draft.text).toBe(edit ? 'new draft' : 'submitted')
  })
}

for (const queryRequired of [false, true]) {
  test(`speculation stays separate and preserves new draft (queryRequired=${queryRequired})`, async () => {
    const h = harness({ active: false })
    let queries = 0
    let acceptInput = ''
    h.scope.handleSpeculationAccept = async (_s: any, _t: any, _a: any, input: string) => { acceptInput = input; return { queryRequired } }
    h.scope.readFileState = {}
    h.scope.getOriginalCwd = () => '/isolated'
    h.scope.onQuery = async () => { queries++ }
    const pending = h.submit('suggestion', h.helpers, { state: {}, speculationSessionTimeSavedMs: 5, setAppState: noop })
    h.setText('new draft')
    h.release()
    await pending
    expect(acceptInput).toBe('suggestion')
    expect(queries).toBe(queryRequired ? 1 : 0)
    expect(h.executions).toEqual([])
    expect(h.draft.text).toBe('new draft')
  })
}

for (const edit of [false, true]) {
  test(`error restores snapshot without replay or overwriting edits (edit=${edit})`, async () => {
    const h = harness({ active: false, mode: 'bash' })
    h.helpers.setCursorOffset(2)
    h.scope.awaitPendingHooks = async () => { throw new Error('hook failed') }
    const pending = h.submit('submitted', h.helpers)
    if (edit) h.setText('new draft')
    h.release()
    await expect(pending).rejects.toThrow('hook failed')
    expect(h.draft.text).toBe(edit ? 'new draft' : 'submitted')
    if (!edit) expect(h.draft).toMatchObject({ cursor: 2, mode: 'bash' })
    expect(h.executions).toEqual([])
    expect(h.queued).toEqual([])
  })
}

for (const action of ['resume', 'restore']) {
  test(`idle dialog ${action} keeps the complete submission snapshot`, async () => {
    const h = harness({ active: false, mode: 'bash', input: 'image [Image #1]' })
    let dialog: any
    h.scope.getFeatureValue_CACHED_MAY_BE_STALE = () => 'dialog'
    h.scope.lastQueryCompletionTimeRef.current = Date.now() - 100 * 60_000
    h.scope.getTotalInputTokens = () => 200_000
    h.scope.setIdleReturnPending = (v: any) => { dialog = v }
    h.helpers.setCursorOffset(3)
    const paste = { 1: { id: 1, type: 'image', content: 'old' } }
    h.setPaste(paste)
    await h.submit('image [Image #1]', h.helpers)
    expect(dialog).toBeDefined()
    expect(h.executions).toEqual([])
    expect(h.history).toEqual([])
    if (action === 'resume') {
      h.setText('new draft')
      h.setMode('prompt')
      h.setPaste({})
      h.scope.skipIdleCheckRef.current = true
      h.release()
      await dialog.resume()
      expect(h.executions).toHaveLength(1)
      expect(h.executions[0].mode).toBe('bash')
      expect(h.executions[0].pastedContents).toEqual(paste)
      expect(h.draft.text).toBe('new draft')
    } else {
      dialog.restore()
      expect(h.draft).toMatchObject({ text: 'image [Image #1]', mode: 'bash', cursor: 3, paste })
    }
  })
}

test('empty submission has no editor, history, or barrier side effects', async () => {
  const h = harness({ input: '' })
  const before = structuredClone(h.draft)
  let barriers = 0
  h.scope.awaitMods = async () => { barriers++ }
  await h.submit('  ', h.helpers)
  expect(h.draft).toEqual(before)
  expect(h.history).toEqual([])
  expect(barriers).toBe(0)
})

test('/exit executes once after barriers without leaving its input behind', async () => {
  const h = harness({ active: false, input: '/exit' })
  const pending = h.submit('/exit', h.helpers)
  expect(h.draft.text).toBe('')
  expect(h.guard.isActive).toBe(false)
  h.release()
  await pending
  expect(h.executions).toHaveLength(1)
  expect(h.executions[0].input).toBe('/exit')
})


test('real REPL setters advance ownership synchronously, including identical values', () => {
  const generation = { current: 0 }
  const base: Record<string, any> = {
    draftGenerationRef: generation, inputValueRef: { current: '' },
    inputModeRef: { current: 'prompt' }, pastedContentsRef: { current: {} },
    stashedPromptRef: { current: undefined },
    trySuggestBgPRIntercept: () => false, lastUserScrollTsRef: { current: Date.now() },
    RECENT_SCROLL_REPIN_WINDOW_MS: 3000, repinScroll: noop,
    setInputValueRaw: noop, setIsPromptInputActive: noop,
    setInputModeState: noop, setPastedContentsState: noop, setStashedPromptState: noop,
  }
  for (const [name, value] of [
    ['setInputValue', ''], ['setInputMode', 'prompt'],
    ['setPastedContents', (p: any) => p], ['setStashedPrompt', undefined],
  ] as const) {
    const set = extract('./REPL.tsx', name)(base)
    const before = generation.current
    set(value)
    expect(generation.current).toBe(before + 1)
  }
  const setPaste = extract('./REPL.tsx', 'setPastedContents')(base)
  setPaste({ 1: { content: 'one' } })
  setPaste((prev: any) => ({ ...prev, 2: { content: 'two' } }))
  expect(base.pastedContentsRef.current).toEqual({ 1: { content: 'one' }, 2: { content: 'two' } })
})

test('real PromptInput cursor, undo, and history callbacks report ownership changes', () => {
  let edits = 0
  let cursor = 1
  let resets = 0
  let clears = 0
  const base = {
    onInputStateChange: () => { edits++ }, cursorOffsetRef: { current: 1 },
    setCursorOffsetState: (value: number) => { cursor = value },
    undoBuffer: () => ({ text: 'undo' }), clearInputBuffer: () => { clears++ },
    resetInputHistory: () => { resets++ },
  }
  const path = '../components/PromptInput/PromptInput.tsx'
  extract(path, 'setCursorOffset')(base)(1)
  expect(edits).toBe(1)
  expect(cursor).toBe(1)
  expect(extract(path, 'undo')(base)()).toEqual({ text: 'undo' })
  extract(path, 'clearBuffer')(base)()
  extract(path, 'resetHistory')(base)()
  expect(edits).toBe(4)
  expect(clears).toBe(1)
  expect(resets).toBe(1)
})

test('real command-keybinding handlers mark synthetic commands and use NOOP editor helpers', () => {
  const calls: any[][] = []
  const handlers = extract('../hooks/useCommandKeybindings.tsx', 'handlers')({
    commandActions: new Set(['command:config']), onSubmit: (...args: any[]) => calls.push(args),
    NOOP_HELPERS: { setCursorOffset: noop, clearBuffer: noop, resetHistory: noop },
  })()
  handlers['command:config']()
  expect(calls).toHaveLength(1)
  expect(calls[0]![0]).toBe('/config')
  expect(calls[0]![3]).toEqual({ fromKeybinding: true })
})

test('real PromptInput rejects suggestions and empty input before invoking submission', async () => {
  const calls: any[] = []
  const path = '../components/PromptInput/PromptInput.tsx'
  const base = {
    store: { getState: () => ({}) }, footerItems: [], pastedContents: {},
    promptSuggestionState: {}, speculation: {}, isAgentSwarmsEnabled: () => false,
    suggestionsState: { suggestions: [] as any[] }, logForDebugging: noop,
    removeNotification: noop, getActiveAgentForInput: () => ({ type: 'leader' }),
    onSubmitProp: async (...args: any[]) => { calls.push(args) }, onAgentSubmit: undefined,
    setCursorOffset: noop, getCursorOffset: () => 0, clearBuffer: noop, resetHistory: noop,
  }
  const submit = extract(path, 'onSubmit')(base)
  await submit('')
  base.suggestionsState.suggestions = [{ description: 'file' }]
  await submit('blocked')
  expect(calls).toEqual([])
  await submit('/actual', true)
  expect(calls).toHaveLength(1)
  expect(calls[0]![0]).toBe('/actual')
})

test('useInputBuffer.clearBuffer cancels the pending debounce, not just rendered history', async () => {
  let buffer!: UseInputBufferResult
  const tick = () => new Promise<void>(resolve => setImmediate(resolve))
  function Probe() {
    buffer = useInputBuffer({ maxBufferSize: 10, debounceMs: 20 })
    return null
  }
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: false })
  const stdin = Object.assign(new PassThrough(), { isTTY: false, setRawMode: noop })
  const app = await render(React.createElement(Probe), {
    stdout: stdout as unknown as NodeJS.WriteStream, stderr: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream, exitOnCtrlC: false, patchConsole: false,
  })
  try {
    buffer.pushToBuffer('submitted', 9)
    await tick()
    buffer.pushToBuffer('pending old draft', 17)
    buffer.clearBuffer()
    await tick()
    // This is the hook's actual debounce deadline, not polling for readiness.
    await new Promise(resolve => setTimeout(resolve, 40))
    await tick()
    expect(buffer.undo()).toBeUndefined()
    expect(buffer.canUndo).toBe(false)
    buffer.pushToBuffer('new draft', 3)
    await tick()
    expect(buffer.undo()?.text).toBe('new draft')
  } finally {
    app.unmount()
    app.cleanup()
  }
})


test('direct processUserInput gap protects new text, history and undo until query completion', async () => {
  const h = harness({ active: false, input: '/later' })
  const processing = deferred()
  const entered = deferred()
  h.lowerScope.processUserInput = async () => {
    entered.resolve()
    await processing.promise
    return { messages: [{ type: 'user', uuid: 'test' }], shouldQuery: false, nextInput: 'late result' }
  }
  const pending = h.submit('/later', h.helpers)
  h.release()
  await entered.promise
  h.setText('new text')
  h.helpers.setCursorOffset(3)
  h.draft.history = 9
  h.draft.undo = ['new undo']
  const edited = structuredClone(h.draft)
  processing.resolve()
  await pending
  expect(h.draft).toEqual(edited)
})

for (const fullscreen of [false, true]) {
  for (const entry of ['repl', 'lower']) {
    test(`${entry}: conditional immediate command respects fullscreen=${fullscreen}`, async () => {
      let calls = 0
      const command = { name: 'diff', type: 'local-jsx',
        immediate: (_args: string, context: any) => context.modCommand.presentation.isFullscreen,
        load: async () => ({ call: (done: any) => { calls++; done() } }) }
      const h = harness({ input: '/diff', commands: [command] })
      h.scope.getToolUseContext = () => ({ modCommand: { presentation: { isFullscreen: fullscreen } } })
      if (entry === 'repl') {
        const pending = h.submit('/diff', h.helpers)
        h.release()
        await pending
      } else {
        await h.lowerScope.handlePromptSubmit({
          ...h.scope, input: '/diff', mode: 'prompt', commands: [command], helpers: h.helpers,
          onInputChange: h.setText, messages: [], querySource: 'repl_main',
        })
      }
      expect(calls).toBe(fullscreen ? 1 : 0)
      expect(h.queued).toHaveLength(fullscreen ? 0 : 1)
    })
  }
}

test('lower immediate dispatch also leaves the caller-owned editor untouched', async () => {
  const h = harness({ input: '/config' })
  const before = structuredClone(h.draft)
  const command = { name: 'config', type: 'local-jsx', immediate: true,
    load: async () => ({ call: (done: any) => done() }) }
  await h.lowerScope.handlePromptSubmit({
    ...h.scope, input: '/config', mode: 'prompt', commands: [command], helpers: h.helpers,
    onInputChange: h.setText, messages: [], querySource: 'repl_main',
  })
  expect(h.draft).toEqual(before)
})

test('viewed-agent submit consumes before Mods and never clears a later edit', async () => {
  const h = harness()
  let sent = 0
  const runningTask = { id: 'teammate', type: 'in_process_teammate', status: 'running' }
  const submit = extract('./REPL.tsx', 'onAgentSubmit')({ ...h.scope,
    store: { getState: () => ({ tasks: { teammate: runningTask } }) },
    isLocalAgentTask: () => false, isInProcessTeammateTask: (value: any) => value?.type === 'in_process_teammate',
    injectUserMessageToTeammate: () => { sent++; return true },
  })
  const pending = submit('submitted', runningTask, h.helpers)
  expect(h.draft.text).toBe('')
  h.setText('next draft')
  h.release()
  await pending
  expect(sent).toBe(1)
  expect(h.draft.text).toBe('next draft')
})

test.each(['completed', 'missing', 'running'])('local Agent submit uses fresh %s state after Mods', async status => {
  const h = harness()
  const task = { id: 'local', type: 'local_agent', status: status === 'running' ? 'completed' : 'running' }
  const currentTask = status === 'missing' ? undefined : { ...task, status }
  const queued: string[] = []
  const resumed: string[] = []
  const submit = extract('./REPL.tsx', 'onAgentSubmit')({ ...h.scope,
    store: { getState: () => ({ tasks: { local: currentTask } }) },
    isLocalAgentTask: (value: any) => value?.type === 'local_agent',
    appendMessageToLocalAgent: noop,
    createUserMessage: (value: any) => value,
    queuePendingMessage: (id: string) => queued.push(id),
    resumeAgentBackground: async ({ agentId }: any) => { resumed.push(agentId) },
    getToolUseContext: () => ({}),
    canUseTool: noop,
  })
  const pending = submit('submitted', task, h.helpers)
  h.release()
  await pending
  expect(queued).toEqual(status === 'running' ? ['local'] : [])
  expect(resumed).toEqual(status === 'running' ? [] : ['local'])
})

test('viewed teammate that finishes during Mods keeps the input and reports it was not sent', async () => {
  const h = harness()
  const taskAtSubmit = { id: 'teammate', type: 'in_process_teammate', status: 'running' }
  let currentTask = taskAtSubmit
  const notifications: any[] = []
  let sent = 0
  const submit = extract('./REPL.tsx', 'onAgentSubmit')({ ...h.scope,
    store: { getState: () => ({ tasks: { teammate: currentTask } }) },
    addNotification: (notification: any) => notifications.push(notification),
    isLocalAgentTask: () => false, isInProcessTeammateTask: (value: any) => value?.type === 'in_process_teammate',
    injectUserMessageToTeammate: () => { sent++; return false },
  })
  const pending = submit('submitted', taskAtSubmit, h.helpers)
  expect(h.draft.text).toBe('')
  currentTask = { ...taskAtSubmit, status: 'completed' }
  h.release()
  await pending
  expect(sent).toBe(0)
  expect(h.draft.text).toBe('submitted')
  expect(notifications).toEqual([
    expect.objectContaining({
      key: 'teammate-message-not-sent-teammate',
      text: 'Teammate has stopped; message was not sent.',
    }),
  ])
})

test('teammate terminal transition during injection retains the input and restores the draft', async () => {
  const h = harness()
  const task = { id: 'teammate', type: 'in_process_teammate', status: 'running' }
  const notifications: any[] = []
  const submit = extract('./REPL.tsx', 'onAgentSubmit')({ ...h.scope,
    store: { getState: () => ({ tasks: { teammate: task } }) },
    addNotification: (notification: any) => notifications.push(notification),
    isLocalAgentTask: () => false, isInProcessTeammateTask: (value: any) => value?.type === 'in_process_teammate',
    injectUserMessageToTeammate: () => false,
  })
  const pending = submit('submitted', task, h.helpers)
  h.release()
  await pending
  expect(h.draft.text).toBe('submitted')
  expect(notifications).toHaveLength(1)
})


test('terminal teammate rejection does not overwrite a later edit', async () => {
  const h = harness()
  const task = { id: 'teammate', type: 'in_process_teammate', status: 'completed' }
  const submit = extract('./REPL.tsx', 'onAgentSubmit')({ ...h.scope,
    store: { getState: () => ({ tasks: { teammate: task } }) },
    addNotification: noop,
    isLocalAgentTask: () => false, isInProcessTeammateTask: (value: any) => value?.type === 'in_process_teammate',
    injectUserMessageToTeammate: () => false,
  })
  const pending = submit('submitted', task, h.helpers)
  h.setText('next draft')
  h.release()
  await pending
  expect(h.draft.text).toBe('next draft')
})

for (const status of ['completed', 'failed', 'killed']) {
  test(`viewed terminal teammate (${status}) keeps input instead of sending to the main agent`, async () => {
    const h = harness()
    const task = { id: 'teammate', type: 'in_process_teammate', status }
    let sent = 0
    let mainAgentSubmissions = 0
    const submit = extract('./REPL.tsx', 'onAgentSubmit')({ ...h.scope,
      store: { getState: () => ({ tasks: { teammate: task } }) },
      addNotification: noop,
      onSubmit: () => { mainAgentSubmissions++ },
      isLocalAgentTask: () => false, isInProcessTeammateTask: (value: any) => value?.type === 'in_process_teammate',
      injectUserMessageToTeammate: () => { sent++; return false },
    })
    const pending = submit('submitted', task, h.helpers)
    h.release()
    await pending
    expect(sent).toBe(0)
    expect(mainAgentSubmissions).toBe(0)
    expect(h.draft.text).toBe('submitted')
  })
}


for (const direction of ['Up', 'Down']) {
  test(`history ${direction} claims the edit before async history retrieval`, () => {
    let claimed = false
    const history = () => { expect(claimed).toBe(true); return false }
    const handler = extract('../components/PromptInput/PromptInput.tsx', `handleHistory${direction}`, 'function')({
      suggestions: [], isCursorOnFirstLine: true, isCursorOnLastLine: true, queuedCommands: [],
      isQueuedCommandEditable: () => false, footerItems: [],
      onInputStateChange: () => { claimed = true }, onHistoryUp: history, onHistoryDown: history,
    })
    handler()
    expect(claimed).toBe(true)
  })
}

test('managed remote execution still skips local hooks and attachments', async () => {
  const h = harness({ active: false })
  h.scope.isRemoteExecutionSession = true
  h.scope.awaitPendingHooks = () => { throw new Error('local hooks must not run') }
  h.setPaste({ 1: { id: 1, type: 'image', content: 'local image' } })
  const pending = h.submit('image [Image #1]', h.helpers)
  h.release()
  await pending
  expect(h.executions).toHaveLength(1)
  expect(h.executions[0].skipHooks).toBe(true)
  expect(h.executions[0].skipAttachments).toBe(true)
  expect(h.executions[0].pastedContents).toBeUndefined()
  expect(h.executions[0].ideSelection).toBeUndefined()
})

test('concurrent submissions wait for Mods without early reservation and dispatch once each', async () => {
  const h = harness({ active: false })
  const processing = deferred()
  const entered = deferred()
  h.lowerScope.processUserInput = async (p: any) => {
    h.executions.push(p)
    if (p.input === 'first') {
      entered.resolve()
      await processing.promise
    }
    const settled = { messages: [{ type: 'user', uuid: p.input, message: { content: p.input } }], shouldQuery: true }
    p.onPromptAdmission?.(settled)
    return settled
  }
  const first = h.submit('first', h.helpers)
  h.setText('second')
  const second = h.submit('second', h.helpers)
  expect(h.guard.isActive).toBe(false)
  h.release()
  await entered.promise
  await second
  expect(h.queued.map(c => c.value)).toEqual(['second'])
  processing.resolve()
  await first
  expect(h.executions.map(c => c.input)).toEqual(['first', 'second'])
  expect(h.queued[0].admitted.messages[0].message.content).toBe('second')
  expect(h.draft.text).toBe('')
})

test('tracked queue commands cancel exactly once and stay out of editable input', async () => {
  const queue = await import('../utils/messageQueueManager.js')
  let cancellations = 0
  const command = queue.enqueueTracked({
    mode: 'prompt',
    value: 'plugin follow-up',
    priority: 'later',
    promptSubmitReceipt: { admit: noop, cancel: () => { cancellations++ } },
  })
  try {
    expect(queue.popAllEditable('draft', 0)).toBeUndefined()
    queue.remove([command])
    queue.remove([command])
    expect(cancellations).toBe(1)
    expect(queue.getCommandQueue()).toEqual([])
  } finally {
    queue.resetCommandQueue()
  }
})

test('queue processing keeps later proactive prompts separate from next prompts', async () => {
  const queue = await import('../utils/messageQueueManager.js')
  const processor = await import('../utils/queueProcessor.js')
  const batches: string[][] = []
  try {
    queue.enqueue({ mode: 'prompt', value: 'user prompt' })
    queue.enqueue({ mode: 'prompt', value: 'plugin follow-up', priority: 'later' })
    expect(processor.processQueueIfReady({
      executeInput: async commands => {
        batches.push(commands.map(command => command.value as string))
      },
    })).toEqual({ processed: true })
    expect(batches).toEqual([['user prompt']])
    expect(queue.getCommandQueue().map(command => command.value)).toEqual([
      'plugin follow-up',
    ])
  } finally {
    queue.resetCommandQueue()
  }
})
