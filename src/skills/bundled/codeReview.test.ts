import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { afterEach, test } from 'bun:test'

import { setPrintOutputFormat } from '../../bootstrap/state.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  getPromptCommandContext,
  getPromptCommandEffort,
  resolveSubcommand,
} from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { clearBundledSkills, getBundledSkills } from '../bundledSkills.js'
import {
  formatCodeReviewResult,
  parseReviewArgs,
  registerCodeReviewSkill,
} from './codeReview.js'
import {
  renderReviewCell,
  type ReviewCell,
  SIMPLIFY_FAN_OUT,
  SIMPLIFY_INLINE,
} from './codeReviewContent.js'
import { registerSimplifySkill } from './simplify.js'

afterEach(() => {
  clearBundledSkills()
  setPrintOutputFormat(undefined)
  saveGlobalConfig(config => ({
    ...config,
    codeReviewLastEffort: undefined,
    codeReviewLastMaxFindings: undefined,
  }))
})

function skill(name: string) {
  clearBundledSkills()
  registerCodeReviewSkill()
  registerSimplifySkill()
  const command = getBundledSkills().find(c => c.name === name)
  assert.ok(command && command.type === 'prompt')
  return command
}

function context(model: string, tools = ['Agent', 'Read']): ToolUseContext {
  return {
    options: {
      mainLoopModel: model,
      tools: tools.map(name => ({ name })),
      commands: [],
    },
    getAppState: () => ({ effortValue: undefined }),
  } as unknown as ToolUseContext
}

async function promptText(args: string, ctx: ToolUseContext): Promise<string> {
  const blocks = await skill('code-review').getPromptForCommand(args, ctx)
  assert.equal(blocks.length, 1)
  return (blocks[0] as { text: string }).text
}

test('every review cell and /simplify prompt renders exactly as official 2.1.311', () => {
  const cells: ReviewCell[] = [
    'low', 'low-sonnet5', 'medium', 'high', 'xhigh', 'max',
    'o48-low-v1', 'o48-med-v1', 'o48-high-v1', 'o48-xhigh-v1', 'o5-bmin',
  ]
  const renders: string[] = []
  for (const cell of cells) {
    for (const agent of [true, false]) {
      for (const cap of [undefined, 1, 3, 32, 'all'] as const) {
        renders.push(renderReviewCell(cell, agent, cap))
      }
    }
  }
  renders.push(SIMPLIFY_FAN_OUT, SIMPLIFY_INLINE)
  // Digest of the same renders produced by the official 2.1.311 bundle.
  assert.equal(
    createHash('sha256').update(renders.join('\u0000')).digest('hex'),
    '2cfe354ac8de64e041fdb71bab5e997b6dda10bf357ea42076af858edb1139c6',
  )
})

test('/code-review registers like official, with /review as an alias', () => {
  const command = skill('code-review')
  assert.deepEqual(command.aliases, ['review'])
  assert.deepEqual(command.subcommands, { ultra: 'ultrareview' })
  assert.equal(command.userInvocable, true)
  assert.equal(
    command.argumentHint,
    '[low|medium|high|xhigh|max] [--fix] [--comment] [<pr#>|<branch>|<path>] [--max-findings <n>|all]',
  )
  assert.match(command.description, /^Review the current diff, or a PR number\/branch\/path target/)
  assert.match(command.whenToUse ?? '', /^Use the max level only when the user/)
  assert.equal(getPromptCommandContext(command, '', context('claude-opus-4-8')), 'fork')
})

test('arguments parse like official', () => {
  assert.deepEqual(parseReviewArgs('high #123 --comment'), {
    explicit: 'high', target: '123', comment: true, fix: false, post: false,
    unrecognizedLevel: undefined, ultraFallback: false,
    maxFindings: undefined, maxFindingsIgnored: false,
  })
  assert.equal(parseReviewArgs('med').explicit, 'medium')
  assert.equal(parseReviewArgs('hgih src/x.ts').unrecognizedLevel, undefined)
  assert.equal(parseReviewArgs('highest src/x.ts').unrecognizedLevel, 'highest')
  assert.equal(parseReviewArgs('highest src/x.ts').target, 'highest src/x.ts')
  const ultra = parseReviewArgs('ultra --fix feature-branch')
  assert.equal(ultra.ultraFallback, true)
  assert.equal(ultra.fix, true)
  assert.equal(ultra.target, 'feature-branch')
  assert.equal(parseReviewArgs('--max-findings 5 low').maxFindings, 5)
  assert.equal(parseReviewArgs('low --max-findings=all').maxFindings, 'all')
  const bad = parseReviewArgs('low --max-findings zero')
  assert.equal(bad.maxFindings, undefined)
  assert.equal(bad.maxFindingsIgnored, true)
  assert.equal(parseReviewArgs('`#42`').target, '42')
})

test('the prompt picks the official cell for the model family and level', async () => {
  assert.equal(
    await promptText('low', context('claude-opus-4-8')),
    renderReviewCell('o48-low-v1', true, undefined),
  )
  assert.equal(
    await promptText('high', context('claude-opus-5[1m]')),
    renderReviewCell('o5-bmin', true, undefined),
  )
  assert.equal(
    await promptText('medium', context('claude-opus-5-5')),
    renderReviewCell('o48-high-v1', true, undefined),
  )
  assert.equal(
    await promptText('medium', context('claude-sonnet-5', ['Read'])),
    renderReviewCell('medium', false, undefined),
  )
})

