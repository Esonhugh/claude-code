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

// Teammate messages the lead reads between tool calls arrive as an attachment;
// replay consumers must see them like the ones delivered between turns, or the
// web team panel never learns that a teammate reported or went idle.
test('replays teammate messages read mid-turn', async () => {
  const { teammateMailboxReplays } = await import('./QueryEngine.js')
  const { createAttachmentMessage } = await import('./utils/attachments.js')
  const mailbox = createAttachmentMessage({
    type: 'teammate_mailbox',
    messages: [{ from: 'alice', text: '{"type":"idle_notification","from":"alice"}', timestamp: '2026-11-12T00:00:00.000Z', color: 'blue' }],
  })
  const other = createAttachmentMessage({ type: 'max_turns_reached', maxTurns: 1, turnCount: 2 })
  expect(teammateMailboxReplays(other)).toEqual([])
  expect(teammateMailboxReplays(mailbox)).toEqual([
    expect.objectContaining({
      type: 'user',
      uuid: mailbox.uuid,
      isReplay: true,
      message: { role: 'user', content: '<teammate-message teammate_id="alice" color="blue">\n{"type":"idle_notification","from":"alice"}\n</teammate-message>' },
    }),
  ])
})
