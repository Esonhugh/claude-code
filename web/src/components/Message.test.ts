import { describe, expect, it } from 'bun:test'
import { translate } from '../i18n'
import { type Block, type ChatState, initialState, type Item, type ModelOption, reduce } from '../protocol'
import { imageTarget, joinTurns, modelName, quotePrompt, relativeTo, splitQuote, stepActions, turnSegments } from './Message'

const models: ModelOption[] = [
  {
    value: 'default',
    displayName: 'Default (recommended)',
    resolvedModel: 'claude-opus-5-5',
    description: 'Use the default model (currently Opus 5.5) · $4/$20 per Mtok',
  },
  {
    value: 'opus',
    displayName: 'Opus',
    resolvedModel: 'claude-opus-5-5',
    description: 'Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok',
  },
  { value: 'claude-custom-1', displayName: 'Custom model' },
]

describe('modelName', () => {
  it('names a resolved model id by the models list, not the raw id', () => {
    expect(modelName('claude-opus-5-5', models)).toBe('Opus 5.5')
    expect(modelName('opus', models)).toBe('Opus 5.5')
    expect(modelName('claude-custom-1', models)).toBe('Custom model')
    expect(modelName('default', models)).toBe('Default (recommended)')
  })

  it('keeps the display name when the description is a sentence that starts with it', () => {
    const codex: ModelOption[] = [{ value: 'gpt-6.1-terra', displayName: 'GPT-6.1 Terra', description: 'GPT-6.1 Terra Codex model.' }]
    expect(modelName('gpt-6.1-terra', codex)).toBe('GPT-6.1 Terra')
  })

  it('falls back to a readable label without a models list', () => {
    expect(modelName('claude-sonnet-5-5', [])).toBe('Sonnet 5.5')
    expect(modelName(undefined, models)).toBeUndefined()
  })
})

describe('relativeTo', () => {
  it('drops the chat folder from a path under it, with either separator', () => {
    expect(relativeTo('/home/u/workspace/edit.txt', '/home/u/workspace')).toBe('edit.txt')
    expect(relativeTo('C:\\Users\\u\\workspace\\edit.txt', 'C:\\Users\\u\\workspace')).toBe('edit.txt')
    expect(relativeTo('C:\\Users\\u\\workspace\\a\\b.txt', 'C:\\Users\\u\\workspace\\')).toBe('a\\b.txt')
    expect(relativeTo('C:\\Users\\u\\workspace2\\x.txt', 'C:\\Users\\u\\workspace')).toBe('C:\\Users\\u\\workspace2\\x.txt')
  })
})

describe('one header per turn', () => {
  const reply = (id: string, ...blocks: Block[]): Item => ({ kind: 'assistant', id, streamed: false, blocks })
  const text = (t: string): Block => ({ kind: 'text', text: t })
  const think: Block = { kind: 'thinking', text: 'hm', ms: 2000 }
  const tool = (id: string, name = 'Bash'): Block => ({ kind: 'tool', id, name, input: '{}' })

  it('joins the API messages of a turn into one message', () => {
    const items: Item[] = [
      { kind: 'user', id: 'u1', text: 'hi' },
      reply('a1', think, tool('t1')),
      reply('a2', think, text('done')),
      { kind: 'user', id: 'u2', text: 'again' },
      reply('a3', text('third')),
    ]
    const turns = joinTurns(items)
    expect(turns.map(x => x.ids)).toEqual([['u1'], ['a1', 'a2'], ['u2'], ['a3']])
    expect(turns[1]!.item).toMatchObject({ id: 'a1', blocks: [think, tool('t1'), think, text('done')] })
    // A task notice under a1 ends the turn there.
    expect(joinTurns(items, id => id === 'a1').map(x => x.ids)).toContainEqual(['a1'])
  })

  it('adds up the usage of the joined replies', () => {
    const u = (input: number) => ({ input, output: 1, cacheRead: 0, cacheWrite: 0 })
    const [turn] = joinTurns([
      { kind: 'assistant', id: 'a1', streamed: false, blocks: [text('one')], usage: u(10) },
      { kind: 'assistant', id: 'a2', streamed: false, blocks: [text('two')], usage: u(20), turnUsage: u(35) },
    ])
    expect(turn!.item).toMatchObject({ usage: { input: 30, output: 2 }, turnUsage: { input: 35, output: 1 } })
  })

  it('folds runs of thinking and tools into steps, keeps single steps and task cards apart', () => {
    const blocks = [think, text('a'), think, tool('t1'), think, tool('agent', 'Agent'), tool('agent2', 'Agent'), think, text('b'), undefined]
    expect(turnSegments(blocks, i => i === 5 || i === 6)).toEqual([
      { kind: 'step', at: [0] },
      { kind: 'text', at: [1] },
      { kind: 'steps', at: [2, 3, 4] },
      { kind: 'cards', at: [5, 6] },
      { kind: 'step', at: [7] },
      { kind: 'text', at: [8] },
    ])
  })

  it('keeps a file edit out of the folded steps', () => {
    const blocks = [think, tool('read', 'Read'), tool('edit', 'Edit'), think, tool('ls'), text('done')]
    expect(turnSegments(blocks, () => false, i => i === 2)).toEqual([
      { kind: 'steps', at: [0, 1] },
      { kind: 'step', at: [2] },
      { kind: 'steps', at: [3, 4] },
      { kind: 'text', at: [5] },
    ])
  })
})

