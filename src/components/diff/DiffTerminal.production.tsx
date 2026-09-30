import React from 'react'
import { Readable } from 'node:stream'
import { Box, Text, createRoot } from '../../ink.js'
import type { Frame } from '../../ink/frame.js'
import instances from '../../ink/instances.js'
import { enableConfigs } from '../../utils/config.js'
import {
  createFrameRecorder,
  DiffTerminalOutput,
  firstScreenDifference,
  screenLines,
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

enableConfigs()

const output = new DiffTerminalOutput(40, 8)
const input = new Input()
const inkRef: {
  current?: { frontFrame: Frame; setAltScreenActive(active: boolean): void }
} = {}
const recorder = createFrameRecorder(output, () => inkRef.current!.frontFrame)
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

function Screen({ marker }: { marker: string }): React.ReactNode {
  return (
    <Box width={40} height={8} flexDirection="column">
      <Text>production scheduler</Text>
      <Text>{marker}</Text>
    </Box>
  )
}

try {
  root.render(<Screen marker="first" />)
  const firstDeadline = Date.now() + 2000
  while (
    !screenLines(recorder.frames.at(-1)?.screen ?? {
      columns: 0,
      rows: 0,
      cells: [],
      cursor: { x: 0, y: 0 },
    }).join('\n').includes('first') &&
    Date.now() < firstDeadline
  ) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  await output.flush()
  const firstFrame = recorder.frames.at(-1)
  if (!firstFrame) throw new Error('production scheduler omitted leading frame')

  root.render(<Screen marker="second" />)
  const secondDeadline = Date.now() + 2000
  while (
    (!screenLines(recorder.frames.at(-1)?.screen ?? {
      columns: 0,
      rows: 0,
      cells: [],
      cursor: { x: 0, y: 0 },
    }).join('\n').includes('second') ||
      (recorder.frames.at(-1)?.writeId ?? 0) <= firstFrame.writeId) &&
    Date.now() < secondDeadline
  ) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  await output.flush()
  const frame = recorder.frames.at(-1)
  if (!frame) throw new Error('production scheduler emitted no frame')
  const lines = screenLines(frame.screen).join('\n')
  if (!lines.includes('second')) {
    throw new Error(`production scheduler did not render trailing commit:\n${lines}`)
  }
  if (!frame.event.phases || !Number.isFinite(frame.event.durationMs)) {
    throw new Error('production scheduler frame lacks timing instrumentation')
  }
  const physical = output.screenAfter(frame.writeId)
  if (!physical) throw new Error(`write ${frame.writeId} was not parsed`)
  const difference = firstScreenDifference(frame.screen, physical)
  if (difference) {
    throw new Error(`production frame differs: ${difference}`)
  }
  process.stdout.write(
    `RESULT ${JSON.stringify({ frames: recorder.frames.length, writes: output.writes.length, scheduler: 'production' })}\n`,
  )
} finally {
  root.unmount()
  await new Promise<void>(resolve => setImmediate(resolve))
}
