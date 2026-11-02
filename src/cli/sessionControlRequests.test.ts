import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AppState } from '../state/AppState.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import type { Message } from '../types/message.js'
import { getCwd } from '../utils/cwd.js'
import { createAssistantMessage, createUserMessage } from '../utils/messages.js'
import { setCwd } from '../utils/Shell.js'
import { handleRewindConversation, handleSetCwd } from './sessionControlRequests.js'

function store() {
  let state: AppState = getDefaultAppState()
  return {
    getAppState: () => state,
    setAppState: (update: (prev: AppState) => AppState) => {
      state = update(state)
    },
  }
}

const startCwd = getCwd()
const dirs: string[] = []
afterEach(() => {
  setCwd(startCwd)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('set_cwd asks for trust, then moves on an echoed attestation', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-set-cwd-')))
  dirs.push(root)
  mkdirSync(join(root, 'sub'))
  writeFileSync(join(root, 'file'), 'x')
  const s = store()
  const host = { busy: false, ...s }

  expect(handleSetCwd({ path: join(root, 'sub') }, host)).toEqual({ status: 'needs_trust', directory: join(root, 'sub') })
  expect(getCwd()).toBe(startCwd)
  expect(handleSetCwd({ path: join(root, 'sub'), trust_accepted: true, trusted_directory: join(root, 'other') }, host))
    .toEqual({ status: 'needs_trust', directory: join(root, 'sub') })
  expect(handleSetCwd({ path: join(root, 'sub'), trust_accepted: true, trusted_directory: join(root, 'sub') }, host))
    .toEqual({ status: 'ok', cwd: join(root, 'sub'), changed: true, transcript_relocated: false })
  expect(getCwd()).toBe(join(root, 'sub'))
  expect((s.getAppState().toolPermissionContext.additionalWorkingDirectories as unknown as Map<string, unknown>).has(join(root, 'sub'))).toBe(true)
  expect(handleSetCwd({ path: '.' }, host)).toEqual({ status: 'ok', cwd: join(root, 'sub'), changed: false, transcript_relocated: true })

  expect(handleSetCwd({ path: join(root, 'nope') }, host)).toMatchObject({ status: 'rejected', reason: 'not_found' })
  expect(handleSetCwd({ path: join(root, 'file') }, host)).toMatchObject({ status: 'rejected', reason: 'not_a_directory' })
  expect(handleSetCwd({ path: root }, { ...host, busy: true })).toMatchObject({ status: 'rejected', reason: 'busy' })
  expect(handleSetCwd({ path: 1 }, host)).toEqual({ error: 'set_cwd: path must be a non-empty string' })
  expect(handleSetCwd({ path: root, trust_accepted: true }, host)).toEqual({ error: 'set_cwd: invalid request — trust_accepted requires trusted_directory (echo the directory from the needs_trust response)' })
})

test('set_cwd refuses a path a trust dialog could not show faithfully', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-set-cwd-')))
  dirs.push(root)
  mkdirSync(join(root, 'a​b'))
  expect(handleSetCwd({ path: join(root, 'a​b') }, { busy: false, ...store() }))
    .toMatchObject({ status: 'rejected', reason: 'unsafe_path' })
})

test('rewind_conversation drops the target turn and hands back its text', () => {
  const first = createUserMessage({ content: 'first question' })
  const answer = createAssistantMessage({ content: 'first answer' })
  const second = createUserMessage({ content: 'second question' })
  const messages: Message[] = [first, answer, second, createAssistantMessage({ content: 'second answer' })]
  const s = store()
  const host = { messages, busy: false, queued: false, setAppState: s.setAppState }

  expect(handleRewindConversation({ target_message_uuid: second.uuid }, host)).toMatchObject({ reason: 'stale_target' })
  expect(handleRewindConversation({ target_message_uuid: second.uuid, last_seen_user_message_uuid: first.uuid }, host))
    .toMatchObject({ reason: 'unseen_later_turn' })
  expect(messages).toHaveLength(4)
  expect(handleRewindConversation({ target_message_uuid: second.uuid, last_seen_user_message_uuid: second.uuid }, host)).toEqual({
    rewound: true,
    targetMessageUuid: second.uuid,
    prefillText: 'second question',
    precedingAssistantUuid: answer.uuid,
  })
  expect(messages).toEqual([first, answer])

  const refused = { rewound: false, prefillText: null, precedingAssistantUuid: null } as const
  expect(handleRewindConversation({ target_message_uuid: second.uuid, last_seen_user_message_uuid: first.uuid }, host)).toEqual({ ...refused, error: 'target not found', reason: 'target_not_found' })
  expect(handleRewindConversation({ target_message_uuid: answer.uuid, last_seen_user_message_uuid: first.uuid }, host)).toMatchObject({ reason: 'target_not_found' })
  expect(handleRewindConversation({ target_message_uuid: first.uuid }, { ...host, busy: true })).toEqual({ ...refused, error: 'turn running', reason: 'turn_running' })
  expect(handleRewindConversation({ target_message_uuid: first.uuid }, { ...host, queued: true })).toMatchObject({ reason: 'commands_queued' })
  expect(handleRewindConversation({}, host)).toEqual({ error: 'rewind_conversation: target_message_uuid must be a string' })
  expect(messages).toHaveLength(2)

  expect(handleRewindConversation({ target_message_uuid: first.uuid, last_seen_user_message_uuid: first.uuid }, host)).toMatchObject({ rewound: true, prefillText: 'first question', precedingAssistantUuid: null })
  expect(messages).toEqual([])
})
