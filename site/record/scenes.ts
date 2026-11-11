// The tour scenes recorded by record.ts: fixture project, what gets typed, and the model's script.
import type { Lang } from '../src/demos/i18n'
import type { Block, Script } from './api'

// One thing typed into the terminal: text (followed by Enter) or keys sent together (a chord like `C-x Tab`), then wait until the
// screen settles, or until `wait` matches when the CLI is expected to stay busy.
export type Input = { text: string } | { key: string } | { pause: number }
// `pane` sends the input to that pane of a split scene.
export type Step = Input & { wait?: RegExp; pane?: number }

export type SceneDef = {
  fixture: Record<string, string>
  // Extra environment and ~/.claude.json fields for this scene.
  env?: string[]
  config?: Record<string, unknown>
  allow: string[]
  // Copied from the repo into the fixture project, e.g. a mod.
  copy?: Record<string, string>
  // Start in a shell and launch `claude` by typing this, instead of starting the CLI directly.
  shell?: string
  // Run these CLIs stacked in one window instead, each pane labelled and optionally in its own copy of the
  // fixture under ~/projects; `size` is the window's cols and rows.
  panes?: { label: string; command: string; project?: string }[]
  size?: [number, number]
  // Needs a real ChatGPT sign-in: CODEX_AUTH_FILE (a ~/.codex/auth.json) is lent to the run and written back after.
  chatgpt?: boolean
  inputs: Record<Lang, Step[]>
  script: (lang: Lang, dir: string) => Script
}

const L = (lang: Lang, en: string, zh: string, hans: string) => ({ en, zh, hans })[lang]
const text = (t: string): Block => ({ type: 'text', text: t })
const tool = (name: string, input: unknown): Block => ({ type: 'tool_use', name, input })

const PARSER = `export type Query = { terms: string[]; phrases: string[]; exclude: string[] }

export function parseQuery(input: string): Query {
  const q: Query = { terms: [], phrases: [], exclude: [] }
  const re = /"([^"]*)"|(\\S+)/g
  for (const m of input.matchAll(re)) {
    if (m[1] !== undefined) q.phrases.push(m[1])
    else q.terms.push(m[2])
  }
  return q
}
`
const PARSER_TEST = `import { expect, test } from 'bun:test'
import { parseQuery } from '../src/parser'

test('splits terms', () => expect(parseQuery('red fox').terms).toEqual(['red', 'fox']))
test('reads phrases', () => expect(parseQuery('"red fox" den').phrases).toEqual(['red fox']))
test('keeps other terms', () => expect(parseQuery('"red fox" den').terms).toEqual(['den']))
test('excludes -terms', () => expect(parseQuery('fox -dog').exclude).toEqual(['dog']))
test('-terms are not terms', () => expect(parseQuery('fox -dog').terms).toEqual(['fox']))
test('lowercases terms', () => expect(parseQuery('Red FOX').terms).toEqual(['red', 'fox']))
`
const PROJECT = {
  'package.json': '{ "name": "search-demo", "private": true, "type": "module", "scripts": { "test": "bun test" } }\n',
  'src/parser.ts': PARSER,
  'test/parser.test.ts': PARSER_TEST,
}