test('target, --comment, --fix and --max-findings shape the prompt', async () => {
  const text = await promptText(
    'low 42 --comment --fix --max-findings 3',
    context('claude-opus-4-8'),
  )
  assert.ok(text.startsWith('Review target: `42`\n\n'))
  assert.ok(text.includes(renderReviewCell('o48-low-v1', true, 3)))
  assert.match(text, /## Posting to GitHub \(--comment\)/)
  assert.match(text, /## Applying fixes \(--fix\)/)
  const capped = await promptText('high --max-findings all', context('claude-opus-5'))
  assert.match(capped, /^\(This review reports at most 32 findings, so the limit is 32 here\. Open your report/)
  assert.ok(capped.includes(renderReviewCell('o5-bmin', true, 32)))
})

test('ultra without cloud access falls back to a local max review', async () => {
  const text = await promptText('ultra', context('claude-opus-4-8'))
  assert.ok(
    text.startsWith(
      "(ultra (cloud review) isn't available in this environment — see https://code.claude.com/docs/en/ultrareview. Falling back to a local max-effort review.)\n\n",
    ),
  )
  assert.ok(text.endsWith(renderReviewCell('max', true, undefined)))
})

test('typed levels and --max-findings persist and are reused with a notice', async () => {
  const command = skill('code-review')
  const ctx = context('claude-sonnet-5')
  command.onUserTypedArgs?.('low --max-findings 7', ctx)
  assert.equal(getGlobalConfig().codeReviewLastEffort, 'low')
  assert.equal(getGlobalConfig().codeReviewLastMaxFindings, 7)
  // sonnet-5 low runs the model at medium effort.
  assert.equal(command.getEffort?.('low', ctx), 'medium')
  assert.equal(command.getEffort?.('', ctx), undefined)
  const fallback = command.getDefaultEffort?.('', ctx)
  assert.equal(fallback?.value, 'medium')
  assert.equal(
    fallback?.notice,
    'Reusing low effort, the level you typed last time. Type a level like `/code-review high` to change it.',
  )
  assert.equal(
    command.getDefaultEffort?.('', context('claude-opus-4-8'))?.notice,
    'Reusing low effort, the level you typed last time. Type a level like `/code-review high` to change it. Reporting up to 7 findings, the limit you set last time with `--max-findings`. Pass `--max-findings default` to go back to the usual limit.',
  )
  assert.equal(getPromptCommandEffort(command, '', ctx), 'medium')
  const text = await promptText('', context('claude-opus-4-8'))
  assert.ok(
    text.startsWith(
      '(No effort level given — reusing low, the level the user typed last time. Open your report with one short line telling the user this, and that typing a level (for example `/code-review high`) changes it; that opening line reaches them with the findings.)\n\n(Reporting up to 7 findings, the limit the user set last time with `--max-findings`. Open your report with one short line telling the user this, and that passing `--max-findings default` goes back to the usual limit; that opening line reaches them with the findings.)\n\n',
    ),
  )
  assert.ok(text.endsWith(renderReviewCell('o48-low-v1', true, 7)))
  command.onUserTypedArgs?.('--max-findings default', ctx)
  assert.equal(getGlobalConfig().codeReviewLastMaxFindings, undefined)
})

test('the forked JSON result is formatted unless print output is text or json', () => {
  const json = JSON.stringify([
    { file: 'a.ts', line: 3, summary: 'off by one', failure_scenario: 'n=0\ncrashes' },
    { file: 'b.ts', summary: 'bell \u0007 here' },
  ])
  setPrintOutputFormat('text')
  assert.equal(formatCodeReviewResult(json), json)
  setPrintOutputFormat('json')
  assert.equal(formatCodeReviewResult(json), json)
  const formatted =
    '2 findings, most severe first:\n\n1. `a.ts:3`: off by one\n\n   Failure scenario: n=0\n   crashes\n\n2. `b.ts`: bell ␇ here'
  setPrintOutputFormat('stream-json')
  assert.equal(formatCodeReviewResult(json), formatted)
  // Interactive sessions have no print output format and are formatted too.
  setPrintOutputFormat(undefined)
  assert.equal(formatCodeReviewResult(json), formatted)
  assert.equal(formatCodeReviewResult('Done.\n```json\n[]\n```\n'), 'Done.\nNo findings.\n')
  assert.equal(formatCodeReviewResult('not json'), 'not json')
})

test('/code-review ultra resolves to the ultrareview subcommand', () => {
  const command = skill('code-review')
  assert.deepEqual(resolveSubcommand(command, 'ULTRA  --fix 12'), {
    targetName: 'ultrareview',
    consumedToken: 'ULTRA',
    remainingArgs: '--fix 12',
  })
  assert.equal(resolveSubcommand(command, 'high'), undefined)
})

test('/simplify uses the official fan-out or the inline fallback', async () => {
  const command = skill('simplify')
  assert.equal(
    command.description,
    'Review the changed code for reuse, simplification, efficiency, and altitude cleanups, then apply the fixes. Quality only — it does not hunt for bugs; use /code-review for that.',
  )
  assert.equal(command.argumentHint, '[<target>]')
  assert.deepEqual(await command.getPromptForCommand(' src/a.ts ', context('claude-opus-4-8')), [
    { type: 'text', text: `Review target: \`src/a.ts\`\n\n${SIMPLIFY_FAN_OUT}` },
  ])
  assert.deepEqual(await command.getPromptForCommand('', context('claude-opus-4-8', ['Read'])), [
    { type: 'text', text: SIMPLIFY_INLINE },
  ])
})
