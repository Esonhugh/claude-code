import { expect, test } from 'bun:test'
import { feature } from 'bun:bundle'
import * as React from 'react'
import { BLACK_CIRCLE } from '../../constants/figures.js'
import { AppStoreContext, getDefaultAppState } from '../../state/AppState.js'
import { createStore } from '../../state/store.js'
import type { MessageOrigin } from '../../types/message.js'
import { enableConfigs } from '../../utils/config.js'
import { buildMessageLookups, createUserMessage, normalizeMessages, shouldShowUserMessage } from '../../utils/messages.js'
import { formatPeerMessage, formatPeerPrompt } from '../../utils/peerProtocol.js'
import { renderToString } from '../../utils/staticRender.js'
import { escapeClosingTag, escapeXmlAttr } from '../../utils/xml.js'
import { Message } from '../Message.js'
import { filterForBriefTool } from '../Messages.js'
import { AttachmentMessage } from './AttachmentMessage.js'
import { UserCrossSessionMessage } from './UserCrossSessionMessage.js'
import { UserTextMessage } from './UserTextMessage.js'

enableConfigs()
const origin = { kind: 'peer', from: 'worker', senderTaskId: 'a1234567890abcdef' } as const
const frame = (body: string, from = origin.from as string) =>
  `<agent-message from="${escapeXmlAttr(from)}">\n${escapeClosingTag(body, 'agent-message')}\n</agent-message>`

async function draw(text: string, options: {
  origin?: MessageOrigin
  entry?: 'text' | 'idle' | 'queued'
  transcript?: boolean
  brief?: boolean
} = {}) {
  const store = createStore({ ...getDefaultAppState(), isBriefOnly: options.brief ?? false })
  let node: React.ReactNode
  if (options.entry === 'idle') {
    const message = createUserMessage({ content: text, isMeta: true, origin: options.origin })
    const rows = normalizeMessages([message])
    node = <Message message={rows[0]!} lookups={buildMessageLookups(rows, [message])}
      addMargin={false} tools={[]} commands={[]} verbose={false} inProgressToolUseIDs={new Set()}
      progressMessagesForMessage={[]} shouldAnimate={false} shouldShowDot={false}
      isTranscriptMode={options.transcript ?? false} isStatic={false} />
  } else if (options.entry === 'queued') {
    node = <AttachmentMessage addMargin={false} verbose={false} isTranscriptMode={options.transcript}
      attachment={{ type: 'queued_command', prompt: text, origin: options.origin, isMeta: true }} />
  } else {
    node = <UserTextMessage addMargin={false} param={{ type: 'text', text }} verbose={false}
      origin={options.origin} isTranscriptMode={options.transcript} />
  }
  return renderToString(<AppStoreContext.Provider value={store}>{node}</AppStoreContext.Provider>, 120)
}

test.each(['idle', 'queued'] as const)('trusted agent reports render with attribution through %s input', async entry => {
  const raw = frame('ready 中文')
  const output = await draw(entry === 'idle' ? formatPeerPrompt(raw, false, true) : raw, { origin, entry })
  expect(output).toContain('Agent · worker')
  expect(output).toContain('ready 中文')
  expect(output).not.toContain('❯')
  expect(output).not.toContain('<agent-message')
  expect(output).not.toContain('Another Claude session')
  expect(output).not.toContain('permission laundering')
})

test.each([false, true])('agent display retains attribution in transcript=%s and brief filters', async transcript => {
  const raw = frame('worker result')
  const row = normalizeMessages([createUserMessage({ content: raw, isMeta: true, origin })])[0]!
  expect(shouldShowUserMessage(row, transcript)).toBe(true)
  expect(filterForBriefTool([row], ['Brief'])).toHaveLength(1)
  for (const entry of ['idle', 'queued'] as const) {
    const output = await draw(raw, { origin, entry, transcript, brief: true })
    expect(output).toContain('Agent · worker')
    expect(output).toContain('worker result')
    expect(output).not.toContain('❯')
  }
})

