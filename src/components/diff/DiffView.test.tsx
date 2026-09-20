import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childKey = 'SHARED_DIFF_UI_CHILD'
if (!process.env[childKey]) {
  test('shared diff UI interactions and budgets', async () => {
    const home = mkdtempSync(join(tmpdir(), 'diff-view-'))
    try {
      const child = Bun.spawn(
        [process.execPath, 'test', import.meta.path],
        {
          cwd: home,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            CLAUDE_CONFIG_DIR: home,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            DISABLE_AUTOUPDATER: '1',
            [childKey]: '1',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
      expect(code).toBe(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 30000)
} else {
  const React = await import('react')
  const { Readable, Writable } = await import('node:stream')
  const { Box, Text, ThemeProvider, render, useInput } =
    await import('../../ink.js')
  const { DiffSidebar } = await import('./DiffSidebar.js')
  const { DiffDialog } = await import('./DiffDialog.js')
  const { DiffController } =
    await import('../../services/diff/controller.js')
  const { AppStoreContext, getDefaultAppState, useAppState } =
    await import('../../state/AppState.js')
  const { ScrollKeybindingHandler } = await import('../ScrollKeybindingHandler.js')
  const { default: ScrollBox } = await import('../../ink/components/ScrollBox.js')
  const { createStore } = await import('../../state/store.js')
  const { default: instances } = await import('../../ink/instances.js')
  const { nodeCache } = await import('../../ink/node-cache.js')
  const { dispatchClick } = await import('../../ink/hit-test.js')
  const { TerminalSizeContext } =
    await import('../../ink/components/TerminalSizeContext.js')
  const { KeybindingProvider } =
    await import('../../keybindings/KeybindingContext.js')
  const { DEFAULT_BINDINGS } =
    await import('../../keybindings/defaultBindings.js')
  const { parseBindings } = await import('../../keybindings/parser.js')
  const { useKeybinding } =
    await import('../../keybindings/useKeybinding.js')
  const { useIsOverlayActive } =
    await import('../../context/overlayContext.js')
  const { createUserMessage, createAssistantMessage } =
    await import('../../utils/messages.js')
  type DiffData = import('../../hooks/useDiffData.js').DiffData
  type DOMElement = import('../../ink/dom.js').DOMElement
  type DOMNode = import('../../ink/dom.js').DOMNode
  type Message = import('../../types/message.js').Message
  type Hunk = import('diff').StructuredPatchHunk

  const patch = (text: string, count = 1): Hunk => ({
    oldStart: 1,
    oldLines: 0,
    newStart: 1,
    newLines: count,
    lines: Array.from(
      { length: count },
      (_, index) => `+${text}-${index}`,
    ),
  })
  function dataFor(count = 2): DiffData {
    const files = Array.from({ length: count }, (_, index) => ({
      path: `file-${String(index).padStart(2, '0')}.ts`,
      linesAdded: 1,
      linesRemoved: 0,
      isBinary: false,
      isLargeFile: false,
      isTruncated: false,
      bodyState: 'ready' as const,
    }))
    return {
      files,
      hunks: new Map(
        files.map((file, index) => [file.path, [patch(`body-${index}`)]]),
      ),
      loading: false,
      outcome: 'data',
      baseLabel: 'git diff HEAD',
      stats: { filesCount: count, linesAdded: count, linesRemoved: 0 },
    }
  }
  // An external-store fixture keeps UI scenarios deterministic without mocking
  // Ink, keybindings, StructuredDiff, or the controller's public actions.
  class FixtureController extends DiffController {
    snapshot: ReturnType<
      import('../../services/diff/controller.js').DiffController['getSnapshot']
    >
    uiListeners = new Set<() => void>()
    constructor(data: DiffData) {
      super({ cwd: process.cwd() })
      this.snapshot = {
        mode: 'session',
        data,
        armedPath: null,
        selectedPath: null,
        source: null,
        showNoise: false,
        showPreSession: false,
      }
      this.getSnapshot = () => this.snapshot
      this.subscribe = listener => {
        this.uiListeners.add(listener)
        return () => {
          this.uiListeners.delete(listener)
        }
      }
    }
    publish(data: DiffData) {
      this.snapshot = { ...this.snapshot, data }
      this.emit()
    }
    emit() {
      for (const listener of this.uiListeners) listener()
    }
    sync() {
      this.snapshot = {
        ...this.snapshot,
        ...this.baseSnapshot(),
        data: this.snapshot.data,
      }
      this.emit()
    }
    // super's arrow getter is captured before replacing it.
    private baseSnapshot = this.getSnapshot
    disposed = false
    override dispose() {
      this.disposed = true
      super.dispose()
    }
    override watch() {
      return () => {}
    }
    override selectFile(path: string | null) {
      super.selectFile(path)
      this.sync()
    }
    override chooseSource(source: number | null) {
      super.chooseSource(source)
      this.sync()
    }
    override async toggleNoise() {
      const update = super.toggleNoise()
      this.sync()
      await update
    }
    override async togglePreSession() {
      const update = super.togglePreSession()
      this.sync()
      await update
    }
    override toggleAsk(
      path: string,
      hunks: readonly Hunk[],
      basis: string,
    ) {
      super.toggleAsk(path, hunks, basis)
      this.sync()
    }
    override async cycleBase() {
      this.snapshot = {
        ...this.snapshot,
        mode:
          this.snapshot.mode === 'session'
            ? 'uncommitted'
            : this.snapshot.mode === 'uncommitted'
              ? 'branch'
              : 'session',
      }
      this.emit()
    }
  }

  class Output extends Writable {
    columns = 110
    rows = 32
    isTTY = false
    output = ''
    _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
      this.output += chunk.toString()
      done()
    }
  }
  class Input extends Readable {
    isTTY = true
    _read() {}
    setRawMode() {
      return this
    }
    ref() {
      return this
    }
    unref() {
      return this
    }
  }
  const textContent = (node: DOMNode): string =>
    node.nodeName === '#text'
      ? node.nodeValue
      : node.nodeName === 'ink-raw-ansi'
        ? String(node.attributes.rawText ?? '')
        : node.childNodes.map(textContent).join('')
  async function mount(
    controller: import('../../services/diff/controller.js').DiffController,
    initialDialog = false,
    messages: Message[] = [],
    transcriptKeyboard = false,
  ) {
    const stdout = new Output()
    const stdin = new Input()
    const store = createStore(getDefaultAppState())
    let dialog = initialDialog
    let show = true
    let width = 110
    let height = 32
    let enabled = false
    let closes = 0
    let wheels = 0
    let keys = 0
    let rewinds = 0
    let mounts = 0
    let transcriptScrolls = 0
    const transcriptRef = React.createRef<import('../../ink/components/ScrollBox.js').ScrollBoxHandle>()
    function TranscriptKeyboard() {
      const diffDialogActive = useAppState(s => s.activeOverlays.has('diff-dialog'))
      return <ScrollKeybindingHandler scrollRef={transcriptRef} isActive
        isKeyboardActive={!diffDialogActive} onScroll={() => { transcriptScrolls++ }} />
    }
    const activeContexts = new Set<
      import('../../keybindings/types.js').KeybindingContextName
    >()
    function Composer() {
      React.useEffect(() => {
        mounts++
      }, [])
      const overlay = useIsOverlayActive()
      useInput(
        (_input, key) => {
          if (key.wheelUp || key.wheelDown) wheels++
          else keys++
        },
        { isActive: !overlay },
      )
      useKeybinding(
        'chat:undo',
        () => {
          rewinds++
        },
        { context: 'Chat', isActive: !overlay },
      )
      return <Text>composer draft</Text>
    }
    const providerProps = {
      bindings: parseBindings(DEFAULT_BINDINGS),
      pendingChordRef: { current: null },
      pendingChord: null,
      setPendingChord: () => {},
      activeContexts,
      registerActiveContext: (
        context: import('../../keybindings/types.js').KeybindingContextName,
      ) => {
        activeContexts.add(context)
      },
      unregisterActiveContext: (
        context: import('../../keybindings/types.js').KeybindingContextName,
      ) => {
        activeContexts.delete(context)
      },
      handlerRegistryRef: { current: new Map() },
    }
    const draw = () => (
      <AppStoreContext value={store}>
        <KeybindingProvider {...providerProps}>
          <TerminalSizeContext value={{ columns: width, rows: height }}>
            <Box width={width} height={height} flexDirection="column">
              {transcriptKeyboard && <>
                <TranscriptKeyboard />
                <ScrollBox ref={transcriptRef} height={1} flexShrink={0} flexDirection="column">
                  {Array.from({ length: 60 }, (_, index) => <Text key={index}>transcript-{index}</Text>)}
                </ScrollBox>
              </>}
              {show &&
                (dialog ? (
                  <DiffDialog
                    controller={controller}
                    messages={messages}
                    onDone={() => {
                      closes++
                    }}
                  />
                ) : (
                  <Box flexGrow={1} minHeight={0}>
                    <Box width={Math.floor(width / 2)}>
                      <Text>left transcript</Text>
                    </Box>
                    <TerminalSizeContext
                      value={{
                        columns: Math.ceil(width / 2),
                        rows: height - 1,
                      }}
                    >
                      <DiffSidebar
                        controller={controller}
                        messages={messages}
                        keyboardEnabled={enabled}
                        onClose={() => {
                          closes++
                        }}
                      />
                    </TerminalSizeContext>
                  </Box>
                ))}
              <Composer />
            </Box>
          </TerminalSizeContext>
        </KeybindingProvider>
      </AppStoreContext>
    )
    const instance = await render(draw(), {
      stdout: stdout as never,
      stdin: stdin as never,
      patchConsole: false,
      exitOnCtrlC: false,
    })
    const root = () =>
      (
        instances.get(stdout as never) as unknown as {
          rootNode: DOMElement
        }
      ).rootNode
    const elements = () => {
      const all: DOMElement[] = []
      const visit = (node: DOMElement) => {
        all.push(node)
        node.childNodes.forEach(child => {
          if (child.nodeName !== '#text') visit(child)
        })
      }
      visit(root())
      return all
    }
    const text = () => textContent(root())
    const wait = async (predicate: () => boolean) => {
      const deadline = Date.now() + 2000
      while (!predicate() && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 10))
      expect(predicate()).toBe(true)
    }
    const click = async (label: string) => {
      await wait(() =>
        elements().some(
          el =>
            el.nodeName === 'ink-text' &&
            textContent(el).includes(label) &&
            nodeCache.has(el),
        ),
      )
      const el = elements().find(
        el =>
          el.nodeName === 'ink-text' &&
          textContent(el).includes(label) &&
          nodeCache.has(el),
      )!
      const rect = nodeCache.get(el)!
      expect(dispatchClick(root(), rect.x, rect.y)).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    const key = async (sequence: string) => {
      stdin.push(sequence)
      await new Promise(resolve => setTimeout(resolve, 40))
    }
    const rerender = () =>
      instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
    return {
      text,
      elements,
      wait,
      click,
      key,
      stdout,
      root,
      store,
      scrolls: () =>
        elements().filter(el => el.style.overflowY === 'scroll'),
      counts: () => ({ closes, wheels, keys, rewinds, mounts, transcriptScrolls }),
      transcript: () => transcriptRef.current,
      resize: (columns: number, rows: number) => {
        width = columns
        height = rows
        stdout.columns = columns
        stdout.rows = rows
        rerender()
      },
      keyboard: (value: boolean) => {
        enabled = value
        rerender()
      },
      dialog: () => {
        dialog = true
        rerender()
      },
      messages: (value: Message[]) => {
        messages = value
        rerender()
      },
      hide: () => {
        show = false
        rerender()
      },
      unmount: () => {
        instance.unmount()
        controller.dispose()
      },
    }
  }

  test('real controller publishes unborn listings to the native view but not empty or turn views', async () => {
    const root = mkdtempSync(join(tmpdir(), 'diff-unborn-view-'))
    const controller = new DiffController({
      cwd: root,
      sessionStartMs: 0,
      record: () => {},
    })
    let ui: Awaited<ReturnType<typeof mount>> | undefined
    const note = 'no commits yet — showing staged and new files'
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
      await controller.refresh()
      ui = await mount(controller, false, [
        createUserMessage({ content: 'edit a file' }),
        createUserMessage({
          content: [
            { type: 'tool_result', tool_use_id: 'edit', content: 'done' },
          ],
          toolUseResult: {
            filePath: 'turn.ts',
            structuredPatch: [patch('turn-marker')],
          },
        }),
      ])
      await ui.wait(() => ui!.text().includes('Working tree is clean'))
      expect(ui.text()).not.toContain(note)
      writeFileSync(join(root, 'staged.ts'), 'staged body\n')
      execFileSync('git', ['add', '--', 'staged.ts'], { cwd: root })
      writeFileSync(join(root, 'new.ts'), 'new body\n')
      await controller.refresh()
      await ui.wait(() => ui!.text().includes('staged body'))
      expect(ui.text()).toContain(note)
      expect(controller.getSnapshot().data).toMatchObject({
        isUnborn: true,
        stats: { filesCount: 2 },
      })
      expect(ui.text()).toContain('new.ts')
      ui.dialog()
      await ui.wait(() => ui!.text().includes('Diff · files'))
      expect(ui.text()).toContain(note)
      await ui.click('Source: Current')
      expect(ui.text()).toContain('turn-marker')
      expect(ui.text()).not.toContain(note)
      await ui.click('Source: Turn 1')
      expect(ui.text()).toContain(note)
    } finally {
      if (ui) ui.unmount()
      else controller.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test.each(['目录_', 'directory_'])('resized long %s paths stay separate from stats and clickable Ask', async prefix => {
    const { DiffFileList } = await import('./DiffFileList.js')
    const { DiffDetailView } = await import('./DiffDetailView.js')
    const { default: ScrollBox } = await import('../../ink/components/ScrollBox.js')
    const { cellAt } = await import('../../ink/screen.js')
    const { useTerminalSize } = await import('../../hooks/useTerminalSize.js')
    const path = prefix.repeat(24) + 'long-file.ts'
    const file = { ...dataFor(1).files[0]!, path, linesRemoved: 1 }
    const hunks = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
      lines: ['-BASE_DISPLAY', '+LONG_UNICODE_BODY'] }]
    const stdout = new Output()
    stdout.isTTY = true
    const stdin = new Input()
    const store = createStore(getDefaultAppState())
    let selected: string | undefined
    let asks = 0
    function Harness() {
      const { columns, rows } = useTerminalSize()
      const width = Math.min(Math.floor(columns * 0.45), 90, columns - 70)
      const [armed, setArmed] = React.useState(false)
      return (
        <Box width={columns} height={rows}>
          <Box width={columns - width} flexShrink={0}><Text>left transcript</Text></Box>
          <Box width={width} flexShrink={0} flexDirection="column" overflow="hidden">
            <Box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden"
              borderStyle="single" borderLeft borderRight={false} borderTop={false} borderBottom={false} paddingX={1}>
              <Text>Diff</Text>
              <ScrollBox height={1} flexShrink={0} flexDirection="column">
                <DiffFileList files={[file]} selectedIndex={0} onSelect={value => { selected = value }} />
              </ScrollBox>
              <ScrollBox flexGrow={1} minHeight={1} flexDirection="column">
                <Box flexDirection="column" flexShrink={0} marginTop={1}>
                  <DiffDetailView filePath={path} hunks={hunks} width={width - 3} armed={armed}
                    onAsk={() => { asks++; setArmed(value => !value) }} />
                </Box>
              </ScrollBox>
            </Box>
          </Box>
        </Box>
      )
    }
    const actEnvironment = Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
    let instance!: Awaited<ReturnType<typeof render>>
    await React.act(async () => {
      instance = await render(<AppStoreContext value={store}><Harness /></AppStoreContext>, {
        stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false,
      })
    })
    const ink = instances.get(stdout as never) as unknown as {
      rootNode: DOMElement
      frontFrame: { screen: Parameters<typeof cellAt>[0] }
    }
    const painted = () => {
      const screen = ink.frontFrame.screen
      return Array.from({ length: screen.height }, (_, y) =>
        Array.from({ length: screen.width }, (_, x) => {
          const cell = cellAt(screen, x, y)
          return cell?.width === 2 ? '' : cell?.char ?? ' '
        }).join('').trimEnd())
    }
    const click = async (label: string) => {
      const find = (node: DOMElement): DOMElement | undefined =>
        node.nodeName === 'ink-text' && textContent(node).includes(label) ? node :
          node.childNodes.flatMap(child => child.nodeName === '#text' ? [] : [find(child)]).find(Boolean)
      const rect = nodeCache.get(find(ink.rootNode)!)!
      expect(rect).toBeDefined()
      await React.act(async () => { expect(dispatchClick(ink.rootNode, rect.x + 1, rect.y)).toBe(true) })
    }
    try {
      for (const armed of [false, true]) {
        for (const width of [144, 143, 110, 109, 110, 180, 110, 180]) {
          await React.act(async () => { stdout.columns = width; stdout.emit('resize') })
          const lines = painted()
          const stats = lines.find(line => line.includes('+1 -1'))
          const ask = lines.find(line => line.includes(armed ? '[Cancel Ask]' : '[Ask]'))
          expect(stats).toMatch(/long-file\.ts\s+\+1 -1$/)
          const control = armed ? '[Cancel Ask]' : '[Ask]'
          const controlStart = ask!.indexOf(control)
          expect(controlStart).toBeGreaterThan(ask!.indexOf('…'))
          const visibleSuffix = ask!.slice(0, controlStart).trimEnd().split('…').at(-1)!
          expect(visibleSuffix.endsWith('-file.ts')).toBe(true)
          expect(path.endsWith(visibleSuffix)).toBe(true)
          if (!armed || width > 110) expect(visibleSuffix.endsWith('long-file.ts')).toBe(true)
          expect(ask!.slice(controlStart).trimEnd()).toBe(control)
          expect(stats).toContain('…')
          expect(ask).toContain('…')
        }
        await click(armed ? '[Cancel Ask]' : '[Ask]')
      }
      expect(asks).toBe(2)
      await click(path)
      expect(selected).toBe(path)
    } finally {
      await React.act(async () => { instance.unmount() })
      Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', actEnvironment)
    }
  })

  test('Diff dialog owns Page and top/bottom keys before transcript scrolling resumes', async () => {
    const data = dataFor(12)
    data.hunks.set(data.files[0]!.path, [patch('long-body', 180)])
    const ui = await mount(new FixtureController(data), true, [], true)
    try {
      ui.resize(109, 52)
      await ui.wait(() => ui.store.getState().activeOverlays.has('diff-dialog'))
      ui.transcript()!.scrollTo(20)
      await ui.key('\r')
      expect(ui.text()).toContain('Diff · detail')
      const body = () => ui.scrolls().at(-1)!
      expect(body().scrollHeight).toBeGreaterThan(body().scrollViewportHeight!)
      await ui.key('\u001b[6~')
      await ui.wait(() => (body().scrollTop ?? 0) > 0)
      await ui.key('\u001b[5~')
      await ui.wait(() => body().scrollTop === 0)
      await ui.key('\u001b[1;5F')
      await ui.wait(() => (body().scrollTop ?? 0) > 0)
      await ui.key('\u001b[1;5H')
      await ui.wait(() => body().scrollTop === 0)
      expect(ui.transcript()!.getScrollTop()).toBe(20)
      expect(ui.counts().transcriptScrolls).toBe(0)
      expect(ui.counts().keys).toBe(0)
      await ui.key('\u001b')
      await ui.wait(() => ui.text().includes('Diff · files'))
      await ui.key('\u001b')
      await ui.wait(() => ui.counts().closes === 1)
      expect(ui.counts().rewinds).toBe(0)
      ui.hide()
      await ui.wait(() => !ui.store.getState().activeOverlays.has('diff-dialog'))
      await ui.key('\u001b[6~')
      await ui.wait(() => ui.transcript()!.getScrollTop() > 20)
      expect(ui.counts().transcriptScrolls).toBe(1)
    } finally {
      ui.unmount()
    }
  })

  test('control characters cannot split diff names or alter their display identity', async () => {
    const data = dataFor(1)
    const path = 'unsafe\n\t\u202eFILE\u200d.ts'
    const hunks = [patch('visible-body')]
    data.files[0]!.path = path
    data.hunks = new Map([[path, hunks]])
    const controller = new FixtureController(data)
    const ui = await mount(controller)
    try {
      await ui.wait(() => ui.text().includes('visible-body'))
      expect(ui.text()).toContain('unsafe    FILE.ts')
      expect(ui.text()).not.toContain(path)
      await ui.click('unsafe    FILE.ts')
      expect(controller.getSnapshot().selectedPath).toBe(path)
      await ui.click('[Ask]')
      expect(ui.text()).toContain('Ask armed: unsafe    FILE.ts')
      expect(controller.beginAsk([])?.text).toContain(path)
    } finally {
      ui.unmount()
    }
  })

  test('diff bodies sanitize display text without changing the Ask snapshot', async () => {
    const data = dataFor(1)
    const raw = 'before\t\u202eafter\u200d\u001b[31m red\u001b[0m'
    data.hunks.set(data.files[0]!.path, [patch(raw)])
    const controller = new FixtureController(data)
    const ui = await mount(controller)
    try {
      await ui.wait(() => ui.text().includes('before'))
      const { default: stripAnsi } = await import('strip-ansi')
      expect(stripAnsi(ui.text())).toContain('before    after red-0')
      expect(ui.text()).not.toContain('\u202e')
      expect(ui.text()).not.toContain('\u200d')
      await ui.click('[Ask]')
      expect(controller.beginAsk([])?.text).toContain(raw)
      expect(data.hunks.get(data.files[0]!.path)![0]!.lines).toEqual([
        `+${raw}-0`,
      ])
    } finally {
      ui.unmount()
    }
  })

  test('source previews and branch labels are single-line display text', async () => {
    const data = dataFor(1)
    data.baseLabel = 'vs branch\u202e-name'
    const controller = new FixtureController(data)
    const ui = await mount(controller, false, [
      createUserMessage({ content: 'preview\t\u202emarker' }),
      createUserMessage({
        content: [
          { type: 'tool_result', tool_use_id: 'edit', content: 'done' },
        ],
        toolUseResult: {
          filePath: 'turn.ts',
          structuredPatch: [patch('body')],
        },
      }),
    ])
    try {
      await ui.wait(() => ui.text().includes('Base: session'))
      expect(ui.text()).toContain('vs branch-name')
      expect(ui.text()).not.toContain('no commits yet')
      await ui.click('Source: Current')
      expect(ui.text()).toContain('preview    marker')
      expect(ui.text()).not.toContain('\u202e')
    } finally {
      ui.unmount()
    }
  })

  test('summary and body wheel are isolated; anchors, Ask, and clicks preserve composer', async () => {
    const controller = new FixtureController(dataFor(16))
    const ui = await mount(controller)
    try {
      await ui.wait(() => ui.text().includes('body-0'))
      const [list, body] = ui.scrolls()
      expect(list!.scrollViewportHeight).toBeLessThanOrEqual(8)
      const wheel = async (element: DOMElement) => {
        const rect = nodeCache.get(element)!
        await ui.key(`\u001b[<65;${rect.x + 2};${rect.y + 1}M`)
      }
      await wheel(list!)
      expect(list!.scrollTop).toBeGreaterThan(0)
      expect(body!.scrollTop).toBe(0)
      await wheel(body!)
      expect(body!.scrollTop).toBeGreaterThan(0)
      expect(ui.counts().wheels).toBe(0)
      const listBeforeLeftWheel = list!.scrollTop
      const bodyBeforeLeftWheel = body!.scrollTop
      await ui.key('\u001b[<65;1;1M')
      expect(ui.counts().wheels).toBe(1)
      expect(list!.scrollTop).toBe(listBeforeLeftWheel)
      expect(body!.scrollTop).toBe(bodyBeforeLeftWheel)
      await ui.key('x')
      expect(ui.counts().keys).toBe(1)
      await ui.click('file-05.ts')
      expect(controller.getSnapshot().selectedPath).toBe('file-05.ts')
      expect(body!.scrollTop).toBeGreaterThan(0)
      const heading = ui
        .elements()
        .find(
          element =>
            element.nodeName === 'ink-text' &&
            textContent(element) === 'file-05.ts',
        )!
      const headingRect = nodeCache.get(heading)!
      expect(headingRect.y).toBe(body!.scrollViewportTop)
      expect(ui.elements().length).toBeLessThanOrEqual(1500)
      await ui.click('[Ask]')
      expect(controller.getSnapshot().armedPath).not.toBeNull()
      expect(ui.text()).toContain('Ask armed:')
      await ui.click('[Cancel Ask]')
      expect(controller.getSnapshot().armedPath).toBeNull()
      expect(ui.counts().mounts).toBe(1)
      ui.hide()
      await ui.wait(() => ui.scrolls().length === 0)
      await ui.key('\u001b[<65;1;1M')
      expect(ui.counts().wheels).toBe(2)
      expect(ui.counts().mounts).toBe(1)
      expect(controller.disposed).toBe(false)
      expect(controller.uiListeners.size).toBe(0)
    } finally {
      ui.unmount()
    }
  })

  test('dialog handles list/detail keys, long-body scrolling and Escape without Rewind', async () => {
    const data = dataFor(2)
    data.hunks.set('file-00.ts', [patch('long-body', 100)])
    const controller = new FixtureController(data)
    const ui = await mount(controller, true)
    try {
      await ui.wait(() =>
        ui.store.getState().activeOverlays.has('diff-dialog'),
      )
      await ui.key('\u001b[B')
      expect(controller.getSnapshot().selectedPath).toBe('file-01.ts')
      await ui.key('\u001b[A')
      await ui.key('\r')
      expect(ui.text()).toContain('Diff · detail')
      const body = ui.scrolls()[0]!
      expect(body.scrollHeight).toBeGreaterThan(body.scrollViewportHeight!)
      await ui.key('\u001b[B')
      expect(body.scrollTop).toBe(3)
      await ui.key('\u001b[B')
      expect(body.scrollTop).toBe(6)
      await ui.key('\u001b[A')
      expect(body.scrollTop).toBe(3)
      await ui.key('\u001b[A')
      await ui.key('\u001b[A')
      expect(body.scrollTop).toBe(0)
      expect(controller.getSnapshot().selectedPath).toBe('file-00.ts')
      await ui.key('\u001b[6~')
      expect(body.scrollTop).toBeGreaterThan(0)
      await ui.key('\u001b')
      await ui.wait(() => ui.text().includes('Diff · files'))
      expect(ui.counts().closes).toBe(0)
      await ui.key('\u001b')
      await ui.wait(() => ui.counts().closes === 1)
      expect(ui.counts().rewinds).toBe(0)
      expect(ui.counts().keys).toBe(0)
      ui.hide()
      await ui.wait(
        () => !ui.store.getState().activeOverlays.has('diff-dialog'),
      )
    } finally {
      ui.unmount()
    }
  })

  test('existing Ctrl+Home/End bindings route to the dialog list, detail and active sidebar only', async () => {
    const data = dataFor(16)
    data.hunks.set('file-00.ts', [patch('long-body', 100)])
    const controller = new FixtureController(data)
    const ui = await mount(controller)
    const top = '\u001b[1;5H'
    const bottom = '\u001b[1;5F'
    try {
      await ui.wait(() => ui.text().includes('long-body'))
      const [list, body] = ui.scrolls()
      await ui.key(bottom)
      await ui.key(top)
      expect(list!.scrollTop).toBe(0)
      expect(body!.scrollTop).toBe(0)
      expect(ui.counts().keys).toBe(2)
      ui.keyboard(true)
      await ui.key(bottom)
      expect(body!.scrollTop).toBe(
        body!.scrollHeight! - body!.scrollViewportHeight!,
      )
      expect(list!.scrollTop).toBe(0)
      await ui.key(top)
      expect(body!.scrollTop).toBe(0)
      expect(ui.counts().keys).toBe(2)
      ui.dialog()
      await ui.wait(() => ui.text().includes('Diff · files'))
      const [dialogList, dialogBody] = ui.scrolls()
      await ui.key(bottom)
      expect(dialogList!.scrollTop).toBe(
        dialogList!.scrollHeight! - dialogList!.scrollViewportHeight!,
      )
      expect(dialogBody!.scrollTop).toBe(0)
      await ui.key(top)
      expect(dialogList!.scrollTop).toBe(0)
      await ui.key('\r')
      expect(ui.text()).toContain('Diff · detail')
      const detail = ui.scrolls()[0]!
      await ui.key(bottom)
      const last = detail.scrollHeight! - detail.scrollViewportHeight!
      expect(detail.scrollTop).toBe(last)
      await ui.key('\u001b[B')
      expect(detail.scrollTop).toBe(last)
      await ui.key('\u001b[A')
      expect(detail.scrollTop).toBe(last - 3)
      await ui.key(top)
      expect(detail.scrollTop).toBe(0)
      await ui.key('\u001b[F')
      expect(detail.scrollTop).toBe(0)
      await ui.key(bottom)
      await ui.key('\u001b[H')
      expect(detail.scrollTop).toBe(last)
      expect(controller.getSnapshot().selectedPath).toBe('file-00.ts')
      expect(ui.counts()).toMatchObject({ keys: 2, rewinds: 0, mounts: 1 })
      ui.hide()
      await ui.wait(
        () => !ui.store.getState().activeOverlays.has('diff-dialog'),
      )
      await ui.key(top)
      expect(ui.counts().keys).toBe(3)
    } finally {
      ui.unmount()
    }
  })

  test('base/source, latest TodoWrite input, replacement turns and shared controller survive presentation changes', async () => {
    const tool = (id: string, name: string, statuses: string[] = []) =>
      createAssistantMessage({
        content: [
          {
            type: 'tool_use',
            id,
            name,
            input: { todos: statuses.map(status => ({ status })) },
          },
        ],
      })
    const todos = (id: string, statuses: string[], error = false) =>
      createUserMessage({
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            content: 'fixture',
            is_error: error,
          },
        ],
        toolUseResult: {
          newTodos: statuses.map(status => ({
            content: 'fixture',
            status,
            activeForm: 'fixture',
          })),
        },
      })
    const messages: Message[] = [
      createUserMessage({ content: 'edit a file' }),
      createUserMessage({
        content: [
          { type: 'tool_result', tool_use_id: 'edit', content: 'done' },
        ],
        toolUseResult: {
          filePath: 'turn.ts',
          structuredPatch: [patch('turn-marker')],
        },
      }),
      tool('todos-ok', 'TodoWrite'),
      todos('todos-ok', ['completed', 'pending']),
      tool('todos-error', 'TodoWrite'),
      todos('todos-error', ['completed'], true),
      tool('todos-pending', 'TodoWrite', [
        'completed',
        'completed',
        'pending',
      ]),
    ]
    const controller = new FixtureController(dataFor())
    const ui = await mount(controller, false, messages)
    try {
      await ui.wait(() => ui.text().includes('Todos 2/3'))
      await ui.click('Base: session')
      expect(ui.text()).toContain('Base: uncommitted')
      await ui.click('Base: uncommitted')
      expect(ui.text()).toContain('Base: branch')
      await ui.click('Source: Current')
      expect(ui.text()).toContain('Source: Turn 1')
      expect(ui.text()).toContain('turn-marker')
      expect(ui.text()).not.toContain('file-00.ts')
      ui.messages([
        ...messages,
        createUserMessage({
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'edit-more',
              content: 'done',
            },
          ],
          toolUseResult: {
            filePath: 'z-turn-later.ts',
            structuredPatch: [patch('turn-later-marker')],
          },
        }),
      ])
      await ui.wait(() => ui.text().includes('turn-later-marker'))
      await ui.click('[Ask]')
      expect(controller.beginAsk([])?.text).toContain('Turn 1')
      await ui.click('Source: Turn 1')
      expect(ui.text()).toContain('Ask armed: turn.ts')
      await ui.click('Ask armed: turn.ts')
      expect(controller.getSnapshot().armedPath).toBeNull()
      await ui.click('Source: Current')
      await ui.click('[Ask]')
      ui.dialog()
      await ui.wait(() => ui.text().includes('Diff · files'))
      expect(ui.text()).toContain('Source: Turn 1')
      expect(ui.text()).toContain('Ask armed: turn.ts')
      expect(ui.counts().mounts).toBe(1)
      ui.messages([
        createUserMessage({ content: 'replacement transcript' }),
      ])
      await ui.wait(() => ui.text().includes('Source: Current'))
      expect(ui.text()).toContain('Todos 0/0')
    } finally {
      ui.unmount()
    }
  })

  test('interactive diff counts real Task tools and ignores stale TodoWrite history and internal tasks', async () => {
    const { setIsInteractive } = await import('../../bootstrap/state.js')
    const { TaskCreateTool } = await import('../../tools/TaskCreateTool/TaskCreateTool.js')
    const { TaskUpdateTool } = await import('../../tools/TaskUpdateTool/TaskUpdateTool.js')
    const { getTaskListId, resetTaskList, isTodoV2Enabled } = await import('../../utils/tasks.js')
    setIsInteractive(true)
    expect(isTodoV2Enabled()).toBe(true)
    const controller = new FixtureController(dataFor())
    const ui = await mount(controller, false, [createAssistantMessage({
      content: [{ type: 'tool_use', id: 'old-todo', name: 'TodoWrite',
        input: { todos: [{ status: 'completed' }, { status: 'pending' }] } }],
    })])
    const context = {
      abortController: new AbortController(),
      getAppState: ui.store.getState,
      setAppState: ui.store.setState,
    } as unknown as import('../../Tool.js').ToolUseContext
    const create = (subject: string, metadata?: Record<string, unknown>) =>
      TaskCreateTool.call({ subject, description: subject, metadata }, context)
    try {
      await create('internal', { _internal: true })
      const first = await create('first')
      const second = await create('second')
      await ui.wait(() => ui.text().includes('Todos 0/2'))
      await TaskUpdateTool.call({ taskId: first.data.task.id, status: 'completed' }, context)
      await ui.wait(() => ui.text().includes('Todos 1/2'))
      ui.dialog()
      await ui.wait(() => ui.text().includes('Diff · files'))
      expect(ui.text()).toContain('Todos 1/2')
      await TaskUpdateTool.call({ taskId: second.data.task.id, status: 'deleted' }, context)
      await ui.wait(() => ui.text().includes('Todos 1/1'))
      await resetTaskList(getTaskListId())
      await ui.wait(() => ui.text().includes('Todos 0/0'))
    } finally {
      ui.unmount()
      await resetTaskList(getTaskListId())
      setIsInteractive(false)
    }
  })

  test('turn files use the same noise classification as current Git files', async () => {
    const controller = new FixtureController(dataFor())
    const messages: Message[] = [
      createUserMessage({ content: 'edit tests' }),
      createUserMessage({
        content: [
          { type: 'tool_result', tool_use_id: 'edit', content: 'done' },
        ],
        toolUseResult: {
          filePath: 'tests/example.ts',
          structuredPatch: [patch('hidden-test-marker')],
        },
      }),
    ]
    const ui = await mount(controller, false, messages)
    try {
      await ui.wait(() => ui.text().includes('Source: Current'))
      await ui.click('Source: Current')
      expect(ui.text()).not.toContain('hidden-test-marker')
      await ui.click('Noise 1 [off]')
      expect(ui.text()).toContain('hidden-test-marker')
    } finally {
      ui.unmount()
    }
  })

  test('loading, unknown body, failed refresh and non-repository never look clean', async () => {
    const data = dataFor(1)
    data.hunks.clear()
    const controller = new FixtureController(data)
    const ui = await mount(controller)
    try {
      await ui.wait(() => ui.text().includes('Diff body unavailable'))
      for (const [bodyState, expected] of [
        ['loading', 'Loading diff body'],
        ['unavailable', 'Diff body unavailable'],
        ['binary', 'Binary file - cannot display diff'],
        ['large', 'Large file - diff exceeds display limit'],
        ['no-body', 'No textual diff'],
      ] as const) {
        controller.publish({
          ...data,
          files: [{ ...data.files[0]!, bodyState }],
        })
        await ui.wait(() => ui.text().includes(expected))
        expect(ui.text()).not.toContain('Working tree is clean')
      }
      controller.publish({ ...data, outcome: 'unavailable' })
      await ui.wait(() => ui.text().includes('showing last good data'))
      expect(ui.text()).toContain('file-00.ts')
      controller.publish({
        stats: null,
        files: [],
        hunks: new Map(),
        loading: false,
        outcome: 'no-repository',
      })
      await ui.wait(() => ui.text().includes('Not a Git repository'))
      expect(ui.text()).not.toContain('Working tree is clean')
    } finally {
      ui.unmount()
    }
  })

  test('a failed body refresh still renders the retained body with a warning', async () => {
    const data = dataFor(1)
    data.files[0]!.bodyState = 'unavailable' as any
    const controller = new FixtureController(data)
    const ui = await mount(controller)
    try {
      await ui.wait(() => ui.text().includes('showing last good body'))
      expect(ui.text()).toContain('body-0')
      expect(ui.text()).toContain('Diff body unavailable')
      expect(ui.text()).not.toContain('[Ask]')
    } finally {
      ui.unmount()
    }
  })

  test('withheld untracked files never imply a clean repository', async () => {
    const data = { ...dataFor(0), isUntrackedWithheld: true }
    const controller = new FixtureController(data)
    const ui = await mount(controller)
    try {
      await ui.wait(() =>
        ui.text().includes('Untracked files unavailable; not counted'),
      )
      expect(ui.text()).toContain('No tracked changes')
      expect(ui.text()).not.toContain('Working tree is clean')
      controller.publish({ ...dataFor(1), isUntrackedWithheld: true })
      await ui.wait(() => ui.text().includes('file-00.ts'))
      expect(ui.text()).toContain(
        'Untracked files unavailable; not counted',
      )
    } finally {
      ui.unmount()
    }
  })

  test('109/110/143/144 widths and small height keep body usable without stealing composer keys', async () => {
    const controller = new FixtureController(dataFor(3))
    const ui = await mount(controller)
    try {
      for (const columns of [109, 110, 143, 144]) {
        ui.resize(columns, 10)
        await ui.wait(
          () => (ui.scrolls()[1]?.scrollViewportHeight ?? 0) >= 1,
        )
        const close = ui
          .elements()
          .find(
            el => el.nodeName === 'ink-text' && textContent(el) === '✕',
          )!
        const rect = nodeCache.get(close)!
        expect(rect.x).toBeLessThan(columns)
        expect(rect.y).toBeLessThan(10)
      }
      await ui.key('\u001b[B')
      expect(controller.getSnapshot().selectedPath).toBeNull()
      ui.keyboard(true)
      await new Promise(resolve => setTimeout(resolve, 20))
      await ui.key('\u001b[B')
      expect(controller.getSnapshot().selectedPath).toBe('file-01.ts')
      expect(ui.counts().mounts).toBe(1)
      ui.dialog()
      await ui.wait(() => ui.text().includes('Diff · files'))
      const body = ui.scrolls().at(-1)!
      expect(body.scrollViewportHeight).toBeGreaterThanOrEqual(1)
      expect(
        body.scrollViewportTop! + body.scrollViewportHeight!,
      ).toBeLessThanOrEqual(10)
    } finally {
      ui.unmount()
    }
  })

  test('large and fragmented bodies stay inside render budgets with explicit truncation', async () => {
    const data = dataFor(45)
    for (const file of data.files)
      data.hunks.set(
        file.path,
        Array.from({ length: 100 }, () =>
          patch('const punctuation = [a,b,c,d,e,f,g,h,i,j];', 40),
        ),
      )
    const controller = new FixtureController(data)
    const ui = await mount(controller)
    try {
      await ui.wait(() => ui.text().includes('render budget'))
      expect(ui.elements().length).toBeLessThanOrEqual(1500)
      expect(ui.text().length).toBeLessThanOrEqual(80_000)
      ui.store.setState(previous => ({
        ...previous,
        settings: {
          ...previous.settings,
          syntaxHighlightingDisabled: true,
        },
      }))
      await ui.wait(
        () =>
          !ui
            .elements()
            .some(element => element.nodeName === 'ink-raw-ansi'),
      )
      expect(ui.elements().length).toBeLessThanOrEqual(1500)
      expect(ui.text().length).toBeLessThanOrEqual(80_000)
      controller.publish({
        ...data,
        files: [data.files[0]!],
        hunks: new Map([
          [data.files[0]!.path, [patch('x'.repeat(12_000))]],
        ]),
      })
      await ui.wait(() => !ui.text().includes('file-01.ts'))
      expect(ui.text()).toContain('render budget')
      expect(ui.text()).not.toContain('x'.repeat(10_001))
    } finally {
      ui.unmount()
    }
  })

  test('noise and pre-session filters are independent and cap bodies at 20 files', async () => {
    const data = dataFor(23)
    data.files[0]!.isNoise = true
    for (const file of data.files.slice(1)) file.isPreSession = true
    const controller = new FixtureController(data)
    const ui = await mount(controller)
    try {
      await ui.wait(() => ui.text().includes('No visible changes'))
      await ui.click('Noise 1 [off]')
      expect(ui.text()).toContain('file-00.ts')
      expect(ui.text()).not.toContain('file-01.ts')
      await ui.click('Pre-session 22 [off]')
      expect(ui.text()).toContain('body-20')
      expect(ui.text()).not.toContain('body-21')
      expect(ui.text()).toContain(
        '2 pre-session bodies omitted (20 file limit)',
      )
      await ui.click('Noise 1 [on]')
      expect(ui.text()).not.toContain('file-00.ts')
      expect(ui.text()).toContain('body-20')
    } finally {
      ui.unmount()
    }
  })
}