const goal: SceneDef = {
  fixture: PROJECT,
  allow: ['Bash(bun test)', 'Edit', 'Read'],
  inputs: {
    en: [{ text: 'the parser tests keep failing. Keep fixing until every test passes' }],
    zh: [{ text: 'parser 的測試一直掛，幫我修到全部測試通過為止' }],
    hans: [{ text: 'parser 的测试一直挂，帮我修到全部测试通过为止' }],
  },
  script: (lang, dir) => {
    const file = `${dir}/src/parser.ts`
    const test = tool('Bash', { command: 'bun test', description: 'Run the test suite' })
    const steps: Block[][] = [
      [text(L(lang, "I'll set a goal so I keep going until the whole suite is green.", '我先設定目標，持續修到整個測試套件全綠為止。', '我先设定目标，持续修到整个测试套件全绿为止。')), tool('Goal', { action: 'set', goal: 'every test in `bun test` passes' })],
      [test],
      [tool('Read', { file_path: file })],
      [
        text(L(lang, '`-dog` is parsed as a term. Routing `-` prefixed words to `exclude`.', '`-dog` 被當成一般詞。把 `-` 開頭的詞改放進 `exclude`。', '`-dog` 被当成普通词。把 `-` 开头的词改放进 `exclude`。')),
        tool('Edit', { file_path: file, old_string: '    else q.terms.push(m[2])', new_string: "    else if (m[2].startsWith('-')) q.exclude.push(m[2].slice(1))\n    else q.terms.push(m[2])" }),
      ],
      [test],
      // Ends the turn early on purpose, so the Goal stop hook sends Claude back to work.
      [text(L(lang, 'Fixed `-term` exclusion; both exclude tests pass now.', '`-term` 排除已修好，兩個 exclude 測試都通過了。', '`-term` 排除已修好，两个 exclude 测试都通过了。'))],
      [text(L(lang, 'One test is still red: terms must be lowercased.', '還有一個沒過：詞要轉成小寫。', '还有一个没过：词要转成小写。')), tool('Edit', { file_path: file, old_string: '    else q.terms.push(m[2])', new_string: '    else q.terms.push(m[2].toLowerCase())' })],
      [test],
      [text(L(lang, 'All 6 tests pass: `-term` exclusion and lowercasing are fixed in `src/parser.ts`.', '6 個測試全部通過：`src/parser.ts` 修好了 `-term` 排除和小寫轉換。', '6 个测试全部通过：`src/parser.ts` 修好了 `-term` 排除和小写转换。'))],
    ]
    let hookCalls = 0
    return {
      steps: ({ turn }) => steps[Math.min(turn, steps.length - 1)],
      // The Goal stop-hook evaluator fails once, then passes.
      side: (_, system) => {
        if (!system.includes('stop-condition hook')) return undefined
        hookCalls++
        return JSON.stringify(hookCalls === 1 ? { ok: false, reason: '1 test still fails: lowercases terms' } : { ok: true, reason: '6 pass, 0 fail' })
      },
    }
  },
}

const tmux: SceneDef = {
  fixture: PROJECT,
  allow: ['Tmux'],
  inputs: {
    en: [{ text: 'open a python REPL and compute 2**64' }],
    zh: [{ text: '開一個 python REPL，算 2**64' }],
    hans: [{ text: '开一个 python REPL，算 2**64' }],
  },
  script: lang => {
    let target = ''
    return {
      steps: ({ turn, lastResult }) => {
        // The CLI answers new-session with the pane id to use from then on.
        if (turn === 1) target = /"target":"([^"]+)"/.exec(lastResult)?.[1] ?? ''
        const steps: Block[][] = [
          [tool('Tmux', { action: 'new-session', command: 'python3' })],
          [tool('Tmux', { action: 'send-keys', target, text: '2**64', enter: true })],
          [tool('Tmux', { action: 'capture-pane', target })],
          [tool('Tmux', { action: 'kill-pane', target })],
          [text(L(lang, '2**64 = 18446744073709551616. The REPL is closed.', '2**64 = 18446744073709551616，REPL 已關閉。', '2**64 = 18446744073709551616，REPL 已关闭。'))],
        ]
        return steps[Math.min(turn, steps.length - 1)]
      },
    }
  },
}

const mods: SceneDef = {
  fixture: { ...PROJECT, 'build/a.js': 'a\n', 'build/b.js': 'b\n', 'build/c.js': 'c\n' },
  allow: ['Bash(rm -rf build)'],
  copy: { 'mods/blast-radius': '../examples/mods/blast-radius' },
  shell: 'claude --plugin-dir ./mods/blast-radius',
  inputs: {
    en: [{ text: 'clear the build directory', wait: /Proceed/ }, { pause: 2500 }, { key: 'C-x Tab' }, { pause: 1200 }, { key: 'Space', wait: /gone|已清掉/ }],
    zh: [{ text: '清掉 build 目錄', wait: /Proceed/ }, { pause: 2500 }, { key: 'C-x Tab' }, { pause: 1200 }, { key: 'Space', wait: /gone|已清掉/ }],
    hans: [{ text: '清掉 build 目录', wait: /Proceed/ }, { pause: 2500 }, { key: 'C-x Tab' }, { pause: 1200 }, { key: 'Space', wait: /gone|已清掉/ }],
  },
  script: lang => ({
    steps: ({ turn }) =>
      turn === 0
        ? [tool('Bash', { command: 'rm -rf build', description: 'Remove the build directory' })]
        : [text(L(lang, 'The build directory is gone.', 'build 目錄已清掉。', 'build 目录已清掉。'))],
  }),
}

