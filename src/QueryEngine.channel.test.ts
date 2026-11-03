import { expect, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
const { channelReplays } = await import('./QueryEngine.js')
const { createUserMessage } = await import('./utils/messages.js')

// A channel message is meta to the model; a client that asked for replays
// (claude web) still has to show it, as the TUI does.
test('replays channel messages and nothing else that is meta', () => {
  const channel = createUserMessage({
    content: '<channel source="plugin:fakechat:fakechat" user="alice">\nhi\n</channel>',
    isMeta: true,
    origin: { kind: 'channel', server: 'plugin:fakechat:fakechat' },
  })
  const caveat = createUserMessage({ content: 'caveat', isMeta: true })
  const typed = createUserMessage({ content: 'typed' })
  expect(channelReplays([caveat, channel, typed])).toEqual([
    expect.objectContaining({ type: 'user', uuid: channel.uuid, isReplay: true, message: channel.message }),
  ])
})
