import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { sanitizePath } from '../utils/sessionStoragePortable.js'
import { findAgentIssuers, listHistory, readAgentTranscript, readSnippet, readTranscript, renameSession, snippetText } from './history.js'

const ID = '11111111-2222-4333-8444-555555555555'
let root = ''
let prior: string | undefined

function line(entry: Record<string, unknown>): string {
  return JSON.stringify({ sessionId: ID, isSidechain: false, timestamp: '2026-11-02T00:00:00.000Z', ...entry })
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'web-history-')))
  prior = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  const cwd = join(root, 'project')
  mkdirSync(cwd)
  const dir = join(root, 'config', 'projects', sanitizePath(cwd))
  mkdirSync(dir, { recursive: true })
  const entries = [
    line({ type: 'user', uuid: 'a0000000-0000-4000-8000-000000000001', parentUuid: null, cwd, message: { role: 'user', content: 'first question' } }),
    line({ type: 'user', uuid: 'a0000000-0000-4000-8000-000000000002', parentUuid: 'a0000000-0000-4000-8000-000000000001', cwd, isMeta: true, message: { role: 'user', content: 'hidden meta' } }),
    line({
      type: 'assistant',
      uuid: 'a0000000-0000-4000-8000-000000000003',
      parentUuid: 'a0000000-0000-4000-8000-000000000002',
      cwd,
      message: { id: 'msg_1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'first answer' }] },
    }),
    line({ type: 'user', uuid: 'a0000000-0000-4000-8000-000000000004', parentUuid: 'a0000000-0000-4000-8000-000000000003', cwd, message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
    line({ type: 'user', uuid: 'a0000000-0000-4000-8000-000000000006', parentUuid: 'a0000000-0000-4000-8000-000000000004', cwd, message: { role: 'user', content: '<local-command-stdout>cleared</local-command-stdout>' } }),
    line({
      type: 'assistant',
      uuid: 'a0000000-0000-4000-8000-000000000007',
      parentUuid: 'a0000000-0000-4000-8000-000000000006',
      cwd,
      isApiErrorMessage: true,
      message: { id: 'msg_e', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 500' }] },
    }),
    line({ type: 'user', uuid: 'a0000000-0000-4000-8000-000000000005', parentUuid: 'a0000000-0000-4000-8000-000000000007', cwd, message: { role: 'user', content: [{ type: 'text', text: 'second question' }] } }),
  ]
  writeFileSync(join(dir, `${ID}.jsonl`), entries.join('\n') + '\n')
  const agentDir = join(dir, ID, 'subagents', 'workflows', 'run1')
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(
    join(agentDir, 'agent-abc123.jsonl'),
    [
      line({ type: 'user', isSidechain: true, agentId: 'abc123', uuid: 'b0000000-0000-4000-8000-000000000001', parentUuid: null, cwd, message: { role: 'user', content: 'sub task' } }),
      line({
        type: 'assistant',
        isSidechain: true,
        agentId: 'abc123',
        uuid: 'b0000000-0000-4000-8000-000000000002',
        parentUuid: 'b0000000-0000-4000-8000-000000000001',
        cwd,
        message: { id: 'msg_s', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'sub answer' }] },
      }),
    ].join('\n') + '\n',
  )
})

afterEach(() => {
  if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prior
  rmSync(root, { recursive: true, force: true })
})

