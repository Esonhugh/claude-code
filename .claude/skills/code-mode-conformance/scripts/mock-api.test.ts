import { describe, expect, test } from 'bun:test'
import { decide, fill, record, redact, sse, type Scenario } from './mock-api.ts'

const scenario: Scenario = {
  name: 't',
  commands: {
    EXPR: [
      { tools: [{ name: 'REPL', input: { code: '1+1 // {{nonce}}' } }] },
      { text: 'DONE {{nonce}} {{last}}' },
    ],
    WAIT: [{ text: 'DONE {{nonce}} waiting' }],
    'WAIT:notif': [{ text: 'NOTIF {{nonce}} seen' }],
  },
  agents: { 'SUBKEY': [{ tools: [{ name: 'REPL', input: { code: '2' } }] }, { text: 'sub done' }] },
  side: [{ match: 'summar', text: 'SUMMARY' }],
}
const tool = [{ name: 'REPL' }]
const user = (t: string) => ({ role: 'user', content: [{ type: 'text', text: t }] })
const result = (t: string) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: t }] })
const asst = { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'REPL', input: {} }] }

describe('redact', () => {
  test('replaces secret-named keys and token-shaped strings, deeply', () => {
    const out = redact({
      headers: { 'x-api-key': 'k1', Authorization: 'Bearer abc.def', cookie: 'c', 'user-agent': 'ua' },
      nested: [{ text: 'key sk-ant-api03-AAAA_bb-cc and Bearer xyz' }],
    }) as any
    expect(out.headers['x-api-key']).toBe('[REDACTED]')
    expect(out.headers.Authorization).toBe('[REDACTED]')
    expect(out.headers.cookie).toBe('[REDACTED]')
    expect(out.headers['user-agent']).toBe('ua')
    expect(out.nested[0].text).toBe('key [REDACTED] and [REDACTED]')
    expect(JSON.stringify(out)).not.toMatch(/sk-ant-|abc\.def/)
  })

  test('record() output carries no secrets from headers or bodies', () => {
    const body = { model: 'm', tools: tool, system: 'sys sk-ant-zzz', messages: [user('@@ n1 EXPR')] }
    const r = record(1, body, decide(body, scenario), { 'x-api-key': 'sk-ant-real', authorization: 'Bearer q' })
    expect(JSON.stringify(r)).not.toMatch(/sk-ant-|Bearer q|x-api-key|authorization/i)
    expect(r).toMatchObject({ secretHeaders: 2 })
  })
})

describe('decide', () => {
  test('steps through a command by tool_result count and fills templates', () => {
    const b0 = { tools: tool, messages: [user('@@ n7 EXPR')] }
    const d0 = decide(b0, scenario)
    expect(d0).toMatchObject({ role: 'main:EXPR', cmd: 'EXPR', step: 0, nonce: 'n7' })
    expect(d0.reply.tools![0]!.input).toEqual({ code: '1+1 // n7' })
    const b1 = { tools: tool, messages: [user('@@ n7 EXPR'), asst, result('<repl-output>\n<result>2</result>')] }
    expect(decide(b1, scenario).reply.text).toBe('DONE n7 <repl-output> <result>2</result>')
  })

  test('the last reply repeats past the end of the list', () => {
    const b = { tools: tool, messages: [user('@@ n1 EXPR'), asst, result('a'), asst, result('b')] }
    expect(decide(b, scenario)).toMatchObject({ step: 2, reply: { text: 'DONE n1 b' } })
  })

  test('routes to the most recent command, and notification turns to <CMD>:notif', () => {
    const msgs = [user('@@ n1 EXPR'), { role: 'assistant', content: 'x' }, user('@@ n2 WAIT')]
    expect(decide({ tools: tool, messages: msgs }, scenario).reply.text).toBe('DONE n2 waiting')
    const woke = [...msgs, { role: 'assistant', content: 'DONE n2 waiting' }, user('<event kind="repl-eval">')]
    expect(decide({ tools: tool, messages: woke }, scenario)).toMatchObject({ role: 'main:WAIT:notif', reply: { text: 'NOTIF n2 seen' } })
  })

  test('a prompt merged into a tool_result message still starts its command', () => {
    const merged = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'x', content: 'interrupted' },
        { type: 'text', text: '[Request interrupted by user for tool use]' },
        { type: 'text', text: '@@ n9 WAIT' },
      ],
    }
    const d = decide({ tools: tool, messages: [user('@@ n8 EXPR'), asst, merged] }, scenario)
    expect(d).toMatchObject({ role: 'main:WAIT', nonce: 'n9', step: 0, reply: { text: 'DONE n9 waiting' } })
  })

  test('subagents match by their first message; tool-less requests use side rules', () => {
    const sub = { tools: tool, messages: [user('do SUBKEY now'), asst, result('2')] }
    expect(decide(sub, scenario)).toMatchObject({ role: 'agent:SUBKEY', step: 1, reply: { text: 'sub done' } })
    expect(decide({ tools: tool, messages: [user('other')] }, scenario).role).toBe('agent:none')
    expect(decide({ messages: [user('please summarize')] }, scenario).reply.text).toBe('SUMMARY')
    expect(decide({ tools: [], messages: [user('title?')] }, scenario).reply.text).toBe('ok')
  })

  test('an unknown command answers DONE so the driver does not hang', () => {
    expect(decide({ tools: tool, messages: [user('@@ n3 NOPE')] }, scenario).reply.text).toBe('DONE n3 unknown-command')
  })
})

describe('sse', () => {
  test('tool replies stream tool_use blocks and stop with tool_use', () => {
    const s = sse({ tools: [{ name: 'REPL', input: { code: '1' } }] }, 'm')
    expect(s).toContain('"type":"tool_use"')
    expect(s).toContain('"partial_json":"{\\"code\\":\\"1\\"}"')
    expect(s).toContain('"stop_reason":"tool_use"')
    expect(s.trim().endsWith('data: {"type":"message_stop"}')).toBe(true)
  })

  test('text replies stop with end_turn', () => {
    expect(sse({ text: 'hi' }, 'm')).toContain('"stop_reason":"end_turn"')
  })

  test('fill leaves unknown placeholders alone', () => {
    expect(fill({ a: ['{{nonce}} {{nope}}'] }, { nonce: 'n' })).toEqual({ a: ['n {{nope}}'] })
  })
})
