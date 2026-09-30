import { expect, test } from 'bun:test'
import React, { useLayoutEffect } from 'react'
import { execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { AppStoreContext, getDefaultAppState } from '../../state/AppState.js'
import { createStore } from '../../state/store.js'
import { Box, Text, createRoot } from '../../ink.js'
import { AlternateScreen } from '../../ink/components/AlternateScreen.js'
import type { Frame } from '../../ink/frame.js'
import { useDeclaredCursor } from '../../ink/hooks/use-declared-cursor.js'
import instances from '../../ink/instances.js'
import { KeybindingProvider } from '../../keybindings/KeybindingContext.js'
import { DEFAULT_BINDINGS } from '../../keybindings/defaultBindings.js'
import { parseBindings } from '../../keybindings/parser.js'
import { DiffController, type DiffViewState } from '../../services/diff/controller.js'
import type { DiffBody, DiffSnapshot } from '../../utils/gitDiff.js'
import { DiffSidebar } from './DiffSidebar.js'
import {
  createFrameRecorder,
  DiffTerminalOutput,
  firstScreenDifference,
  freezeTerminalScreen,
  screenLines,
  type RecordedFrame,
} from './DiffTerminalHarness.js'

class Input extends Readable {
  isTTY = true
  _read(): void {}
  setRawMode(): this {
    return this
  }
  ref(): this {
    return this
  }
  unref(): this {
    return this
  }
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>(settle => {
      resolve = settle
    }),
    resolve,
  }
}

function body(marker: string, lineCount = 1): DiffBody {
  return {
    status: 'ready',
    hunks: [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: lineCount,
        lines: Array.from(
          { length: lineCount },
          (_, index) => `+${marker}_${index.toString().padStart(2, '0')}`,
        ),
      },
    ],
  }
}

function snapshot(): DiffSnapshot {
  const files = [
    { path: 'alpha.ts', isPreSession: false },
    { path: 'src/alpha.test.ts', isPreSession: false },
    { path: 'pre-one.ts', isPreSession: true },
    { path: 'pre-two.ts', isPreSession: true },
    { path: 'pre-three.ts', isPreSession: true },
    { path: 'pre-four.ts', isPreSession: true },
  ]
  return {
    root: '/synthetic',
    mode: 'session',
    stats: { filesCount: files.length, linesAdded: files.length, linesRemoved: 0 },
    files: files.map(file => ({
      ...file,
      added: 1,
      removed: 0,
      isBinary: false,
      renamedFrom: null,
      isUntracked: false,
    })),
    source: { kind: 'working-tree', base: 'HEAD' },
    baseRef: 'HEAD',
    isUnborn: false,
    stalePaths: [],
    isUntrackedWithheld: false,
    detailsOmitted: false,
  }
}

function commitIdentity(revision: number, state: DiffViewState): string {
  return JSON.stringify({
    revision,
    noise: state.showNoise,
    preSession: state.showPreSession,
    files: state.data.files.map(file => [file.path, file.bodyState]),
  })
}

async function settleReact(): Promise<void> {
  for (let index = 0; index < 6; index++) await Promise.resolve()
}

function imageSequences(): string[] {
  return ['\u001b_Ga=q\u001b\\']
}

function setCursorImage(node: import('../../ink/dom.js').DOMElement | null): void {
  if (!node) return
  node.terminalImage = {
    id: 99,
    identity: 'cursor-test',
    sequences: imageSequences,
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setImmediate(resolve))
  }
  expect(predicate()).toBe(true)
}

function assertFrameMatchesTerminal(
  frame: RecordedFrame,
  output: DiffTerminalOutput,
): void {
  const physical = output.screenAfter(frame.writeId)
  expect(physical).toBeDefined()
  const difference = firstScreenDifference(
    frame.screen,
    physical!,
    frame.event.frame,
  )
  if (difference) {
    throw new Error(
      `frame ${frame.id} write ${frame.writeId} differs: ${difference}\n` +
        `logical:\n${screenLines(frame.screen).join('\n')}\n` +
        `physical:\n${screenLines(physical!).join('\n')}`,
    )
  }
}

