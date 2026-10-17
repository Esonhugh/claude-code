import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAssistantMessage,
  createUserMessage,
} from '../../utils/messages.js'
import {
  loadTranscriptFile,
  MAX_TRANSCRIPT_READ_BYTES,
} from '../../utils/sessionStorage.js'
import { readModAgentTranscript } from './sessionTranscript.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mods-owned-transcript-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const sessionId = 'owned-session'
const agentId = 'owned-agent'
const question = () => createUserMessage({ content: 'owned question' })
const answer = () =>
  createAssistantMessage({
    content: [{ type: 'text', text: 'owned answer', citations: [] }],
  })
async function saved(overrides: Record<string, unknown> = {}) {
  const user = question(),
    assistant = answer()
  const records = [
    {
      ...user,
      parentUuid: null,
      isSidechain: true,
      agentId,
      sessionId,
      ...overrides,
    },
    {
      ...assistant,
      parentUuid: user.uuid,
      isSidechain: true,
      agentId,
      sessionId,
      ...overrides,
    },
  ]
  const directory = join(root, sessionId, 'subagents')
  await mkdir(directory, { recursive: true })
  const path = join(directory, `agent-${agentId}.jsonl`)
  const buffer = Buffer.from(
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
  )
  await writeFile(path, buffer)
  return { path, buffer, user, assistant }
}
const read = (id = agentId, session = sessionId) =>
  readModAgentTranscript({
    projectDirectory: root,
    sessionId: session,
    agentId: id,
  })

test('reads the saved chain only when every conversation record proves the agent and session', async () => {
  const { user, assistant } = await saved()
  const messages = await read()
  expect(messages?.map((message) => message.type)).toEqual([
    'user',
    'assistant',
  ])
  expect(messages?.map((message) => message.uuid)).toEqual([
    user.uuid,
    assistant.uuid,
  ])
  expect(messages?.[0]).not.toHaveProperty('parentUuid')
  expect(messages?.[0]).not.toHaveProperty('isSidechain')
})

test.each([
  { sessionId: 'foreign' },
  { agentId: 'foreign' },
  { isSidechain: false },
])('denies wrong saved ownership %j', async (overrides) => {
  await saved(overrides)
  expect(await read()).toBeUndefined()
})

test('denies a mixed-session chain rather than returning its owned prefix', async () => {
  const { path, buffer } = await saved()
  const foreign = {
    ...answer(),
    parentUuid: null,
    isSidechain: true,
    sessionId: 'foreign',
    agentId,
  }
  await writeFile(
    path,
    Buffer.concat([buffer, Buffer.from(JSON.stringify(foreign) + '\n')]),
  )
  expect(await read()).toBeUndefined()
})

test.each(['../outside', 'workflow/worker', '..', '.', 'a\\b', ''])(
  'denies path-like agent id %s',
  async (id) => {
    await saved()
    expect(await read(id)).toBeUndefined()
  },
)

test('denies linked transcript files and linked subagent directories', async () => {
  const { path } = await saved()
  const external = join(root, 'external.jsonl')
  await writeFile(external, 'PRIVATE_EXTERNAL')
  await rm(path)
  await symlink(external, path)
  expect(await read()).toBeUndefined()
  const directory = join(root, sessionId, 'subagents')
  await rm(directory, { recursive: true })
  await mkdir(join(root, 'other'))
  await symlink(join(root, 'other'), directory)
  expect(await read()).toBeUndefined()
})

test('does not read Workflow run subdirectories or other-session files', async () => {
  const { path, buffer } = await saved()
  await rm(path)
  const workflow = join(root, sessionId, 'subagents', 'workflows', 'run')
  await mkdir(workflow, { recursive: true })
  await writeFile(join(workflow, `agent-${agentId}.jsonl`), buffer)
  expect(await read()).toBeUndefined()
  expect(await read(agentId, 'other-session')).toBeUndefined()
})

test('bounds the owned file read before allocating a large transcript', async () => {
  const { path } = await saved()
  await truncate(path, MAX_TRANSCRIPT_READ_BYTES + 1)
  expect(await read()).toBeUndefined()
})

test('parses a pinned descriptor snapshot without reopening the original file path', async () => {
  const { buffer } = await saved()
  const parsed = await loadTranscriptFile(join(root, 'does-not-exist'), {
    buffer,
  })
  expect(parsed.messages.size).toBe(2)
})
