import { expect, test } from 'bun:test'
import React from 'react'
import { TerminalSizeContext } from '../../ink/components/TerminalSizeContext.js'
import { renderToString } from '../../utils/staticRender.js'
import { General } from './General.js'

async function render(rows: number): Promise<string> {
  return renderToString(
    <TerminalSizeContext.Provider value={{ columns: 120, rows }}>
      <General />
    </TerminalSizeContext.Provider>,
    120,
  )
}

test('/help general tab shows the /powerup hint only on tall terminals, like 2.1.311', async () => {
  expect(await render(50)).toContain('New here? Run /powerup to learn the features most people miss.')
  expect(await render(30)).not.toContain('/powerup')
})