test('production scheduler emits and physically applies its trailing commit', () => {
  const output = execFileSync(process.execPath, ['run', import.meta.dir + '/DiffTerminal.production.tsx'], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      TERM: 'xterm-256color',
      TMUX: '',
    },
    encoding: 'utf8',
    timeout: 10000,
  })
  const result = output
    .split('\n')
    .find(line => line.startsWith('RESULT '))
  expect(result).toBeDefined()
  expect(JSON.parse(result!.slice('RESULT '.length))).toMatchObject({
    scheduler: 'production',
  })
}, 15000)

test('entering alternate screen paints the first frame atomically', async () => {
  const output = new DiffTerminalOutput(40, 8)
  const input = new Input()
  const root = await createRoot({
    stdout: output as never,
    stdin: input as never,
    patchConsole: false,
    exitOnCtrlC: false,
  })

  try {
    root.render(
      <AlternateScreen mouseTracking={false}>
        <Text>DIFF_FIRST_FRAME</Text>
      </AlternateScreen>,
    )
    await waitFor(() => output.writes.length > 0)
    for (let index = 0; index < 5; index++) {
      await settleReact()
      await output.flush()
      if (
        output.writes.some(
          write =>
            write.screen &&
            screenLines(write.screen).join('\n').includes('DIFF_FIRST_FRAME'),
        )
      ) {
        break
      }
      await new Promise(resolve => setImmediate(resolve))
    }

    const enterWrite = output.writes.find(write =>
      write.bytes.includes(Buffer.from('\u001b[?1049h')),
    )
    expect(enterWrite).toBeDefined()
    expect(enterWrite!.bytes.toString()).toContain('DIFF_FIRST_FRAME')
    expect(enterWrite!.bytes.toString()).toContain('\u001b[?2026h')
    expect(enterWrite!.bytes.toString()).toContain('\u001b[?2026l')
  } finally {
    root.unmount()
  }
})

test('alternate-screen frame evidence reports the clamped physical cursor', async () => {
  const output = new DiffTerminalOutput(10, 4)
  const input = new Input()
  const events: import('../../ink/frame.js').FrameEvent[] = []
  const root = await createRoot({
    stdout: output as never,
    stdin: input as never,
    patchConsole: false,
    exitOnCtrlC: false,
    onFrame: event => events.push(event),
  })
  const ink = instances.get(output as never) as unknown as {
    setAltScreenActive(active: boolean): void
    onRender(): void
  }
  function CursorProbe() {
    const ref = useDeclaredCursor({ line: 20, column: 30, active: true })
    return <Box ref={ref}><Text>cursor</Text></Box>
  }
  try {
    output.write('\u001b[?1049h\u001b[2J\u001b[H')
    await output.flush()
    ink.setAltScreenActive(true)
    root.render(<CursorProbe />)
    await settleReact()
    ink.onRender()
    await output.flush()
    expect(events.at(-1)?.physicalCursor).toEqual({ x: 9, y: 3 })
    expect(freezeTerminalScreen(output.renderer).cursor).toMatchObject({ x: 9, y: 3 })
  } finally {
    root.unmount()
  }
})

