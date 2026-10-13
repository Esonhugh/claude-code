import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '../../types/message.js'
import {
  createAssistantMessage,
  createUserMessage,
} from '../../utils/messages.js'
import { createModsRuntime, type ModHostServices } from './runtime.js'
import { projectModSessionMessages } from './sessionMessages.js'

let root: string
const runtimes: ReturnType<typeof createModsRuntime>[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mods-session-options-'))
})
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  await rm(root, { recursive: true, force: true })
})
async function reader(
  main: () => Message[],
  expression: string,
  extra: object = {},
) {
  const services: ModHostServices & { rawMessages(): readonly Message[] } = {
    messages: () => projectModSessionMessages(main()),
    rawMessages: main,
    ...extra,
  }
  const runtime = createModsRuntime({ services })
  runtimes.push(runtime)
  await runtime.bind({
    cwd: root,
    sessionId: 'owned-session',
    surface: 'terminal',
    isInteractive: true,
  })
  const pluginRoot = join(root, 'consumer')
  await mkdir(pluginRoot)
  const entry = join(pluginRoot, 'register.ts')
  await writeFile(
    entry,
    `export function register(on) {
    on('tool.call', async $ => ({result: await ${expression}}));
  }`,
  )
  await runtime.reconcile([
    {
      name: 'consumer',
      storageId: 'consumer@test',
      pluginRoot,
      entrypoints: [entry],
    },
  ])
  return runtime
}
const invoke = (runtime: ReturnType<typeof createModsRuntime>) =>
  runtime.dispatch('tool.call', {}, async () => ({
    result: 'unexpected core fallback',
  }))

test('main API messages preserve normalized media, thinking and paired tool blocks', async () => {
  const main = [
    createUserMessage({
      content: [
        { type: 'text', text: 'question' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
        },
      ],
    }),
    createAssistantMessage({
      content: [
        {
          type: 'thinking',
          thinking: 'analysis',
          signature: 'opaque signature',
        },
        { type: 'text', text: 'reply', citations: [] },
        {
          type: 'tool_use',
          id: 'owned-tool',
          name: 'Read',
          input: { file_path: '/fixture/a' },
        },
      ],
    }),
    createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'owned-tool',
          content: 'file text',
        },
      ],
    }),
  ]
  const before = structuredClone(main)
  const runtime = await reader(() => main, `$.session.messages({as:'api'})`)
  expect(await invoke(runtime)).toEqual({
    result: main.map((message) => ({
      role: message.type,
      content: message.message.content,
    })),
  })
  expect(main).toEqual(before)
})

test('API messages follow the live main binding on each call', async () => {
  let main = [createUserMessage({ content: 'first' })]
  const runtime = await reader(() => main, `$.session.messages({as:'api'})`)
  expect(await invoke(runtime)).toEqual({
    result: [{ role: 'user', content: [{ type: 'text', text: 'first' }] }],
  })
  main = [createUserMessage({ content: 'second' })]
  expect(await invoke(runtime)).toEqual({
    result: [{ role: 'user', content: [{ type: 'text', text: 'second' }] }],
  })
})

test.each(['foreign-agent', '../outside', 'workflow/worker'])(
  'unavailable named conversation denies %s without falling back to main',
  async (agentId) => {
    const runtime = await reader(
      () => [createUserMessage({ content: 'PRIVATE_MAIN_MARKER' })],
      `$.session.messages({agentId:${JSON.stringify(agentId)}})`,
    )
    const outcome = (await invoke(runtime)) as { result: unknown }
    expect(outcome.result).toMatchObject({
      deny: expect.stringContaining(agentId),
    })
    expect(JSON.stringify(outcome.result)).not.toContain('PRIVATE_MAIN_MARKER')
  },
)

test('named reads follow an owned live producer and retain its settled conversation', async () => {
  const runtime = await reader(
    () => [createUserMessage({ content: 'main' })],
    `$.session.messages({agentId:'owned-child'})`,
  )
  const child: Message[] = [createUserMessage({ content: 'child question' })]
  const finish = runtime.trackConversation({
    agentId: 'owned-child',
    sessionId: 'owned-session',
    messages: () => child,
    toolUseId: 'launch',
  })
  expect(await invoke(runtime)).toEqual({
    result: projectModSessionMessages(child),
  })
  child.push(
    createAssistantMessage({
      content: [{ type: 'text', text: 'child reply', citations: [] }],
    }),
  )
  expect(await invoke(runtime)).toEqual({
    result: projectModSessionMessages(child),
  })
  finish()
  child.length = 0
  expect(await invoke(runtime)).toEqual({
    result: [
      { role: 'user', text: 'child question', toolUses: [] },
      { role: 'assistant', text: 'child reply', toolUses: [] },
    ],
  })
})

test('named API reads preserve child blocks and never substitute the main transcript', async () => {
  const runtime = await reader(
    () => [createUserMessage({ content: 'PRIVATE_MAIN_MARKER' })],
    `$.session.messages({agentId:'owned-fork',as:'api'})`,
  )
  const child = [createUserMessage({ content: 'fork question' })]
  const finish = runtime.trackConversation({
    agentId: 'owned-fork',
    sessionId: 'owned-session',
    messages: () => child,
  })
  expect(await invoke(runtime)).toEqual({
    result: [
      { role: 'user', content: [{ type: 'text', text: 'fork question' }] },
    ],
  })
  finish()
})

