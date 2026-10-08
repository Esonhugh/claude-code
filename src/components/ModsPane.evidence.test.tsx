import { expect, test } from 'bun:test'
import React from 'react'
import { Readable, Writable } from 'node:stream'
import { Box, Text, ThemeProvider, createRoot } from '../ink.js'
import type { FrameEvent } from '../ink/frame.js'
import {
  createModUi,
  getModUiSnapshotTerminalRevision,
  getModUiTerminalIdentity,
  withModUiPaneFocus,
} from '../services/mods/ui.js'
import { ModsPane } from './ModsPane.js'

class Output extends Writable {
  columns = 110
  rows = 34
  isTTY = false
  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    callback()
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
type Witness = {
  plugin: string
  id: string
  revision: number
  drawing: number
  activation: number
  lease: number
  mount: number
  visible: boolean
  placement: string
  rect: { x: number; y: number; width: number; height: number }
  actualFocusWithin: boolean
}

type Cleanup = () => void | Promise<void>
async function withFrameEvidence(
  path: string,
  run: (defer: (cleanup: Cleanup) => void) => Promise<void>,
) {
  const previous = process.env.CLAUDE_CODE_FRAME_EVIDENCE_PATH
  process.env.CLAUDE_CODE_FRAME_EVIDENCE_PATH = path
  const cleanups: Cleanup[] = []
  const failures: unknown[] = []
  try {
    await run(cleanup => cleanups.push(cleanup))
  } catch (error) {
    failures.push(error)
  } finally {
    try {
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup()
        } catch (error) {
          failures.push(error)
        }
      }
    } finally {
      if (previous === undefined)
        delete process.env.CLAUDE_CODE_FRAME_EVIDENCE_PATH
      else process.env.CLAUDE_CODE_FRAME_EVIDENCE_PATH = previous
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      'terminal evidence setup or cleanup failed',
    )
}

test('terminal evidence retains an empty action Button as the actual focus landing', async () => {
  await withFrameEvidence(
    '/private/tmp/unused-empty-action-evidence-unit',
    async defer => {
      const owner = {}
      const presentation = {
        columns: 110,
        rows: 34,
        isFullscreen: true,
        composerEmpty: true,
        hasDialog: false,
        keyboardOwned: false,
      }
      const ui = createModUi({
        pluginOf: () => 'fixture',
        dispatch: async (_owner, _event, input, core) => core(input),
        draw: async () => ({
          type: 'Box',
          children: [
            {
              type: 'Button',
              props: {
                key: 'base',
                label: '',
                plain: true,
                action: 'app:cycleDiffBase',
              },
              press: { plugin: 'fixture', handle: 1 },
            },
            {
              type: 'Button',
              props: { key: 'next', label: 'VISIBLE_NEXT' },
              press: { plugin: 'fixture', handle: 2 },
            },
          ],
        }),
        invokeDrawing: async () => undefined,
        releaseDrawing: async () => {},
      })
      defer(() => ui.dispose())
      await ui.open(
        owner,
        { id: 'pane', focus: true },
        { kind: 'person' },
        presentation,
      )
      await ui.commit(owner)
      await ui.focus(
        owner,
        { requestId: 'pane', element: 'base', origin: { kind: 'person' } },
        presentation,
      )
      const ready = Promise.withResolvers<FrameEvent>()
      const deadline = setTimeout(
        () => ready.reject(Error('empty action frame deadline exceeded')),
        3000,
      )
      defer(() => clearTimeout(deadline))
      const app = await createRoot({
        stdout: new Output() as never,
        stdin: new Input() as never,
        patchConsole: false,
        exitOnCtrlC: false,
        onFrame: event => {
          if (
            event.terminalPanes?.[0]?.focusedElement === 'base' &&
            event.terminalPanes[0].actualFocusWithin
          )
            ready.resolve(event)
        },
      })
      defer(() => app.unmount())
      app.render(
        <ThemeProvider>
          <ModsPane
            pane={ui.getSnapshot()[0]!}
            onInteract={async () => {}}
            onClose={async () => {}}
            onFocus={async () => ({})}
            onScroll={async () => ({})}
          />
        </ThemeProvider>,
      )
      const current = (await ready.promise).terminalPanes![0]!
      expect(
        current.controls.find(control => control.key === 'base'),
      ).toMatchObject({
        plugin: 'fixture',
        key: 'base',
        rect: null,
        paintable: false,
        emptyButton: true,
      })
      expect(current.actualFocusedElement).toBe('base')
      expect(current.actualFocusedPlugin).toBe('fixture')
      expect(
        current.controls.find(control => control.key === 'next'),
      ).toMatchObject({
        plugin: 'fixture',
        key: 'next',
        paintable: true,
        emptyButton: false,
      })
    },
  )
})