describe('web history', () => {
  it('finds a subagent transcript under the session folder', async () => {
    const page = await readAgentTranscript(ID, 'abc123')
    expect(page?.messages.map(m => m.type)).toEqual(['user', 'assistant'])
    expect(JSON.stringify(page?.messages)).toContain('sub answer')
    expect(await readAgentTranscript(ID, 'missing')).toBeUndefined()
  })

  it('shows a resumed agent once per message', async () => {
    // Resuming an agent appends its earlier messages again, with the same uuids.
    const file = join(root, 'config', 'projects', sanitizePath(join(root, 'project')), ID, 'subagents', 'workflows', 'run1', 'agent-abc123.jsonl')
    const before = readFileSync(file, 'utf8')
    writeFileSync(
      file,
      before +
        before +
        line({
          type: 'user',
          isSidechain: true,
          agentId: 'abc123',
          uuid: 'b0000000-0000-4000-8000-000000000003',
          parentUuid: 'b0000000-0000-4000-8000-000000000002',
          message: { role: 'user', content: 'follow up' },
        }) +
        '\n',
    )
    const page = await readAgentTranscript(ID, 'abc123')
    expect(page?.messages.map(m => m.uuid)).toEqual([
      'b0000000-0000-4000-8000-000000000001',
      'b0000000-0000-4000-8000-000000000002',
      'b0000000-0000-4000-8000-000000000003',
    ])
  })

  it('finds the subagent that issued an Agent call', async () => {
    const dir = join(root, 'config', 'projects', sanitizePath(join(root, 'project')), ID, 'subagents')
    writeFileSync(
      join(dir, 'agent-parent1.jsonl'),
      line({
        type: 'assistant',
        isSidechain: true,
        agentId: 'parent1',
        uuid: 'c0000000-0000-4000-8000-000000000001',
        parentUuid: null,
        message: {
          id: 'msg_p',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_child', name: 'Agent', input: { prompt: 'go' } }],
        },
      }) + '\n',
    )
    expect(await findAgentIssuers(ID, ['toolu_child', 'toolu_none'])).toEqual({ toolu_child: 'parent1' })
    expect(await findAgentIssuers('99999999-2222-4333-8444-555555555555', ['toolu_child'])).toEqual({})
  })

  it('lists the session with its folder', async () => {
    const list = await listHistory(0, 10)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: ID, cwd: join(root, 'project') })
  })

  it('returns visible messages as stream-json and pages backwards', async () => {
    const page = await readTranscript(ID, undefined, 10)
    expect(page?.cwd).toBe(join(root, 'project'))
    expect(page?.total).toBe(6)
    expect(page?.messages.map(m => m.type)).toEqual(['user', 'assistant', 'user', 'user', 'assistant', 'user'])
    expect(page?.messages[0]).toMatchObject({ isReplay: true, parent_tool_use_id: null })
    expect(JSON.stringify(page?.messages)).not.toContain('hidden meta')
    // Slash commands and their output stay, for the page to show as command lines.
    expect(page?.messages[2]).toMatchObject({ message: { content: '<command-name>/clear</command-name>' } })
    expect(page?.messages[3]).toMatchObject({ message: { content: '<local-command-stdout>cleared</local-command-stdout>' } })
    expect(page?.messages[4]).toMatchObject({ isApiErrorMessage: true })

    const last = await readTranscript(ID, undefined, 1)
    expect(last).toMatchObject({ start: 5, total: 6 })
    const earlier = await readTranscript(ID, 5, 5)
    expect(earlier?.start).toBe(0)
    expect(earlier?.messages).toHaveLength(5)
  })

  it('replays compaction, goals, local commands and edit patches like the live stream', async () => {
    const file = join(root, 'config', 'projects', sanitizePath(join(root, 'project')), `${ID}.jsonl`)
    const cwd = join(root, 'project')
    const patch = [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-a', '+b'] }]
    writeFileSync(
      file,
      readFileSync(file, 'utf8') +
        [
          line({
            type: 'system',
            subtype: 'compact_boundary',
            uuid: 'a0000000-0000-4000-8000-000000000008',
            parentUuid: null,
            cwd,
            content: 'Conversation compacted',
            compactMetadata: { trigger: 'auto', preTokens: 186000 },
          }),
          line({ type: 'user', uuid: 'a0000000-0000-4000-8000-000000000009', parentUuid: 'a0000000-0000-4000-8000-000000000008', cwd, isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued from a previous conversation. Summary.' } }),
          line({ type: 'attachment', uuid: 'a0000000-0000-4000-8000-000000000010', parentUuid: 'a0000000-0000-4000-8000-000000000009', cwd, attachment: { type: 'goal_status', id: 'g1', condition: 'tests pass', status: 'active', iterations: 1 } }),
          line({ type: 'system', subtype: 'local_command', uuid: 'a0000000-0000-4000-8000-000000000011', parentUuid: 'a0000000-0000-4000-8000-000000000010', cwd, content: '<local-command-stdout>recap text</local-command-stdout>' }),
          line({
            type: 'user',
            uuid: 'a0000000-0000-4000-8000-000000000012',
            parentUuid: 'a0000000-0000-4000-8000-000000000011',
            cwd,
            toolUseResult: { type: 'update', filePath: '/x', originalFile: 'whole file', structuredPatch: patch },
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_e', content: 'ok' }] },
          }),
        ].join('\n') +
        '\n',
    )
    const messages = (await readTranscript(ID, undefined, 50))!.messages.slice(-5)
    expect(messages[0]).toMatchObject({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 186000 } })
    expect(messages[1]).toMatchObject({ type: 'user', isCompactSummary: true })
    expect(messages[2]).toMatchObject({ type: 'system', subtype: 'goal_state_changed', goal: { condition: 'tests pass', status: 'active' } })
    expect(messages[3]).toMatchObject({ type: 'user', isReplay: true, message: { content: '<local-command-stdout>recap text</local-command-stdout>' } })
    expect(messages[4]).toMatchObject({ tool_use_result: { type: 'update', structuredPatch: patch } })
    expect(JSON.stringify(messages[4])).not.toContain('whole file')
  })

  it('shows a message sent mid-turn where the model read it, under the uuid the page sent', async () => {
    const file = join(root, 'config', 'projects', sanitizePath(join(root, 'project')), `${ID}.jsonl`)
    const cwd = join(root, 'project')
    writeFileSync(
      file,
      readFileSync(file, 'utf8') +
        [
          line({ type: 'attachment', uuid: 'a0000000-0000-4000-8000-000000000020', parentUuid: 'a0000000-0000-4000-8000-000000000005', cwd, attachment: { type: 'queued_command', prompt: [{ type: 'text', text: 'also check B' }], source_uuid: 'c0000000-0000-4000-8000-000000000001', commandMode: 'prompt' } }),
          line({ type: 'attachment', uuid: 'a0000000-0000-4000-8000-000000000021', parentUuid: 'a0000000-0000-4000-8000-000000000020', cwd, attachment: { type: 'queued_command', prompt: '<task-notification>x</task-notification>', commandMode: 'task-notification' } }),
          line({ type: 'assistant', uuid: 'a0000000-0000-4000-8000-000000000022', parentUuid: 'a0000000-0000-4000-8000-000000000021', cwd, message: { id: 'm9', role: 'assistant', content: [{ type: 'text', text: 'checked B' }] } }),
        ].join('\n') +
        '\n',
    )
    const messages = (await readTranscript(ID, undefined, 50))!.messages
    expect(messages.at(-1)).toMatchObject({ type: 'assistant' })
    expect(messages.at(-2)).toMatchObject({
      type: 'user',
      isReplay: true,
      uuid: 'c0000000-0000-4000-8000-000000000001',
      message: { role: 'user', content: [{ type: 'text', text: 'also check B' }] },
    })
    expect(JSON.stringify(messages)).not.toContain('task-notification')
  })

  it('keeps the history before a compaction, in the order it was written', async () => {
    const file = join(root, 'config', 'projects', sanitizePath(join(root, 'project')), `${ID}.jsonl`)
    const cwd = join(root, 'project')
    const u = (n: number) => `a0000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`
    const at = (n: number) => `2026-11-02T00:01:${String(n).padStart(2, '0')}.000Z`
    writeFileSync(
      file,
      readFileSync(file, 'utf8') +
        [
          line({ type: 'assistant', uuid: u(1), parentUuid: 'a0000000-0000-4000-8000-000000000005', cwd, timestamp: at(1), message: { id: 'msg_k', role: 'assistant', content: [{ type: 'text', text: 'kept tail' }] } }),
          // /compact keeping the last reply: the boundary hangs off nothing, the kept reply keeps its old parent.
          line({
            type: 'system',
            subtype: 'compact_boundary',
            uuid: u(2),
            parentUuid: null,
            logicalParentUuid: u(1),
            cwd,
            timestamp: at(2),
            compactMetadata: { trigger: 'manual', preTokens: 9000, preservedSegment: { headUuid: u(1), anchorUuid: u(3), tailUuid: u(1) } },
          }),
          line({ type: 'user', uuid: u(3), parentUuid: u(2), cwd, timestamp: at(3), isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation. Summary.' } }),
          line({ type: 'user', uuid: u(4), parentUuid: u(3), cwd, timestamp: at(4), message: { role: 'user', content: '<command-name>/compact</command-name>' } }),
          line({ type: 'user', uuid: u(5), parentUuid: u(4), cwd, timestamp: at(5), message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' } }),
          line({ type: 'user', uuid: u(6), parentUuid: u(5), cwd, timestamp: at(6), message: { role: 'user', content: 'after compact' } }),
        ].join('\n') +
        '\n',
    )
    const page = (await readTranscript(ID, undefined, 50))!
    expect(page.total).toBe(12)
    expect(page.messages.map(m => m.uuid)).toEqual([
      'a0000000-0000-4000-8000-000000000001',
      'a0000000-0000-4000-8000-000000000003',
      'a0000000-0000-4000-8000-000000000004',
      'a0000000-0000-4000-8000-000000000006',
      'a0000000-0000-4000-8000-000000000007',
      'a0000000-0000-4000-8000-000000000005',
      u(1),
      u(2),
      u(3),
      u(4),
      u(5),
      u(6),
    ])
    // An earlier page still reaches the first question.
    const earlier = (await readTranscript(ID, 7, 7))!
    expect(earlier.start).toBe(0)
    expect(JSON.stringify(earlier.messages)).toContain('first question')

    // An auto-compact before the reply to u(7): the reply hangs off the kept u(7), not the summary.
    writeFileSync(
      file,
      readFileSync(file, 'utf8') +
        [
          line({ type: 'user', uuid: u(7), parentUuid: u(6), cwd, timestamp: at(7), message: { role: 'user', content: 'big turn' } }),
          line({
            type: 'system',
            subtype: 'compact_boundary',
            uuid: u(8),
            parentUuid: null,
            logicalParentUuid: u(7),
            cwd,
            timestamp: at(8),
            compactMetadata: { trigger: 'auto', preTokens: 985000, preservedSegment: { headUuid: u(6), anchorUuid: u(9), tailUuid: u(7) } },
          }),
          line({ type: 'user', uuid: u(9), parentUuid: u(8), cwd, timestamp: at(9), isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation. Again.' } }),
          line({ type: 'assistant', uuid: u(10), parentUuid: u(7), cwd, timestamp: at(10), message: { id: 'msg_b', role: 'assistant', content: [{ type: 'text', text: 'big answer' }] } }),
        ].join('\n') +
        '\n',
    )
    const again = (await readTranscript(ID, undefined, 50))!
    expect(again.messages.slice(-5).map(m => m.uuid)).toEqual([u(6), u(7), u(8), u(9), u(10)])
    expect(again.messages.filter(m => m.subtype === 'compact_boundary')).toHaveLength(2)
    expect(JSON.stringify(again.messages)).toContain('first question')
  })

  it('reads the first assistant text as the snippet of a recent card', async () => {
    expect(await readSnippet(ID)).toBe('first answer')
    expect(await readSnippet('99999999-2222-4333-8444-555555555555')).toBeUndefined()
  })

  it('renames by appending a custom title', async () => {
    expect(await renameSession(ID, 'My chat')).toBe(true)
    const file = join(root, 'config', 'projects', sanitizePath(join(root, 'project')), `${ID}.jsonl`)
    expect(readFileSync(file, 'utf8')).toContain('"customTitle":"My chat"')
    expect((await listHistory(0, 10))[0]?.title).toBe('My chat')
    expect(await renameSession('99999999-2222-4333-8444-555555555555', 'x')).toBe(false)
    expect(await readTranscript('99999999-2222-4333-8444-555555555555', undefined, 10)).toBeUndefined()
  })
})

describe('snippetText', () => {
  it('turns a Markdown reply into one plain line', () => {
    expect(
      snippetText('## Reply\n\nYou said: **hi** and `x`\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1\n```\n- see [docs](https://e.x)'),
    ).toBe('Reply You said: hi and x a b 1 2 const x = 1 see docs')
  })
})
