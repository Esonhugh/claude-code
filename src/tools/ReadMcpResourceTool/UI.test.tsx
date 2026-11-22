import { expect, test } from 'bun:test'
import React from 'react'
import { AppStateProvider, getDefaultAppState } from '../../state/AppState.js'
import { renderToString } from '../../utils/staticRender.js'
import { renderToolResultMessage } from './UI.js'

async function draw(output: object): Promise<string> {
  return (await renderToString(
    <AppStateProvider initialState={getDefaultAppState()}>
      {renderToolResultMessage(output as never, [], { verbose: true })}
    </AppStateProvider>,
    120,
  )).trim()
}

// Official 2.1.329 shows the hint; an empty result still reads "(No content)".
test('a missing resource shows its hint instead of "(No content)"', async () => {
  const error = 'Resource not found: fx://doc/nope — Re-run ListMcpResourcesTool to refresh.'
  expect(await draw({ contents: [], error })).toContain('Resource not found: fx://doc/nope')
  expect(await draw({ contents: [] })).toContain('(No content)')
})