const context: SceneDef = {
  fixture: PROJECT,
  allow: ['Read'],
  inputs: {
    en: [{ text: '/context-window 200k' }, { text: 'what does src/parser.ts do?' }, { text: '/context' }, { text: '/compact' }],
    zh: [{ text: '/context-window 200k' }, { text: 'src/parser.ts 是做什麼的？' }, { text: '/context' }, { text: '/compact' }],
    hans: [{ text: '/context-window 200k' }, { text: 'src/parser.ts 是做什么的？' }, { text: '/context' }, { text: '/compact' }],
  },
  script: (lang, dir) => ({
    steps: ({ turn }) =>
      turn === 0
        ? [tool('Read', { file_path: `${dir}/src/parser.ts` })]
        : [
            text(
              L(
                lang,
                '`parseQuery` splits a search string into quoted phrases and plain terms.',
                '`parseQuery` 把搜尋字串拆成引號片語和一般詞。',
                '`parseQuery` 把搜索字符串拆成引号短语和普通词。',
              ),
            ),
          ],
    side: body => (JSON.stringify(body.messages).includes('summary') ? '<summary>The user asked what src/parser.ts does; parseQuery splits a search string into phrases and terms.</summary>' : undefined),
  }),
}

const MATES = ['coder', 'tester', 'writer'] as const

const teams: SceneDef = {
  fixture: PROJECT,
  allow: ['Read'],
  env: ['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1'],
  config: { teammateMode: 'in-process' },
  inputs: {
    en: [{ text: 'form a team of three: code, tests, docs. Name each one', wait: /Team done|團隊完成|团队完成/ }],
    zh: [{ text: '組一個三人團隊：程式、測試、文件，每人取名', wait: /Team done|團隊完成|团队完成/ }],
    hans: [{ text: '组一个三人团队：代码、测试、文档，每人取名', wait: /Team done|團隊完成|团队完成/ }],
  },
  script: lang => {
    const task = {
      coder: L(lang, 'Fix `-term` exclusion in src/parser.ts', '修好 src/parser.ts 的 `-term` 排除', '修好 src/parser.ts 的 `-term` 排除'),
      tester: L(lang, 'Add tests for parseQuery', '幫 parseQuery 補測試', '给 parseQuery 补测试'),
      writer: L(lang, 'Draft CHANGES.md for this fix', '寫這次修正的 CHANGES.md', '写这次修正的 CHANGES.md'),
    }
    const report = {
      coder: L(lang, 'src/parser.ts now routes -terms to exclude', 'src/parser.ts 已把 -詞 放進 exclude', 'src/parser.ts 已把 -词 放进 exclude'),
      tester: L(lang, '9 new tests, all green', '新增 9 個測試，全部通過', '新增 9 个测试，全部通过'),
      writer: L(lang, 'CHANGES.md drafted', 'CHANGES.md 已完成', 'CHANGES.md 已完成'),
    }
    return {
      steps: ({ turn, first, body }) => {
        const mate = MATES.find(m => first.includes(task[m]))
        // A teammate's last reply reaches the lead as its finish notice.
        if (mate) return [text(report[mate])]
        // The session has one implicit team: naming the agents makes them teammates.
        if (turn === 0) return [text(L(lang, 'Spawning coder, tester and writer.', '拉起 coder、tester、writer 三個隊友。', '拉起 coder、tester、writer 三个队友。')), ...MATES.map(m => tool('Agent', { name: m, description: task[m], prompt: task[m] }))]
        const all = JSON.stringify(body.messages)
        const done = MATES.filter(m => all.includes(report[m]))
        if (done.length === MATES.length)
          return [text(L(lang, 'Team done: parser fixed, 9 tests added, CHANGES.md drafted.', '團隊完成：parser 已修好、補了 9 個測試、CHANGES.md 寫好了。', '团队完成：parser 已修好、补了 9 个测试、CHANGES.md 写好了。'))]
        return [text(L(lang, `${done.join(', ') || '…'} reported; waiting on the rest.`, `${done.join('、') || '…'} 已回報，等其他人。`, `${done.join('、') || '…'} 已回报，等其他人。`))]
      },
    }
  },
}

