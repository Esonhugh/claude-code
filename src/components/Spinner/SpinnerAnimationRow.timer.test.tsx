import { expect, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'node:stream'
import { render } from '../../ink.js'
import stripAnsi from 'strip-ansi'
import { SpinnerAnimationRow } from './SpinnerAnimationRow.js'

test('elapsed time and tokens show from the first seconds of a turn, like official', async () => {
  const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 10, isTTY: false })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdout.resume()
  const instance = await render(
    <SpinnerAnimationRow
      mode="responding"
      reducedMotion={true}
      hasActiveTools={false}
      responseLengthRef={{ current: 88 }}
      message="Working…"
      messageColor="claude"
      shimmerColor="claudeShimmer"
      loadingStartTimeRef={{ current: Date.now() - 3_000 }}
      totalPausedMsRef={{ current: 0 }}
      pauseStartTimeRef={{ current: null }}
      verbose={false}
      columns={120}
      hasRunningTeammates={false}
      teammateTokens={0}
      foregroundedTeammate={undefined}
      thinkingStatus={null}
      effortSuffix=""
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: new PassThrough() as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  try {
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(stripAnsi(output)).toContain('(3s · ↓ 22 tokens)')
  } finally {
    instance.unmount()
    instance.cleanup()
  }
})
