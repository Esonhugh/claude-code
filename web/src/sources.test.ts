import { describe, expect, it } from 'bun:test'
import type { AgentTask } from './agents'
import { chatMarkdown, exportFileName, sourceMarkdown } from './exportChat'
import type { Block, Item } from './protocol'
import { toolSources, turnSources } from './sources'

const tool = (name: string, input: unknown, result?: string): Extract<Block, { kind: 'tool' }> => ({
  kind: 'tool',
  id: `${name}-1`,
  name,
  input: JSON.stringify(input),
  result,
})

const searchResult = [
  'Web search results for query: "bun"',
  'Links: [{"title":"Bun","url":"https://bun.sh/"},{"title":"Bad","url":"javascript:alert(1)"},{"title":"Docs","url":"https://bun.sh/docs"}]',
  'Links: not json',
  'REMINDER: You MUST include the sources above.',
].join('\n\n')

describe('toolSources', () => {
  it('reads WebSearch links and drops non-http URLs', () => {
    expect(toolSources(tool('WebSearch', { query: 'bun' }, searchResult))).toEqual([
      { url: 'https://bun.sh/', title: 'Bun' },
      { url: 'https://bun.sh/docs', title: 'Docs' },
    ])
  })

  it('takes the fetched URL once WebFetch has a result', () => {
    expect(toolSources(tool('WebFetch', { url: 'https://a.example/x' }))).toEqual([])
    expect(toolSources(tool('WebFetch', { url: 'https://a.example/x' }, 'page'))).toEqual([
      { url: 'https://a.example/x' },
    ])
    expect(toolSources(tool('WebFetch', { url: 'file:///etc/passwd' }, 'page'))).toEqual([])
    expect(toolSources({ ...tool('WebFetch', { url: 'https://a.example' }, 'x'), isError: true })).toEqual([])
  })

  it('collects URLs of a research workflow only', () => {
    const result = '{"sources":[{"url":"https://r.example/a","quality":"primary"}],"note":"see https://r.example/b."}'
    expect(toolSources(tool('Workflow', { name: 'deep-research' }, result))).toEqual([
      { url: 'https://r.example/a' },
      { url: 'https://r.example/b' },
    ])
    expect(toolSources(tool('Workflow', { name: 'review-changes' }, result))).toEqual([])
    const task = { workflowName: 'deep-research', summary: 'Report: https://r.example/c' } as AgentTask
    expect(toolSources(tool('Workflow', {}, 'started'), task)).toEqual([{ url: 'https://r.example/c' }])
  })
})

const items: Item[] = [
  { kind: 'user', id: 'u1', text: 'search bun' },
  {
    kind: 'assistant',
    id: 'a1',
    model: 'claude-opus-5-5',
    streamed: false,
    blocks: [
      { kind: 'thinking', text: 'hmm' },
      tool('WebSearch', { query: 'bun' }, searchResult),
      { ...tool('WebFetch', { url: 'https://bun.sh/' }, 'page'), id: 'f1' },
    ],
  },
  {
    kind: 'assistant',
    id: 'a2',
    streamed: false,
    blocks: [{ kind: 'text', text: 'Bun is a runtime.' }],
  },
  { kind: 'user', id: 'u2', text: 'thanks' },
  { kind: 'assistant', id: 'a3', streamed: false, blocks: [{ kind: 'text', text: 'Welcome.' }] },
  { kind: 'error', id: 'e1', text: 'boom' },
]

describe('turnSources', () => {
  it('lists each turn under its last answer, deduplicated by URL', () => {
    const sources = turnSources(items)
    expect([...sources.keys()]).toEqual(['a2'])
    expect(sources.get('a2')).toEqual([
      { url: 'https://bun.sh/', title: 'Bun' },
      { url: 'https://bun.sh/docs', title: 'Docs' },
    ])
  })
})

describe('chatMarkdown', () => {
  it('writes user text, answers, one line per tool and the sources', () => {
    const md = chatMarkdown('Bun chat', items, turnSources(items), { you: 'You', sources: 'Sources' })
    expect(md).toBe(
      [
        '# Bun chat',
        '## You',
        'search bun',
        '## Claude (Opus 5.5)',
        '- `WebSearch` bun\n- `WebFetch` https://bun.sh/',
        'Bun is a runtime.',
        '**Sources**',
        '1. [Bun](https://bun.sh/)\n2. [Docs](https://bun.sh/docs)',
        '## You',
        'thanks',
        '## Claude',
        'Welcome.',
        '> boom',
      ].join('\n\n') + '\n',
    )
  })

  it('writes teammate messages under the member name', () => {
    const md = chatMarkdown(
      'Team',
      [{ kind: 'teammate', id: 't1', from: 'alice', text: 'done with the review' }],
      new Map(),
      { you: 'You', sources: 'Sources' },
    )
    expect(md).toContain('## @alice\n\ndone with the review')
  })

  it('escapes link titles and URLs', () => {
    expect(sourceMarkdown({ url: 'https://a.example/x_(y)', title: 'a [b]' })).toBe(
      '[a \\[b\\]](https://a.example/x_%28y%29)',
    )
    expect(sourceMarkdown({ url: 'https://a.example/' })).toBe('[a.example](https://a.example/)')
  })
})

describe('exportFileName', () => {
  it('replaces characters file systems reject', () => {
    expect(exportFileName('a/b: c?\n', 'md')).toBe('a b c.md')
    expect(exportFileName('  ', 'pdf')).toBe('claude-chat.pdf')
  })
})