// Two CLIs opened in the same project talk through their local inboxes (`/peers`, `SendMessage`).
const peers: SceneDef = {
  fixture: PROJECT,
  allow: ['Read', 'SendMessage'],
  size: [116, 32],
  panes: [
    { label: 'builder', command: 'claude --name builder' },
    { label: 'reviewer', command: 'claude --name reviewer' },
  ],
  inputs: {
    en: [{ text: '/peers', pane: 0 }, { pause: 1500 }, { key: 'Escape', pane: 0 }, { text: 'tests pass now. Ask reviewer to check the parser fix', pane: 0, wait: /reviewer approved/ }],
    zh: [{ text: '/peers', pane: 0 }, { pause: 1500 }, { key: 'Escape', pane: 0 }, { text: '測試過了，請 reviewer 看一下 parser 的修正', pane: 0, wait: /reviewer 已核准/ }],
    hans: [{ text: '/peers', pane: 0 }, { pause: 1500 }, { key: 'Escape', pane: 0 }, { text: '测试过了，请 reviewer 看一下 parser 的修正', pane: 0, wait: /reviewer 已批准/ }],
  },
  script: (lang, dir) => {
    const ask = L(lang, 'Tests are green. Please review src/parser.ts (the -term exclusion).', '測試全綠了，請 review src/parser.ts（-term 排除）。', '测试全绿了，请 review src/parser.ts（-term 排除）。')
    const reply = L(lang, 'LGTM: -terms go to exclude and stay out of terms.', 'LGTM：-詞進 exclude，不再混進 terms。', 'LGTM：-词进 exclude，不再混进 terms。')
    const builder: Block[][] = [
      [text(L(lang, 'Asking reviewer.', '請 reviewer 看。', '请 reviewer 看。')), tool('SendMessage', { to: 'reviewer', summary: 'review parser fix', message: ask })],
      [text(L(lang, "Sent to reviewer's inbox.", '已送進 reviewer 的收件匣。', '已送进 reviewer 的收件箱。'))],
      [text(L(lang, 'reviewer approved the parser fix.', 'reviewer 已核准 parser 的修正。', 'reviewer 已批准 parser 的修正。'))],
    ]
    const reviewer: Block[][] = [
      [tool('Read', { file_path: `${dir}/src/parser.ts` })],
      [text(L(lang, 'The fix looks right.', '修正沒問題。', '修正没问题。')), tool('SendMessage', { to: 'builder', summary: 'LGTM', message: reply })],
      [text(L(lang, 'Replied to builder.', '已回覆 builder。', '已回复 builder。'))],
    ]
    return {
      steps: ({ turn, first }) => {
        const steps = first.includes(ask) ? reviewer : builder
        return steps[Math.min(turn, steps.length - 1)]
      },
    }
  },
}

// The same task on a Claude account (scripted model) and a ChatGPT account (real model through the sign-in).
const accounts: SceneDef = {
  fixture: {
    'package.json': '{ "name": "search-demo", "private": true, "type": "module", "scripts": { "test": "bun test" } }\n',
    'src/config.ts': 'export const TOP_K = 10\n',
    'test/config.test.ts': "import { expect, test } from 'bun:test'\nimport { TOP_K } from '../src/config'\n\ntest('returns the top 20 hits', () => expect(TOP_K).toBe(20))\n",
  },
  // The real model picks its own shell commands in a throwaway copy, so any Bash is allowed here.
  allow: ['Bash', 'Edit', 'Read'],
  chatgpt: true,
  size: [116, 32],
  panes: [
    { label: 'Claude', command: 'claude --model claude-sonnet-5-5' },
    { label: 'ChatGPT', command: 'env CLAUDE_CODE_USE_OPENAI=1 claude', project: 'search-demo-gpt' },
  ],
  inputs: {
    en: [
      { text: 'set TOP_K to 20 in src/config.ts and run the tests', pane: 0, wait: /esc to interrupt/ },
      { text: 'set TOP_K to 20 in src/config.ts and run the tests', pane: 1 },
    ],
    zh: [
      { text: '把 src/config.ts 的 TOP_K 改成 20，再跑測試', pane: 0, wait: /esc to interrupt/ },
      { text: '把 src/config.ts 的 TOP_K 改成 20，再跑測試', pane: 1 },
    ],
    hans: [
      { text: '把 src/config.ts 的 TOP_K 改成 20，再跑测试', pane: 0, wait: /esc to interrupt/ },
      { text: '把 src/config.ts 的 TOP_K 改成 20，再跑测试', pane: 1 },
    ],
  },
  script: (lang, dir) => {
    const file = `${dir}/src/config.ts`
    const steps: Block[][] = [
      [tool('Read', { file_path: file })],
      [tool('Edit', { file_path: file, old_string: 'TOP_K = 10', new_string: 'TOP_K = 20' })],
      [tool('Bash', { command: 'bun test', description: 'Run the tests' })],
      [text(L(lang, 'TOP_K is 20 now and the test passes.', 'TOP_K 已改成 20，測試通過。', 'TOP_K 已改成 20，测试通过。'))],
    ]
    return { steps: ({ turn }) => steps[Math.min(turn, steps.length - 1)] }
  },
}

export const SCENES = { accounts, goal, tmux, mods, context, teams, peers }
