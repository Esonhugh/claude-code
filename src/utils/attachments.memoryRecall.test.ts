import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setOriginalCwd } from '../bootstrap/state.js'
import { resetMemoryIndexForTesting } from '../memdir/memoryIndex.js'
import { getAutoMemPath, isSqliteMemoryEnabled } from '../memdir/paths.js'
import type { ToolUseContext } from '../Tool.js'
import type { Message } from '../types/message.js'
import { startRelevantMemoryPrefetch } from './attachments.js'
import { createUserMessage } from './messages.js'
import { resetSettingsCache } from './settings/settingsCache.js'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'memory-recall-')))
const prev = {
  config: process.env.CLAUDE_CONFIG_DIR,
  mem: process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE,
  auto: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY,
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeAll(() => {
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  // Never let fixtures land in a real memory directory set by the environment.
  process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = join(root, 'memory')
  // Remote sessions turn auto memory off unless the env says otherwise.
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '0'
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(join(root, 'config', 'settings.json'), JSON.stringify({ memory: { sqlite: { enabled: true, scopes: ['project'] } } }))
  mkdirSync(join(root, 'work'), { recursive: true })
  setOriginalCwd(join(root, 'work'))
  resetSettingsCache()
  isSqliteMemoryEnabled.cache.clear?.()
  getAutoMemPath.cache.clear?.()
  mkdirSync(getAutoMemPath(), { recursive: true })
  writeFileSync(join(getAutoMemPath(), 'build.md'), '---\nname: build\n---\nAlways build the binary with bun package:binary.')
  resetMemoryIndexForTesting(':memory:')
})

afterAll(() => {
  restore('CLAUDE_CONFIG_DIR', prev.config)
  restore('CLAUDE_COWORK_MEMORY_PATH_OVERRIDE', prev.mem)
  restore('CLAUDE_CODE_DISABLE_AUTO_MEMORY', prev.auto)
  resetSettingsCache()
  isSqliteMemoryEnabled.cache.clear?.()
  getAutoMemPath.cache.clear?.()
  rmSync(root, { recursive: true, force: true })
})

const ctx = {
  abortController: new AbortController(),
  options: { agentDefinitions: { activeAgents: [] } },
  readFileState: new Map(),
} as unknown as ToolUseContext

async function recalled(messages: Message[]): Promise<number> {
  using prefetch = startRelevantMemoryPrefetch(messages, ctx)
  const attachments = (await prefetch?.promise) ?? []
  return attachments.flatMap(a => (a.type === 'relevant_memories' ? a.memories : [])).length
}

test('sqlite memory recalls on the first prompt of a session only', async () => {
  expect(isSqliteMemoryEnabled()).toBe(true)
  const first = createUserMessage({ content: 'how do I build the binary' })
  expect(await recalled([first])).toBe(1)
  const later = createUserMessage({ content: 'how do I build the binary again' })
  expect(await recalled([first, later])).toBe(0)
  // A compact summary is not a prompt: the next prompt after /compact recalls again.
  const summary = createUserMessage({ content: 'Summary of the conversation', isCompactSummary: true })
  expect(await recalled([summary, later])).toBe(1)
})
