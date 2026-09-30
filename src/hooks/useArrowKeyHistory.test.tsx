import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childKey = 'ARROW_HISTORY_CURSOR_CHILD'
if (!process.env[childKey]) {
  test('history recall places the cursor after the recalled input', async () => {
    const config = mkdtempSync(join(tmpdir(), 'arrow-history-'))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: config,
          [childKey]: '1',
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
      rmSync(config, { recursive: true, force: true })
    }
  })
} else {
  const React = await import('react')
  const { Readable, Writable } = await import('node:stream')
  const { Text, render } = await import('../ink.js')
  const { AppStoreContext, getDefaultAppState } =
    await import('../state/AppState.js')
  const { createStore } = await import('../state/store.js')
  const { addToHistory } = await import('../history.js')
  const { useArrowKeyHistory } = await import('./useArrowKeyHistory.js')

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

  class Output extends Writable {
    columns = 80
    rows = 24
    isTTY = true
    _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
      done()
    }
  }

  test('recalls the newest entry with its cursor at the end', async () => {
    addToHistory('/diff')
    let recall: (() => void) | undefined
    let value = ''
    let cursor = -1

    function Probe() {
      const history = useArrowKeyHistory(
        next => {
          value = next
        },
        '',
        {},
        next => {
          cursor = next
        },
        'prompt',
      )
      recall = history.onHistoryUp
      return <Text>{value}</Text>
    }

    const instance = await render(
      <AppStoreContext value={createStore(getDefaultAppState())}>
        <Probe />
      </AppStoreContext>,
      {
        stdin: new Input() as never,
        stdout: new Output() as never,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    )

    try {
      recall!()
      const deadline = Date.now() + 5000
      while (value !== '/diff' && Date.now() < deadline) {
        await new Promise(resolve => setImmediate(resolve))
      }
      expect(value).toBe('/diff')
      expect(cursor).toBe('/diff'.length)
    } finally {
      instance.unmount()
    }
  })
}