test('terminal evidence follows committed Pane props and painted geometry through resize, close and reopen', async () => {
  await withFrameEvidence(
    '/private/tmp/unused-pane-frame-evidence-unit',
    async defer => {
      const owner = {}
      const presentation = {
        columns: 110,
        rows: 34,
        isFullscreen: true,
        composerEmpty: true,
        hasDialog: false,
        keyboardOwned: false,
      }
      const ui = createModUi({
        pluginOf: () => 'fixture',
        dispatch: async (_owner, _event, input, core) => core(input),
        draw: async () => ({ type: 'Text', children: ['PAINTED_BODY'] }),
        invokeDrawing: async () => undefined,
        releaseDrawing: async () => {},
      })
      defer(() => ui.dispose())
      await ui.open(owner, { id: 'pane' }, { kind: 'person' }, presentation)
      await ui.commit(owner)
      let committed = ui.getSnapshot()[0]!
      expect(getModUiSnapshotTerminalRevision(ui.getSnapshot())).toBe(
        committed.revision,
      )
      expect(
        getModUiTerminalIdentity(withModUiPaneFocus(committed, false)),
      ).toEqual(getModUiTerminalIdentity(committed))
      expect(getModUiTerminalIdentity({ ...committed })).toBeUndefined()
      let hidden = false
      let clipped = false
      const events: FrameEvent[] = []
      const waiters = new Set<() => void>()
      const untilFrame = (predicate: () => boolean) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            waiters.delete(check)
            reject(Error('painted frame deadline exceeded'))
          }, 3000)
          defer(() => {
            clearTimeout(timer)
            waiters.delete(check)
          })
          const check = () => {
            if (predicate()) {
              clearTimeout(timer)
              waiters.delete(check)
              resolve()
            }
          }
          waiters.add(check)
          check()
        })
      const stdout = new Output()
      const witness = () =>
        (events.at(-1) as FrameEvent & { terminalPanes?: Witness[] })
          ?.terminalPanes
      function Consumer() {
        return (
          <Box
            {...{ terminalUiRevision: committed.revision }}
            flexDirection="row"
            display={hidden ? 'none' : 'flex'}
          >
            <Box width={71}>
              <Text>TRANSCRIPT</Text>
            </Box>
            <Box
              height={clipped ? 0 : undefined}
              overflow="hidden"
              flexShrink={0}
            >
              <ModsPane
                pane={committed}
                onInteract={async () => {}}
                onClose={async () => {}}
                onFocus={async () => ({})}
                onScroll={async () => ({})}
              />
            </Box>
          </Box>
        )
      }
      const app = await createRoot({
        stdout: stdout as never,
        stdin: new Input() as never,
        patchConsole: false,
        exitOnCtrlC: false,
        onFrame: event => {
          events.push(event)
          for (const check of waiters) check()
        },
      })
      defer(() => app.unmount())
      app.render(
        <ThemeProvider>
          <Consumer />
        </ThemeProvider>,
      )
      const repaint = async () => {
        const before = events.length
        app.render(
          <ThemeProvider>
            <Consumer />
          </ThemeProvider>,
        )
        await untilFrame(() => events.length > before)
      }
      await untilFrame(() => events.length > 0)
      expect(witness()).toHaveLength(1)
      const first = witness()![0]!
      expect(
        (events.at(-1) as FrameEvent & { terminalUiRevision?: number })
          .terminalUiRevision,
      ).toBe(committed.revision)
      expect(first).toMatchObject({
        plugin: 'fixture',
        id: 'pane',
        revision: committed.revision,
        drawing: committed.drawing,
        visible: true,
        placement: 'dock',
        actualFocusWithin: false,
      })
      expect(first.rect).toMatchObject({ x: 71, width: 39 })
      expect(first.activation).toBeGreaterThan(0)
      expect(first.lease).toBeGreaterThan(0)
      // A newer host publish alone cannot relabel the still committed DOM.
      await ui.render({ ...presentation, columns: 109 })
      await repaint()
      expect(witness()![0]!.revision).toBe(committed.revision)
      expect(witness()![0]!.drawing).toBe(committed.drawing)
      expect(
        (events.at(-1) as FrameEvent & { terminalUiRevision?: number })
          .terminalUiRevision,
      ).toBe(committed.revision)
      committed = ui.getSnapshot()[0]!
      await repaint()
      expect(witness()![0]).toMatchObject({
        revision: committed.revision,
        drawing: committed.drawing,
        activation: first.activation,
        lease: first.lease,
        placement: 'inline',
      })
      expect(witness()![0]!.mount).toBeGreaterThan(0)
      await ui.close(owner, 'pane', { kind: 'person' })
      const closedRevision = getModUiSnapshotTerminalRevision(ui.getSnapshot())!
      expect(closedRevision).toBeGreaterThan(committed.revision)
      const beforeClose = events.length
      app.render(
        <ThemeProvider>
          <Box terminalUiRevision={closedRevision}>
            <Text>CLOSED</Text>
          </Box>
        </ThemeProvider>,
      )
      await untilFrame(() => events.length > beforeClose)
      expect(witness()).toEqual([])
      expect(
        (events.at(-1) as FrameEvent & { terminalUiRevision?: number })
          .terminalUiRevision,
      ).toBe(closedRevision)
      await ui.open(owner, { id: 'pane' }, { kind: 'person' }, presentation)
      committed = ui.getSnapshot()[0]!
      await repaint()
      const reopened = witness()![0]!
      expect(reopened.activation).toBe(first.activation)
      expect(reopened.lease).not.toBe(first.lease)
      expect(reopened.mount).not.toBe(first.mount)
      // A hidden registration must not masquerade as an unmounted Pane.
      hidden = true
      await repaint()
      expect(witness()).toHaveLength(1)
      expect(witness()![0]).toMatchObject({
        paintable: false,
        rect: null,
        bodyRect: null,
      })
      hidden = false
      clipped = true
      await repaint()
      expect(witness()).toHaveLength(1)
      expect(witness()![0]).toMatchObject({
        paintable: false,
        rect: null,
        bodyRect: null,
      })
      clipped = false
      await repaint()
      expect(witness()).toHaveLength(1)
      expect(witness()![0]).toMatchObject({ paintable: true })
    },
  )
})

