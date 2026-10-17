import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { asAgentId } from '../types/ids.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const configDir = mkdtempSync(join(tmpdir(), 'agent-metadata-test-'))
process.env.CLAUDE_CONFIG_DIR = configDir

const { clearAgentMetadataWorktree, readAgentMetadata, writeAgentMetadata } =
  await import('./sessionStorage.js')

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

test('C3 clearing the worktree keeps the rest of the agent metadata', async () => {
  const agentId = asAgentId('agent-metadata-worktree')
  // Same shape runAgent records: toolUseId rides along through the spread.
  const recorded = {
    agentType: 'general-purpose',
    description: 'original description',
    effort: 'low' as const,
    permissionMode: 'acceptEdits' as const,
    model: 'claude-sonnet-4-6',
    name: 'pinned',
    parentAgentId: 'parent-agent',
    spawnDepth: 2,
    toolUseId: 'toolu_meta',
  }
  await writeAgentMetadata(agentId, {
    ...recorded,
    worktreePath: '/tmp/worktree',
    worktreeBranch: 'agent-branch',
  })

  await clearAgentMetadataWorktree(agentId, {
    agentType: 'general-purpose',
    description: 'original description',
    effort: 'low',
  })

  expect(await readAgentMetadata(agentId)).toEqual(recorded)
})

test('C3 clearing the worktree without a record writes the fallback', async () => {
  const agentId = asAgentId('agent-metadata-missing')
  await clearAgentMetadataWorktree(agentId, {
    agentType: 'general-purpose',
    description: 'fallback',
  })
  expect(await readAgentMetadata(agentId)).toEqual({
    agentType: 'general-purpose',
    description: 'fallback',
  })
})
