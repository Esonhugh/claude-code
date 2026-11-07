import { expect, test } from 'bun:test'
import React from 'react'
import { createUserMessage } from '../utils/messages.js'
import { renderToString } from '../utils/staticRender.js'
import { UserMessageOption } from './MessageSelector.js'

test('the rewind list shows the typed text of a message with a pasted image', async () => {
  const message = createUserMessage({
    content: [
      { type: 'text', text: '[Image #1] what is this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ],
  })
  const row = await renderToString(<UserMessageOption userMessage={message} isCurrent={false} />, 80)
  expect(row).toContain('[Image #1] what is this')
  expect(row).not.toContain('(no prompt)')
})