describe('stepActions', () => {
  const call = (name: string, input: Record<string, unknown>): Extract<Block, { kind: 'tool' }> => ({ kind: 'tool', id: name + JSON.stringify(input), name, input: JSON.stringify(input) })
  const t = (key: string, vars?: Record<string, string>) => `${key}:${Object.values(vars ?? {}).join(',')}`

  it('says what a run of tools did', () => {
    expect(
      stepActions(
        [
          call('Read', { file_path: '/a' }),
          call('Read', { file_path: '/b' }),
          call('Read', { file_path: '/a' }),
          call('Grep', { pattern: 'x' }),
          call('Bash', { command: 'bun test\nmore' }),
          call('TodoWrite', { todos: [] }),
        ],
        t as never,
      ),
    ).toEqual(['stepsRead:2', 'stepsSearched:1', 'stepsRanOne:bun test', 'TodoWrite'])
    expect(stepActions([call('Bash', { command: 'a' }), call('Bash', { command: 'b' })], t as never)).toEqual(['stepsRan:2'])
  })
})

describe('shell and skill cards', () => {
  const call = (name: string, input: unknown) => ({
    type: 'assistant',
    message: { id: 'a1', content: [{ type: 'tool_use', id: 't1', name, input }] },
  })
  const result = (content: string, is_error = false) => ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content, is_error }] },
  })
  const stream = (event: unknown) => ({ type: 'stream_event', event })
  const render = async (events: unknown[], streaming = false) => {
    const react = await import('react')
    ;(globalThis as { React?: unknown }).React ??= react
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { Message } = await import('./Message')
    const item = events.reduce<ChatState>(reduce, initialState).items.at(-1)!
    return renderToStaticMarkup(react.createElement(Message, { item, t: key => translate('en', key), streaming }))
  }

  it('keeps the Bash command preview and renders description, exact command and output in order', async () => {
    const command = 'printf first\n  printf second\n'
    const html = await render([call('Bash', { command, description: '  List <files>  ' }), result('shell stdout')])
    expect(html).toContain('<details class="toolcard"><summary><span class="tname">Bash</span><span class="tcmd">printf first</span>')
    expect(html).toContain('<span class="tstat ok">✓</span></summary>')
    expect(html).toContain(
      '<div class="tlabel">Description</div><div class="tdesc">List &lt;files&gt;</div>' +
        `<div class="tlabel">Command</div><pre class="tin"><code>${command}</code></pre>` +
        '<div class="tlabel">Output</div><pre class="tout">shell stdout</pre>',
    )
  })

  it('previews the first non-blank Bash line without changing the expanded command', async () => {
    const command = '\n \t \n  printf first\n    printf second\n'
    const html = await render([call('Bash', { command })])
    const summary = html.slice(html.indexOf('<summary>'), html.indexOf('</summary>'))
    expect(summary).toContain('printf first')
    expect(summary).not.toContain('printf second')
    expect(html).toContain(`<pre class="tin"><code>${command}</code></pre>`)
  })

  it('omits an absent or blank Bash description but keeps extra input fields and a failed result', async () => {
    const html = await render([call('Bash', { command: 'false' }), result('old failure', true)])
    expect(html).toContain('<span class="tcmd">false</span>')
    expect(html).toContain('<span class="tstat bad">✗</span></summary>')
    expect(html).toContain('<div class="tlabel">Command</div><pre class="tin"><code>false</code></pre>')
    expect(html).toContain('<pre class="tout">old failure</pre>')
    expect(html).not.toContain('Description')
    const withOptions = await render([call('Bash', { command: 'true', description: ' \n ', timeout: 500 })])
    expect(withOptions).toContain('<pre class="tin"><code>true</code></pre>')
    expect(withOptions).toContain('&quot;timeout&quot;: 500')
    expect(withOptions).not.toContain('&quot;command&quot;')
    expect(withOptions).not.toContain('Description')
  })

  it('keeps partial Bash input generic until the completed input arrives', async () => {
    const events = [
      stream({ type: 'message_start', message: { id: 'a1' } }),
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Bash', id: 't1' } }),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"tru' } }),
    ]
    const partial = await render(events, true)
    expect(partial).toContain('<div class="tlabel">Input</div><pre class="tin">{&quot;command&quot;:&quot;tru</pre>')
    expect(partial).toContain('class="spin"')
    expect(partial).not.toContain('class="tout"')
    const full = await render([...events, call('Bash', { command: 'true', description: 'Check fixture' })], true)
    expect(full).toContain('<div class="tdesc">Check fixture</div>')
    expect(full).toContain('<pre class="tin"><code>true</code></pre>')
    expect(full).toContain('class="spin"')
  })

  it('renders the Skill name alone when args are absent or blank', async () => {
    for (const input of [{ skill: 'test:fixture' }, { skill: 'test:fixture', args: '  \n ' }]) {
      const html = await render([call('Skill', input), result('skill result')])
      expect(html).toContain('<span class="tname">Skill</span><span class="tcmd">test:fixture</span>')
      expect(html).toContain('<span class="tstat ok">✓</span></summary>')
      expect(html).toContain('<pre class="tin"><code>test:fixture</code></pre><div class="tlabel">Output</div>')
      expect(html).toContain('<pre class="tout">skill result</pre>')
      expect(html).not.toContain('&quot;skill&quot;')
      expect(html).not.toContain('Arguments')
    }
  })

  it('makes Skill args a single-line preview but preserves full args as text in the body', async () => {
    const longArg = 'x'.repeat(160)
    const html = await render([call('Skill', { skill: 'test:fixture', args: `--target <file>\n  ${longArg}` }), result('skill result')])
    expect(html).toContain(`<span class="tcmd">test:fixture --target &lt;file&gt; ${longArg}</span>`)
    expect(html).toContain(
      '<pre class="tin"><code>test:fixture</code></pre><div class="tlabel">Arguments</div>' +
        `<pre class="tin"><code>--target &lt;file&gt;\n  ${longArg}</code></pre><div class="tlabel">Output</div>`,
    )
  })

  it('does not hide malformed Skill inputs or their error result', async () => {
    const html = await render([call('Skill', { skill: 'test:fixture', args: { legacy: true } }), result('skill failure', true)])
    expect(html).toContain('<span class="tcmd">{&quot;skill&quot;:&quot;test:fixture&quot;,&quot;args&quot;:{&quot;legacy&quot;:true}}</span>')
    expect(html).toContain('<span class="tstat bad">✗</span></summary>')
    expect(html).toContain('<div class="tlabel">Input</div><pre class="tin">{')
    expect(html).toContain('&quot;legacy&quot;: true')
    expect(html).toContain('<pre class="tout">skill failure</pre>')
  })
})