test('terminal image writes restore the declared physical cursor', async () => {
  const output = new DiffTerminalOutput(10, 4)
  const input = new Input()
  const events: import('../../ink/frame.js').FrameEvent[] = []
  let cursorNode: import('../../ink/dom.js').DOMElement | null = null
  const root = await createRoot({
    stdout: output as never,
    stdin: input as never,
    patchConsole: false,
    exitOnCtrlC: false,
    onFrame: event => events.push(event),
  })
  const ink = instances.get(output as never) as unknown as {
    setAltScreenActive(active: boolean): void
    setCursorDeclaration(
      declaration: {
        relativeX: number
        relativeY: number
        node: import('../../ink/dom.js').DOMElement
      },
    ): void
    onRender(): void
  }
  function CursorProbe() {
    const ref = (node: import('../../ink/dom.js').DOMElement | null) => {
      cursorNode = node
      setCursorImage(node)
    }
    return <Box ref={ref} width={10} height={4}><Text>cursor</Text></Box>
  }
  try {
    output.write('\u001b[?1049h\u001b[2J\u001b[H')
    await output.flush()
    ink.setAltScreenActive(true)
    root.render(<CursorProbe />)
    await settleReact()
    if (!cursorNode) throw new Error('Cursor probe did not mount')
    ink.setCursorDeclaration({ relativeX: 5, relativeY: 2, node: cursorNode })
    ink.onRender()
    await output.flush()
    expect(events.at(-1)?.physicalCursor).toEqual({ x: 5, y: 2 })
    expect(freezeTerminalScreen(output.renderer).cursor).toMatchObject({ x: 5, y: 2 })
  } finally {
    root.unmount()
  }
})

