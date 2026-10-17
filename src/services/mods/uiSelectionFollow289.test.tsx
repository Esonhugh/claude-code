import { expect, test } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import React, { createRef } from 'react'
import { Writable } from 'node:stream'
import { Box, Text, render } from '../../ink.js'
import instances from '../../ink/instances.js'
import ScrollBox, {
  type ScrollBoxHandle,
} from '../../ink/components/ScrollBox.js'
import { updateSelection, finishSelection } from '../../ink/selection.js'
import {
  VirtualMessageList,
  type JumpHandle,
} from '../../components/VirtualMessageList.js'
import type { RenderableMessage } from '../../types/message.js'
import { createModUiSelectionTracker } from './uiSelection.js'
import { createModsRuntime } from './runtime.js'
class Output extends Writable {
  columns = 40
  rows = 8
  isTTY = false
  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    callback()
  }
}
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 65))
}
test('actual Worker reads hidden mounted tool row selection and keeps requestId through roundtrip and run take-down', async () => {
  const priorSsh = process.env.SSH_CONNECTION
  process.env.SSH_CONNECTION = 'private-fixture'
  const root = await mkdtemp(join(tmpdir(), 'mods-selection-follow-')),
    entry = join(root, 'register.ts')
  await writeFile(
    entry,
    "export function register(on){on('tool.call',async $=>({result:await $.ui.selection()}))}",
  )
  const scroll = createRef<ScrollBoxHandle>(),
    pane = createRef<ScrollBoxHandle>(),
    jump = createRef<JumpHandle>()
  const messages = [
    {
      type: 'assistant',
      uuid: 'assistant-follow',
      message: {
        content: [
          { type: 'tool_use', id: 'tool-follow-real', name: 'Read', input: {} },
        ],
      },
    },
  ] as unknown as RenderableMessage[]
  const node = (
    <Box width={40} height={4}>
      <ScrollBox ref={scroll} width={20} height={4} flexDirection="column">
        <VirtualMessageList
          messages={messages}
          scrollRef={scroll}
          columns={20}
          jumpRef={jump}
          itemKey={(m) => m.uuid}
          renderItem={() => (
            <Text>
              {Array.from(
                { length: 12 },
                (_, i) => 'tool-' + i.toString().padStart(2, '0'),
              ).join('\n')}
            </Text>
          )}
        />
      </ScrollBox>
      <ScrollBox ref={pane} width={20} height={4}>
        <Text>adjacent pane</Text>
      </ScrollBox>
    </Box>
  )
  const stdout = new Output() as unknown as NodeJS.WriteStream,
    rendered = await render(node, {
      stdout,
      patchConsole: false,
      exitOnCtrlC: false,
    }),
    ink = instances.get(stdout)!
  ink.setAltScreenActive(true)
  rendered.rerender(node)
  await settle()
  const tracker = createModUiSelectionTracker(
      () => ink,
      (s) => jump.current?.rowHoldingSelection?.(s),
    ),
    disconnect = tracker.connect()
  const runtime = createModsRuntime({
    services: { uiSelection: () => tracker.read() },
  })
  const query = () =>
    runtime.dispatch('tool.call', {}, async () => ({ result: 'core' }))
  try {
    await runtime.bind({
      cwd: root,
      surface: 'terminal',
      isInteractive: true,
      sessionId: 'selection-follow',
    })
    await runtime.reconcile([
      {
        name: 'selection-reader',
        storageId: 'selection-reader@test',
        pluginRoot: root,
        entrypoints: [entry],
      },
    ])
    ink.startTextSelection(0, 1)
    updateSelection(ink.selection, 6, 1)
    finishSelection(ink.selection)
    const wanted = {
      result: { text: 'tool-01', requestId: 'tool-follow-real' },
    }
    expect(await query()).toEqual(wanted)
    scroll.current!.scrollTo(4)
    await settle()
    expect(ink.hasTextSelection()).toBe(true)
    expect(ink.selection.virtualAnchorRow).toBe(-3)
    expect(await query()).toEqual(wanted)
    scroll.current!.scrollTo(0)
    await settle()
    expect(ink.selection.anchor).toEqual({ col: 0, row: 1 })
    expect(await query()).toEqual(wanted)
    scroll.current!.scrollTo(4)
    await settle()
    ink.clearTextSelection()
    expect(ink.hasTextSelection()).toBe(false)
    expect(await query()).toEqual(wanted)
    const consuming = tracker.beginRun()
    expect(await query()).toEqual(wanted)
    tracker.endRun(consuming)
    expect(await query()).toEqual({ result: undefined })
    scroll.current!.scrollTo(0)
    await settle()
    ink.startTextSelection(0, 1)
    updateSelection(ink.selection, 6, 1)
    finishSelection(ink.selection)
    scroll.current!.scrollTo(4)
    await settle()
    expect(ink.copySelection()).toBe('tool-01')
    expect(ink.hasTextSelection()).toBe(false)
    expect(await query()).toEqual(wanted)
    const copied = tracker.beginRun()
    tracker.endRun(copied)
    expect(await query()).toEqual({ result: undefined })
    ink.startTextSelection(20, 0)
    updateSelection(ink.selection, 27, 0)
    finishSelection(ink.selection)
    expect(await query()).toEqual({ result: { text: 'adjacent' } })
  } finally {
    await runtime.dispose()
    disconnect()
    rendered.unmount()
    await rm(root, { recursive: true, force: true })
    if (priorSsh === undefined) delete process.env.SSH_CONNECTION
    else process.env.SSH_CONNECTION = priorSsh
  }
})
