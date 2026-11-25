import { expect, test } from 'bun:test'
import * as React from 'react'
import { formatPeerMessage } from '../../utils/peerProtocol.js'
import { renderToString } from '../../utils/staticRender.js'
import { peerMessageSummary, UserCrossSessionMessage } from './UserCrossSessionMessage.js'

const draw = (text: string, expanded = false) =>
  renderToString(<UserCrossSessionMessage addMargin={false} param={{ type: 'text', text }} isTranscriptMode={expanded} />)

test('collapsed row names the sender by its socket when it sent no name', async () => {
  const output = await draw(formatPeerMessage('\n\n  first\tline  \nsecond', { from: 'uds:/tmp/cc-socks/4242.sock' }))
  expect(output).toContain('› Message from @4242: first line (ctrl+o to expand)')
  expect(output).not.toContain('second')
})

test('sender names cap at 20 characters and summaries at 120 columns', async () => {
  const output = await draw(formatPeerMessage('x', { fromName: 'a very long session name here', from: 'uds:/tmp/p.sock' }))
  expect(output).toContain('Message from @a-very-long-session-…: x')
  expect(peerMessageSummary('y'.repeat(200))).toBe(`${'y'.repeat(119)}…`)
  expect(peerMessageSummary('\u001b[31mred\u0007')).toBe('[31mred')
})

test('expanded view shows the whole body under the sender', async () => {
  const output = await draw(formatPeerMessage('one\ntwo', { fromName: 'beta', from: 'uds:/tmp/p.sock' }), true)
  expect(output).toContain('@ beta❯')
  expect(output).toContain('one\n  two')
})