test('stale and other-session producers cannot enter a rebound session', async () => {
  const runtime = await reader(
    () => [createUserMessage({ content: 'main' })],
    `$.session.messages({agentId:'owned-child'})`,
  )
  const finish = runtime.trackConversation({
    agentId: 'owned-child',
    sessionId: 'owned-session',
    messages: () => [createUserMessage({ content: 'old' })],
  })
  await runtime.bind({
    cwd: root,
    sessionId: 'new-session',
    surface: 'terminal',
    isInteractive: true,
  })
  runtime.trackConversation({
    agentId: 'owned-child',
    sessionId: 'owned-session',
    messages: () => [createUserMessage({ content: 'FOREIGN' })],
  })
  finish()
  expect(((await invoke(runtime)) as { result: unknown }).result).toMatchObject(
    { deny: expect.stringContaining('owned-child') },
  )
})

test('workflow-owned conversations remain outside the named session interface', async () => {
  const runtime = await reader(
    () => [createUserMessage({ content: 'main' })],
    `$.session.messages({agentId:'workflow-child'})`,
  )
  runtime.trackConversation({
    agentId: 'workflow-child',
    sessionId: 'owned-session',
    messages: () => [createUserMessage({ content: 'PRIVATE_WORKFLOW' })],
    workflow: true,
  })
  expect(((await invoke(runtime)) as { result: unknown }).result).toMatchObject(
    { deny: expect.stringContaining('workflow-child') },
  )
})

test('saved owned conversations are read with the pinned session identity', async () => {
  const calls: string[] = []
  const child = [createUserMessage({ content: 'saved child' })]
  const runtime = await reader(
    () => [createUserMessage({ content: 'PRIVATE_MAIN' })],
    `$.session.messages({agentId:'saved-child',as:'api'})`,
    {
      agentMessages: async (agentId: string, sessionId: string) => {
        calls.push(`${sessionId}:${agentId}`)
        return child
      },
    },
  )
  expect(await invoke(runtime)).toEqual({
    result: [
      { role: 'user', content: [{ type: 'text', text: 'saved child' }] },
    ],
  })
  expect(calls).toEqual(['owned-session:saved-child'])
})

test('a delayed saved read cannot leak after session identity changes', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const runtime = await reader(
    () => [createUserMessage({ content: 'main' })],
    `$.session.messages({agentId:'saved-child'})`,
    {
      agentMessages: async () => {
        entered.resolve()
        await release.promise
        return [createUserMessage({ content: 'OLD_SESSION_PRIVATE' })]
      },
    },
  )
  const pending = invoke(runtime)
  await entered.promise
  await runtime.bind({
    cwd: root,
    sessionId: 'new-session',
    surface: 'terminal',
    isInteractive: true,
  })
  release.resolve()
  expect(((await pending) as { result: unknown }).result).toMatchObject({
    deny: expect.stringContaining('saved-child'),
  })
})

test('a persistent teammate producer stays live across per-turn agent registrations', async () => {
  const runtime = await reader(
    () => [createUserMessage({ content: 'main' })],
    `$.session.messages({agentId:'teammate'})`,
  )
  const all: Message[] = [createUserMessage({ content: 'first prompt' })]
  const finish = runtime.trackConversation({
    agentId: 'teammate',
    sessionId: 'owned-session',
    messages: () => all,
    persistent: true,
  })
  const finishTurn = runtime.trackConversation({
    agentId: 'teammate',
    sessionId: 'owned-session',
    messages: () => [createUserMessage({ content: 'stale per-turn copy' })],
  })
  finishTurn()
  all.push(
    createAssistantMessage({ content: 'first answer' }),
    createUserMessage({ content: 'second prompt' }),
  )
  expect(await invoke(runtime)).toEqual({
    result: projectModSessionMessages(all),
  })
  finish()
})

test('a late finalizer cannot replace the current resumed agent conversation', async () => {
  const runtime = await reader(
    () => [createUserMessage({ content: 'main' })],
    `$.session.messages({agentId:'same-agent'})`,
  )
  const oldFinish = runtime.trackConversation({
    agentId: 'same-agent',
    sessionId: 'owned-session',
    messages: () => [createUserMessage({ content: 'OLD' })],
  })
  const finish = runtime.trackConversation({
    agentId: 'same-agent',
    sessionId: 'owned-session',
    messages: () => [createUserMessage({ content: 'CURRENT' })],
  })
  oldFinish()
  expect(await invoke(runtime)).toEqual({
    result: [{ role: 'user', text: 'CURRENT', toolUses: [] }],
  })
  finish()
})

test('nested children of a Workflow remain excluded even without their own transcript subdir', async () => {
  const runtime = await reader(
    () => [createUserMessage({ content: 'main' })],
    `$.session.messages({agentId:'nested-workflow'})`,
  )
  runtime.trackConversation({
    agentId: 'workflow-parent',
    sessionId: 'owned-session',
    messages: () => [],
    workflow: true,
  })
  runtime.trackConversation({
    agentId: 'nested-workflow',
    sessionId: 'owned-session',
    parentAgentId: 'workflow-parent',
    messages: () => [createUserMessage({ content: 'PRIVATE_WORKFLOW_CHILD' })],
  })
  expect(((await invoke(runtime)) as { result: unknown }).result).toMatchObject(
    { deny: expect.stringContaining('nested-workflow') },
  )
})
