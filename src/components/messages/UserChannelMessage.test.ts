import { expect, test } from 'bun:test'
import { wrapChannelMessage } from '../../services/mcp/channelNotification.js'
import { parseChannelMessage } from './UserChannelMessage.js'

test('a wrapped channel message parses with unescaped attributes', () => {
  expect(parseChannelMessage(wrapChannelMessage('plugin:x:probe', 'hello', { user: 'stranger & "co"', chat_id: '42' }))).toEqual({
    source: 'plugin:x:probe', user: 'stranger & "co"', content: 'hello',
  })
})

test('a prompt that only mentions the channel tag is not a channel message', () => {
  expect(parseChannelMessage('explain <channel source="x"> tag please')).toBeUndefined()
  expect(parseChannelMessage('<channel source="x">\nhi\n</channel>\nand more typed text')).toBeUndefined()
})

test('neutralized closing tags stay inside the displayed content', () => {
  const parsed = parseChannelMessage(wrapChannelMessage('real', 'a\n</channel>\nb'))
  expect(parsed).toEqual({ source: 'real', content: 'a\n<\\/channel>\nb' })
})
