import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childKey = 'DIFF_SIDEBAR_TEST_CHILD'

if (!process.env[childKey]) {
  test.each([
    'continuous',
    'interaction',
    'subdirectory',
    'clean',
    'untracked',
    'binary',
  ])(
    'real Git sidebar: %s',
    async scenario => {
      const root = mkdtempSync(join(tmpdir(), 'diff-sidebar-'))
      try {
        const git = (...args: string[]) => {
          const result = Bun.spawnSync(['git', ...args], { cwd: root })
          if (result.exitCode !== 0) throw new Error(result.stderr.toString())
        }
        git('init', '-q')
        writeFileSync(
          join(root, '.git/info/exclude'),
          'config/\nLibrary/\n.cache/\n',
        )
        const cwd = scenario === 'subdirectory' ? join(root, 'sub') : root
        if (cwd !== root) mkdirSync(cwd)
        writeFileSync(join(cwd, 'tracked.txt'), 'before\n')
        if (scenario === 'continuous')
          writeFileSync(join(root, 'second.txt'), 'second-before\n')
        git('add', '.')
        git(
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-qm',
          'fixture',
        )
        if (scenario === 'interaction' || scenario === 'subdirectory')
          writeFileSync(join(cwd, 'tracked.txt'), 'after\n')
        if (scenario === 'continuous') {
          writeFileSync(join(root, 'tracked.txt'), 'first-body-marker\n')
          writeFileSync(join(root, 'second.txt'), 'second-body-marker\n')
        }
        if (scenario === 'untracked')
          writeFileSync(join(root, 'new.txt'), 'untracked-body-marker\n')
        if (scenario === 'binary')
          writeFileSync(join(root, 'tracked.txt'), Buffer.from([0, 1, 2]))
        const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            CLAUDE_CONFIG_DIR: join(root, 'config'),
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            DISABLE_AUTOUPDATER: '1',
            [childKey]: cwd,
            DIFF_SIDEBAR_SCENARIO: scenario,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
        expect(code).toBe(0)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    10000,
  )
} else {
  test('real diff sidebar interaction', async () => {
    process.chdir(process.env[childKey]!)
    const React = await import('react')
    const { Readable, Writable } = await import('node:stream')
    const { Box, Text, render, useInput } = await import('../../ink.js')
    const { DiffSidebar } = await import('./DiffSidebar.js')
    const { DiffController } = await import('../../services/diff/controller.js')
    const controller =
      process.env.DIFF_SIDEBAR_SCENARIO === 'continuous'
        ? new DiffController({ cwd: process.cwd(), sessionStartMs: 0 })
        : undefined
    const { setOriginalCwd, setCwdState } =
      await import('../../bootstrap/state.js')
    const { default: instances } = await import('../../ink/instances.js')
    const { nodeCache } = await import('../../ink/node-cache.js')
    const { dispatchClick } = await import('../../ink/hit-test.js')
    type DOMElement = import('../../ink/dom.js').DOMElement
    type DOMNode = import('../../ink/dom.js').DOMNode
    setOriginalCwd(process.cwd())
    setCwdState(process.cwd())

    class Output extends Writable {
      columns = 80
      rows = 24
      isTTY = false
      output = ''
      _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
        this.output += chunk.toString()
        callback()
      }
    }
    class Input extends Readable {
      isTTY = true
      isRaw = false
      _read() {}
      setRawMode(value: boolean) {
        this.isRaw = value
        return this
      }
      ref() {
        return this
      }
      unref() {
        return this
      }
    }
    const stdout = new Output()
    const { AppStoreContext, getDefaultAppState } =
      await import('../../state/AppState.js')
    const { createStore } = await import('../../state/store.js')
    const store = createStore(getDefaultAppState())
    let closed = false
    let transcriptWheels = 0
    const stdin = new Input()
    function TranscriptInput() {
      useInput((_input, key) => {
        if (key.wheelDown || key.wheelUp) transcriptWheels++
      })
      return <Text>transcript</Text>
    }
    type Message = import('../../types/message.js').Message
    let messages: Message[] = []
    const draw = () => (
      <AppStoreContext value={store}>
        <Box width={80} height={24} flexDirection="column">
          <TranscriptInput />
          {closed ? (
            <Text>closed</Text>
          ) : (
            <DiffSidebar
              messages={messages}
              controller={controller}
              onClose={() => {
                closed = true
              }}
            />
          )}
        </Box>
      </AppStoreContext>
    )
    const instance = await render(draw(), {
      stdout: stdout as never,
      stdin: stdin as never,
      patchConsole: false,
      exitOnCtrlC: false,
    })
    const root = () => {
      const ink = instances.get(stdout as never) as unknown as
        | { rootNode: DOMElement }
        | undefined
      if (!ink) throw new Error(`Renderer exited: ${stdout.output}`)
      return ink.rootNode
    }
    const textContent = (node: DOMNode): string =>
      node.nodeName === '#text'
        ? node.nodeValue
        : node.childNodes.map(textContent).join('')
    const texts = () => {
      const found: DOMElement[] = []
      const visit = (node: DOMElement) => {
        if (node.nodeName === 'ink-text' && nodeCache.has(node))
          found.push(node)
        node.childNodes.forEach(child => {
          if (child.nodeName !== '#text') visit(child)
        })
      }
      visit(root())
      return found
    }
    const waitFor = async (text: string) => {
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        const node = texts().find(node => textContent(node).includes(text))
        if (node) return node
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      throw new Error(`Missing ${text}: ${texts().map(textContent).join('\n')}`)
    }
    const click = async (text: string) => {
      const node = await waitFor(text)
      const rect = nodeCache.get(node)!
      expect(dispatchClick(root(), rect.x, rect.y)).toBe(true)
    }
    try {
      const scenario = process.env.DIFF_SIDEBAR_SCENARIO
      if (scenario === 'continuous') {
        await waitFor('tracked.txt')
        const deadline = Date.now() + 3000
        while (
          (!stdout.output.includes('first-body-marker') ||
            !stdout.output.includes('second-body-marker')) &&
          Date.now() < deadline
        ) {
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        expect(stdout.output).toContain('first-body-marker')
        expect(stdout.output).toContain('second-body-marker')
        expect(texts().map(textContent).join('\n')).not.toContain(
          'Back to files',
        )
        return
      }
      if (scenario === 'clean') {
        await waitFor('Working tree is clean')
        await click('✕')
        expect(closed).toBe(true)
        return
      }
      if (scenario === 'untracked' || scenario === 'binary') {
        await click('Pre-session 1 [off]')
        await click(scenario === 'untracked' ? 'new.txt' : 'tracked.txt')
        await waitFor(
          scenario === 'untracked'
            ? '(untracked)'
            : 'Binary file - cannot display diff',
        )
        if (scenario === 'untracked') {
          // The backend explicitly withholds untracked bodies. Do not imply an
          // empty file or bypass that boundary with a component filesystem read.
          await waitFor('New file not yet staged; diff body not loaded')
          expect(texts().map(textContent).join('\n')).not.toContain(
            'metadata-only',
          )
        }
        await click('✕')
        expect(closed).toBe(true)
        return
      }
      await waitFor('No visible changes (check filters)')
      await click('Pre-session 1 [off]')
      const fileNode = await waitFor('tracked.txt')
      const fileRect = nodeCache.get(fileNode)!
      stdin.push(`\u001b[<65;${fileRect.x + 1};${fileRect.y + 1}M`)
      await new Promise(resolve => setTimeout(resolve, 60))
      expect(transcriptWheels).toBe(0)
      stdin.push('\u001b[<65;1;1M')
      await new Promise(resolve => setTimeout(resolve, 60))
      expect(transcriptWheels).toBe(1)
      await click('tracked.txt')
      const detailDeadline = Date.now() + 3000
      while (!stdout.output.includes('after') && Date.now() < detailDeadline) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(stdout.output).toContain('after')
      writeFileSync(join(process.cwd(), 'tracked.txt'), 'refreshed-marker\n')
      const refreshDeadline = Date.now() + 3500
      while (
        !stdout.output.includes('refreshed-marker') &&
        Date.now() < refreshDeadline
      ) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(stdout.output).toContain('refreshed-marker')
      // File clicks now anchor the continuous body rather than entering detail mode.
      expect(texts().map(textContent).join('\n')).not.toContain('Back to files')
      await click('Pre-session 0 [on]')
      const { createUserMessage } = await import('../../utils/messages.js')
      const { ThemeProvider } = await import('../../ink.js')
      messages = [
        createUserMessage({ content: 'edit fixture' }),
        createUserMessage({
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'fixture-edit',
              content: 'updated',
            },
          ],
          toolUseResult: {
            filePath: join(process.cwd(), 'tracked.txt'),
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ['-before', '+refreshed-marker'],
              },
            ],
          },
        }),
      ]
      instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
      await click('Source: Current')
      await waitFor('Source: Turn 1')
      await waitFor('tracked.txt')
      messages = [
        createUserMessage({ content: 'different resumed conversation' }),
        createUserMessage({ content: 'no edits here' }),
      ]
      instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
      await waitFor('Source: Current')
      await waitFor('Pre-session 0 [off]')
      await click('✕')
      expect(closed).toBe(true)
      instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
      await waitFor('closed')
      stdin.push(`\u001b[<65;${fileRect.x + 1};${fileRect.y + 1}M`)
      await new Promise(resolve => setTimeout(resolve, 60))
      expect(transcriptWheels).toBe(2)
    } finally {
      instance.unmount()
      controller?.dispose()
    }
  }, 8000)
}
