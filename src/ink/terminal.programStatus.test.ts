import { expect, test } from 'bun:test'
import { INITIAL_STATE, parseMultipleKeypresses } from './parse-keypress.js'
import * as queries from './terminal-querier.js'

for (const terminator of ['\x07', '\x1b\\']) {
  test(`OSC 7501 response parser accepts ${terminator === '\x07' ? 'BEL' : 'ST'}`, () => {
    const [items] = parseMultipleKeypresses(INITIAL_STATE, `\x1b]7501;?supported${terminator}`)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'response', response: { type: 'osc', code: 7501, data: '?supported' } })
  })
}

test('OSC 7501 query accepts only probe replies before the DA1 sentinel', async () => {
  const writes: string[] = []
  const querier = new queries.TerminalQuerier({ write: (text: string) => { writes.push(text); return true } } as NodeJS.WriteStream)
  const query = queries.programStatusQuery()
  // eslint-disable-next-line no-control-regex
  expect(query.request).toMatch(/^\x1b\]7501;\?/)
  expect(query.match({ type: 'osc', code: 7501, data: 'state=idle' })).toBe(false)
  const reply = { type: 'osc', code: 7501, data: '?supported' } as const
  const result = querier.send(query)
  const flushed = querier.flush()
  querier.onResponse(reply)
  querier.onResponse({ type: 'da1', params: [62, 22] })
  expect(await result).toEqual(reply)
  await flushed
  expect(writes.at(-1)).toBe('\x1b[c')
})

test('DA1 first settles an unanswered query without accepting a late reply', async () => {
  const querier = new queries.TerminalQuerier({ write: () => true } as unknown as NodeJS.WriteStream)
  const result = querier.send(queries.programStatusQuery())
  const flushed = querier.flush()
  querier.onResponse({ type: 'da1', params: [62] })
  querier.onResponse({ type: 'osc', code: 7501, data: '?' })
  expect(await result).toBeUndefined()
  await flushed
})

function capability(code: string, extraEnv: Record<string, string> = {}) {
  const source = `import * as s from ${JSON.stringify(new URL('./terminal.ts', import.meta.url).pathname)}; ${code}`
  const child = Bun.spawnSync([process.execPath, '--eval', source], {
    env: { ...process.env, CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '', CLAUDE_CODE_SESSION_KIND: '', ...extraEnv },
  })
  expect(child.exitCode, child.stderr.toString()).toBe(0)
  return JSON.parse(child.stdout.toString())
}

test('capability starts pending, notifies once, and cannot be re-enabled after DA1 refusal', () => {
  expect(capability(`let calls=0; const initial=s.getProgramStatusSupport(); const stop=s.subscribeProgramStatusSupport(()=>calls++); s.settleProgramStatusSupport(false); s.settleProgramStatusSupport(true); stop(); console.log(JSON.stringify({initial, final:s.getProgramStatusSupport(), calls}))`)).toEqual({ initial: 'pending', final: 'off', calls: 1 })
  expect(capability(`s.settleProgramStatusSupport(true); console.log(JSON.stringify(s.getProgramStatusSupport()))`)).toBe('on')
})

test('title disable switch and background workers begin off and cannot be enabled by a reply', () => {
  for (const extra of [{ CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }, { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: 'true' }, { CLAUDE_CODE_SESSION_KIND: 'bg' }]) {
    expect(capability(`s.settleProgramStatusSupport(true); console.log(JSON.stringify(s.getProgramStatusSupport()))`, extra)).toBe('off')
  }
})
