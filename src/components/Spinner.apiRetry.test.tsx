import { expect, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import { APIError } from '@anthropic-ai/sdk'
import { render } from '../ink.js'
import { createSystemAPIErrorMessage } from '../utils/messages.js'
import { ApiRetryRow } from './Spinner.js'

async function renderRow(element: React.ReactElement) {
  const stdout = Object.assign(new PassThrough(), { columns: 110, rows: 40, isTTY: false })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdout.resume()
  const instance = await render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  try {
    await new Promise(resolve => setTimeout(resolve, 30))
    return stripAnsi(output)
  } finally {
    instance.unmount()
    instance.cleanup()
  }
}

const overloaded = new APIError(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, undefined, new Headers())

test('first retries show a generic API error with countdown and attempt', async () => {
  const output = await renderRow(<ApiRetryRow retry={createSystemAPIErrorMessage(overloaded, 4000, 1, 10)} columns={110} />)
  expect(output).toContain('API error · Retrying in 4s · attempt 1/10')
})

test('from the third retry the formatted error replaces the generic label', async () => {
  const output = await renderRow(<ApiRetryRow retry={createSystemAPIErrorMessage(overloaded, 1000, 3, 10)} columns={110} />)
  expect(output).not.toContain('API error ·')
  expect(output).toContain('529 Overloaded · Retrying in 1s · attempt 3/10')
})