// These deliberate failures exercise the same scope as the real Ink tests.
// Restore the outer environment even when this regression test itself fails.
test('terminal evidence restores environment and disposes resources when setup rejects', async () => {
  const original = process.env.CLAUDE_CODE_FRAME_EVIDENCE_PATH
  const setupError = Error('deliberate setup rejection')
  const cleaned: string[] = []
  process.env.CLAUDE_CODE_FRAME_EVIDENCE_PATH = 'outer-evidence-owner'
  try {
    await expect(
      withFrameEvidence('failed-render-owner', async defer => {
        defer(() => {
          cleaned.push('dispose')
        })
        throw setupError
      }),
    ).rejects.toBe(setupError)
    expect(process.env.CLAUDE_CODE_FRAME_EVIDENCE_PATH).toBe(
      'outer-evidence-owner',
    )
    expect(cleaned).toEqual(['dispose'])
  } finally {
    if (original === undefined)
      delete process.env.CLAUDE_CODE_FRAME_EVIDENCE_PATH
    else process.env.CLAUDE_CODE_FRAME_EVIDENCE_PATH = original
  }
})

test('terminal evidence restores environment and completes disposal when unmount throws', async () => {
  const original = process.env.CLAUDE_CODE_FRAME_EVIDENCE_PATH
  const unmountError = Error('deliberate unmount failure')
  const cleaned: string[] = []
  delete process.env.CLAUDE_CODE_FRAME_EVIDENCE_PATH
  try {
    await expect(
      withFrameEvidence('failed-unmount-owner', async defer => {
        defer(() => {
          cleaned.push('dispose')
        })
        defer(() => {
          cleaned.push('unmount')
          throw unmountError
        })
      }),
    ).rejects.toBe(unmountError)
    expect(process.env.CLAUDE_CODE_FRAME_EVIDENCE_PATH).toBeUndefined()
    expect(cleaned).toEqual(['unmount', 'dispose'])
  } finally {
    if (original === undefined)
      delete process.env.CLAUDE_CODE_FRAME_EVIDENCE_PATH
    else process.env.CLAUDE_CODE_FRAME_EVIDENCE_PATH = original
  }
})

test('terminal evidence retains setup and disposal errors without leaking environment', async () => {
  const original = process.env.CLAUDE_CODE_FRAME_EVIDENCE_PATH
  const setupError = Error('setup')
  const disposeError = Error('dispose')
  try {
    const result = withFrameEvidence('multiple-failure-owner', async defer => {
      defer(() => {
        throw disposeError
      })
      throw setupError
    })
    const error = await result.then(
      () => undefined,
      error => error,
    )
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors).toEqual([setupError, disposeError])
    expect(process.env.CLAUDE_CODE_FRAME_EVIDENCE_PATH).toBe(original)
  } finally {
    if (original === undefined)
      delete process.env.CLAUDE_CODE_FRAME_EVIDENCE_PATH
    else process.env.CLAUDE_CODE_FRAME_EVIDENCE_PATH = original
  }
})