test('records every async diff publish as matching logical and terminal frames', async () => {
  const output = new DiffTerminalOutput(110, 32)
  const input = new Input()
  let scheduledRedraw: (() => void) | undefined
  const pending = new Map<string, Deferred<DiffBody>>()
  const requested: string[] = []
  const source = snapshot()
  let controllerRevision = 0
  let committed: string | undefined
  const inkRef: {
    current?: { frontFrame: Frame; setAltScreenActive(active: boolean): void }
  } = {}

  const controller = new DiffController({
    cwd: '/synthetic',
    record: event => output.mark('backend', event),
    scheduleRedraw: callback => {
      scheduledRedraw = callback
      return 1 as unknown as ReturnType<typeof setTimeout>
    },
    cancelRedraw: () => {
      scheduledRedraw = undefined
    },
    createBackend: async () => ({
      root: '/synthetic',
      headKey: async () => 'head',
      fetch: async () => ({ kind: 'data', data: source }),
      fetchBody: (_snapshot, file) => {
        const existing = pending.get(file.path)
        if (existing) return existing.promise
        requested.push(file.path)
        output.mark('backend', `start ${file.path}`)
        const request = deferred<DiffBody>()
        pending.set(file.path, request)
        return request.promise
      },
    }),
  })
  const unsubscribe = controller.subscribe(() => {
    controllerRevision++
    output.mark('controller', commitIdentity(controllerRevision, controller.getSnapshot()))
  })

  function CommitProbe(): null {
    const state = React.useSyncExternalStore(
      controller.subscribe,
      controller.getSnapshot,
    )
    useLayoutEffect(() => {
      committed = commitIdentity(controllerRevision, state)
      output.mark('commit', committed)
    })
    return null
  }

  const activeContexts = new Set<
    import('../../keybindings/types.js').KeybindingContextName
  >()
  const recorder = createFrameRecorder(
    output,
    () => inkRef.current!.frontFrame,
    () => committed,
  )
  const root = await createRoot({
    stdout: output as never,
    stdin: input as never,
    patchConsole: false,
    exitOnCtrlC: false,
    onFrame: recorder.onFrame,
  })
  inkRef.current = instances.get(output as never) as unknown as NonNullable<
    typeof inkRef.current
  >
  output.write('\u001b[?1049h\u001b[2J\u001b[H')
  await output.flush()
  inkRef.current.setAltScreenActive(true)
  const store = createStore(getDefaultAppState())
  const draw = () => (
    <AppStoreContext value={store}>
      <KeybindingProvider
        bindings={parseBindings(DEFAULT_BINDINGS)}
        pendingChordRef={{ current: null }}
        pendingChord={null}
        setPendingChord={() => {}}
        activeContexts={activeContexts}
        registerActiveContext={context => activeContexts.add(context)}
        unregisterActiveContext={context => activeContexts.delete(context)}
        handlerRegistryRef={{ current: new Map() }}
      >
        <CommitProbe />
        <Box width={110} height={32}>
          <Box width={70} flexShrink={0} flexDirection="column">
            <Text>transcript marker</Text>
            <Box flexGrow={1} />
            <Text>composer marker</Text>
          </Box>
          <Box width={40} flexShrink={0}>
            <DiffSidebar
              controller={controller}
              messages={[]}
              keyboardEnabled
              onClose={() => {}}
            />
          </Box>
        </Box>
      </KeybindingProvider>
    </AppStoreContext>
  )

  try {
    root.render(draw())
    await waitFor(() => requested.includes('alpha.ts'))
    expect(requested).toEqual(['alpha.ts'])

    pending.get('alpha.ts')!.resolve(body('ALPHA_BODY'))
    for (let index = 0; index < 6; index++) await Promise.resolve()
    void controller.togglePreSession()
    await waitFor(() => requested.includes('pre-one.ts'))
    expect(requested).toEqual([
      'alpha.ts',
      'pre-one.ts',
      'pre-two.ts',
      'pre-three.ts',
      'pre-four.ts',
    ])

    const partialPublished = new Promise<void>(resolve => {
      const stop = controller.subscribe(() => {
        if (
          controller.getSnapshot().data.files.find(
            file => file.path === 'pre-one.ts',
          )?.bodyState === 'ready'
        ) {
          stop()
          resolve()
        }
      })
    })
    pending.get('pre-one.ts')!.resolve(body('PRE_ONE_BODY', 40))
    await waitFor(() => scheduledRedraw !== undefined)
    scheduledRedraw!()
    scheduledRedraw = undefined
    await partialPublished
    await output.flush()
    expect(
      controller.getSnapshot().data.files.find(file => file.path === 'pre-one.ts')
        ?.bodyState,
    ).toBe('ready')
    expect(
      controller.getSnapshot().data.files.find(file => file.path === 'pre-two.ts')
        ?.bodyState,
    ).toBe('loading')
    await settleReact()
    await output.flush()
    const partialScreen = screenLines(recorder.frames.at(-1)!.screen).join('\n')
    expect(partialScreen).toContain('PRE_ONE_BODY_00')
    expect(partialScreen).not.toContain('PRE_ONE_BODY_30')

    output.resize(109, 32)
    await output.flush()
    output.resize(110, 32)
    await output.flush()
    output.resize(144, 32)
    await output.flush()

    void controller.toggleNoise()
    pending.get('pre-two.ts')!.resolve(body('PRE_TWO_BODY'))
    pending.get('pre-three.ts')!.resolve(body('PRE_THREE_BODY'))
    pending.get('pre-four.ts')!.resolve(body('PRE_FOUR_BODY'))
    await waitFor(() => requested.includes('src/alpha.test.ts'))
    pending.get('src/alpha.test.ts')!.resolve(body('NOISE_BODY'))
    await waitFor(() =>
      controller.getSnapshot().data.files.every(file => file.bodyState === 'ready'),
    )
    await settleReact()
    await output.flush()

    expect(recorder.frames.length).toBeGreaterThan(3)
    expect(recorder.frames.slice(1).every(frame => frame.commit !== undefined)).toBe(
      true,
    )
    expect(
      recorder.frames.some(frame =>
        frame.commit?.includes('"pre-one.ts","ready"'),
      ),
    ).toBe(true)
    expect(screenLines(recorder.frames.at(-1)!.screen).join('\n')).toContain(
      'PRE_ONE_BODY',
    )
    for (const frame of recorder.frames) assertFrameMatchesTerminal(frame, output)
  } finally {
    root.unmount()
    unsubscribe()
    controller.dispose()
  }
}, 15000)