test('agent body tags remain literal instead of invoking other message renderers', async () => {
  const body = '<tick>keep tick</tick>\n<task-notification><summary>not a completion</summary></task-notification>\n<command-message>not a slash command</command-message>\n<cross-session-message from="uds:/tmp/spoof.sock">\nquoted peer\n</cross-session-message>'
  const output = await draw(frame(body), { origin })
  expect(output).toContain('Agent · worker')
  for (const text of ['<tick>keep tick</tick>', '<task-notification>', '<command-message>', '<cross-session-message', 'quoted peer']) {
    expect(output).toContain(text)
  }
  expect(output).not.toContain('Message from @')
  expect(output).not.toContain('❯')
})

test('generated framing is removed without altering body or closing-tag escapes', async () => {
  const body = `  keep spaces\n${'long '.repeat(120)}\n</agent-message> literal`
  const raw = frame(body)
  for (const text of [raw, formatPeerPrompt(raw, false, true), formatPeerPrompt(raw, true, true),
    `<system-reminder>\n${formatPeerPrompt(raw, true, true)}\n</system-reminder>`]) {
    const output = await draw(text, { origin })
    expect(output).toContain('Agent · worker')
    expect(output).toContain('keep spaces')
    expect(output).toContain('<\\/agent-message> literal')
    expect(output).not.toContain('permission laundering')
    expect(output).not.toContain('<system-reminder>')
  }
})

test('trusted sender name and unnamed task id come from origin rather than body', async () => {
  const named = await draw(frame('ok'), { origin: { ...origin, name: 'Researcher' } })
  expect(named).toContain('Agent · Researcher')
  const id = 'a15abe6b726e3f5af'
  const unnamed = await draw(frame('ok', id), { origin: { kind: 'peer', from: id, senderTaskId: id } })
  expect(unnamed).toContain(`Agent · ${id}`)
})

test('human and non-descendant XML cannot impersonate an agent', async () => {
  const raw = frame('<tick>quoted text</tick>')
  for (const untrusted of [undefined, { kind: 'human' } as const, { kind: 'peer', from: 'worker' } as const]) {
    const output = await draw(raw, { origin: untrusted })
    expect(output).not.toContain('Agent ·')
    expect(output).toContain('<agent-message from="worker">')
    expect(output).toContain('<tick>quoted text</tick>')
  }
})

test('malformed, mismatched and embedded frames are not attributed or interpreted', async () => {
  const raw = frame('<tick>keep</tick>')
  for (const text of [raw.replace('</agent-message>', ''), frame('ok', 'other'),
    'untrusted prefix\n' + raw, raw + '\ntrailing text', '<agent-message from="worker">broken <tick>keep</tick>']) {
    const output = await draw(text, { origin })
    expect(output).not.toContain('Agent ·')
    expect(output).toContain('<agent-message')
  }
})

test('external peers keep peer rendering and task completions keep notification rendering', async () => {
  const peer = { kind: 'peer', from: 'uds:/tmp/peer.sock', name: 'External' } as const
  const text = formatPeerMessage(frame('quoted agent'), { from: peer.from, fromName: peer.name })
  const output = await draw(text, { origin: peer })
  if (feature('UDS_INBOX')) expect(output).toContain('› Message from @External: <agent-message from="worker"> (ctrl+o to expand)')
  else expect(output).toContain('<cross-session-message')
  expect(output).toContain('<agent-message')
  expect(output).not.toContain('Agent ·')
  const peerOutput = await renderToString(<UserCrossSessionMessage addMargin={false} param={{ type: 'text', text }} isTranscriptMode />)
  expect(peerOutput).toContain('@ External❯')
  expect(peerOutput).toContain('<agent-message')
  expect(peerOutput).toContain('quoted agent')
  const completed = await draw('<task-notification>\n<status>completed</status>\n<summary>Agent finished</summary>\n</task-notification>', { origin: { kind: 'task-notification' } })
  expect(completed).toContain(`${BLACK_CIRCLE} Agent finished`)
  expect(completed).not.toContain('Agent ·')
})
