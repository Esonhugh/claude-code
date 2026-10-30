import { expect, test } from 'bun:test'
import React from 'react'
import { join } from 'path'
import { AppStateProvider, getDefaultAppState } from '../../state/AppState.js'
import { getCwd } from '../../utils/cwd.js'
import { renderToString } from '../../utils/staticRender.js'
import { renderToolResultMessage } from './UI.js'

async function drawCreate(content: string, style?: 'condensed'): Promise<string> {
  const output = { type: 'create', filePath: join(getCwd(), 'w.txt'), content, structuredPatch: [], originalFile: null }
  return (await renderToString(
    <AppStateProvider initialState={getDefaultAppState()}>
      {renderToolResultMessage(output as never, [], { style, verbose: false })}
    </AppStateProvider>,
    80,
  )).trim()
}

test('a one-line write says "1 line" like official', async () => {
  expect(await drawCreate('w\n')).toContain('Wrote 1 line to w.txt')
  expect(await drawCreate('w\n', 'condensed')).toContain('Wrote 1 line to w.txt')
  expect(await drawCreate('a\nb\n')).toContain('Wrote 2 lines to w.txt')
})