describe('handback report', () => {
  it('spins only while the turn streams: a saved report has no result yet still finished', async () => {
    const react = await import('react')
    ;(globalThis as { React?: unknown }).React ??= react
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { Message } = await import('./Message')
    const item: Item = {
      kind: 'assistant',
      id: 'a1',
      streamed: false,
      blocks: [{ kind: 'tool', id: 't1', name: 'SubagentHandback', input: JSON.stringify({ message: 'All done.' }) }],
    }
    const render = (streaming: boolean) =>
      renderToStaticMarkup(react.createElement(Message, { item, t: ((key: string) => key) as never, streaming }))
    expect(render(false)).toContain('All done.')
    expect(render(false)).not.toContain('class="spin"')
    expect(render(true)).toContain('class="spin"')
  })
})

describe('local command output', () => {
  const render = async (item: Item) => {
    const react = await import('react')
    ;(globalThis as { React?: unknown }).React ??= react
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { Message } = await import('./Message')
    return renderToStaticMarkup(react.createElement(Message, { item, t: ((key: string) => key) as never, streaming: false }))
  }

  it('renders stdout as Markdown, like the TUI (/release-notes)', async () => {
    const html = await render({
      kind: 'local',
      id: 'l1',
      command: 'release-notes',
      text: 'Version 2.1.297:\n· run `make build` for **built-claude**\n· see [docs](https://example.com)',
    })
    expect(html).toContain('<code>make build</code>')
    expect(html).toContain('<strong>built-claude</strong>')
    expect(html).toContain('href="https://example.com"')
    expect(html).not.toContain('`make build`')
  })

  it('keeps errors as plain text', async () => {
    const html = await render({ kind: 'local', id: 'l2', text: 'Unknown `x` <name>', isError: true })
    expect(html).toContain('Unknown `x` &lt;name&gt;')
    expect(html).not.toContain('<code>')
  })
})

describe('imageTarget', () => {
  it('names the image and the start of its message, with mentions as file names', () => {
    expect(imageTarget('Fix   this\n@/a/b/readme.md and @"/x y/z.png"', 1)).toBe(
      'image 2 of my message "Fix this readme.md and z.png"',
    )
    expect(imageTarget('', 0)).toBe('image 1 of my message')
    expect(imageTarget('x'.repeat(50), 0)).toBe(`image 1 of my message "${'x'.repeat(40)}…"`)
  })
})

describe('reply quotes', () => {
  it('sends the quote as a blockquote ahead of the typed text', () => {
    expect(quotePrompt('  first line\n\nsecond  ', 'why?')).toBe('> first line\n>\n> second\n\nwhy?')
  })

  it('reads the quote back for the user bubble', () => {
    expect(splitQuote(quotePrompt('a\n\nb', 'why?'))).toEqual({ quote: 'a\n\nb', rest: 'why?' })
  })

  it('leaves text without a leading quote as it is', () => {
    expect(splitQuote('plain')).toEqual({ rest: 'plain' })
    expect(splitQuote('see\n> not leading\n\nx')).toEqual({ rest: 'see\n> not leading\n\nx' })
    // Only a quote, nothing typed after it: not a reply.
    expect(splitQuote('> only\n\n')).toEqual({ rest: '> only\n\n' })
  })
})
