import { z } from 'zod/v4'
import { isUltrareviewEnabled } from '../../commands/review/ultrareviewEnabled.js'
import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js'
import type { ToolUseContext } from '../../Tool.js'
import { toolMatchesName } from '../../Tool.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import {
  getCurrentSubagentDepth,
  MAX_SUBAGENT_DEPTH,
} from '../../tools/AgentTool/subagentDepth.js'
import { getPrintOutputFormat } from '../../bootstrap/state.js'
import { isCommandEnabled } from '../../types/command.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { detectCurrentRepositoryWithHost } from '../../utils/detectRepository.js'
import {
  type EffortValue,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  modelSupportsXHighEffort,
  resolveAppliedEffort,
} from '../../utils/effort.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { gitExe } from '../../utils/git.js'
import { safeParseJSON } from '../../utils/json.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getCanonicalName } from '../../utils/model/model.js'
import { plural } from '../../utils/stringUtils.js'
import { registerBundledSkill } from '../bundledSkills.js'
import {
  type FindingsCap,
  renderReviewCell,
  type ReviewCell,
} from './codeReviewContent.js'

// Port of official 2.1.311 /code-review without the ReportFindings variants:
// the review always runs as a fork that returns a JSON array of findings.

const REVIEW_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
type ReviewLevel = (typeof REVIEW_LEVELS)[number]
const LEVEL_ALIASES: Record<string, ReviewLevel> = { med: 'medium' }
const LEVEL_TYPO = new RegExp(
  `^(${REVIEW_LEVELS.map(level => level.slice(0, 3)).join('|')})[a-z]*$`,
  'i',
)
const MAX_FINDINGS_FLAG =
  /(^|\s)--max-findings(?:(?:\s*=\s*|\s+)(?!--)(\S+)|\s*=\S*)?(?=\s|$)/g
const FINDINGS_HARD_CAP = 32

function isReviewLevel(value: unknown): value is ReviewLevel {
  return (REVIEW_LEVELS as readonly unknown[]).includes(value)
}

function parseReviewLevel(token: string): ReviewLevel | undefined {
  const lower = token.trim().toLowerCase()
  const level = LEVEL_ALIASES[lower] ?? lower
  return isReviewLevel(level) ? level : undefined
}

type ReviewCellConfig = {
  cell: ReviewCell
  modelEffort: 'typed' | ReviewLevel
  finderBudgetHint: boolean
  measuredExternal?: boolean
}
type ModelFamily =
  | 'default'
  | 'claude-sonnet-5'
  | 'claude-opus-4-8'
  | 'claude-opus-5'

const typedCell = (cell: ReviewCell): ReviewCellConfig => ({
  cell,
  modelEffort: 'typed',
  finderBudgetHint: false,
})
const measured = (cell: ReviewCell): ReviewCellConfig => ({
  ...typedCell(cell),
  measuredExternal: true,
})
const DEFAULT_CELLS: Record<ReviewLevel, ReviewCellConfig> = {
  low: typedCell('low'),
  medium: measured('o48-high-v1'),
  high: measured('o48-high-v1'),
  xhigh: measured('o48-xhigh-v1'),
  max: typedCell('max'),
}
const REVIEW_CELLS: Record<
  ModelFamily,
  Record<ReviewLevel, ReviewCellConfig>
> = {
  default: DEFAULT_CELLS,
  'claude-sonnet-5': {
    low: {
      cell: 'low-sonnet5',
      modelEffort: 'medium',
      finderBudgetHint: false,
    },
    medium: typedCell('medium'),
    high: { ...typedCell('high'), finderBudgetHint: true },
    xhigh: { ...typedCell('xhigh'), finderBudgetHint: true },
    max: { ...typedCell('max'), finderBudgetHint: true },
  },
  'claude-opus-4-8': {
    low: measured('o48-low-v1'),
    medium: measured('o48-med-v1'),
    high: measured('o48-high-v1'),
    xhigh: measured('o48-xhigh-v1'),
    max: typedCell('max'),
  },
  'claude-opus-5': {
    ...DEFAULT_CELLS,
    medium: measured('o5-bmin'),
    high: measured('o5-bmin'),
  },
}
// Skill preloads of these families use the default table.
const PRELOAD_DEFAULT_FAMILIES = new Set<ModelFamily>([
  'claude-opus-4-8',
  'claude-opus-5',
])

function getModelFamily(model: string | undefined): ModelFamily {
  const canonical = model ? getCanonicalName(model) : undefined
  return canonical !== undefined && Object.hasOwn(REVIEW_CELLS, canonical)
    ? (canonical as ModelFamily)
    : 'default'
}

function getMainLoopModel(
  context: ToolUseContext | undefined,
): string | undefined {
  return context?.options ? context.options.mainLoopModel : undefined
}

function getModelEffort(family: ModelFamily, level: ReviewLevel): ReviewLevel {
  const { modelEffort } = REVIEW_CELLS[family][level]
  return modelEffort === 'typed' ? level : modelEffort
}

function isSkillPreload(context: ToolUseContext | undefined): boolean {
  return (
    (context?.options as { isSkillPreload?: boolean } | undefined)
      ?.isSkillPreload === true
  )
}

export function canSpawnAgents(context: ToolUseContext): boolean {
  if (getCurrentSubagentDepth(context.options) >= MAX_SUBAGENT_DEPTH)
    return false
  const tools = context.options?.tools
  if (!tools) return true
  return tools.some(tool => toolMatchesName(tool, AGENT_TOOL_NAME))
}

// Official reads two gates: the cloud review being offered at all, and the
// session having the claude.ai account access it needs.
function isUltraOffered(): boolean {
  return isUltrareviewEnabled()
}

function isUltraAvailable(): boolean {
  return isUltraOffered() && isClaudeAISubscriber()
}

function removeFlags(
  args: string,
  names: string[],
): { rawFirstToken: string; flags: Set<string>; rest: string } {
  const trimmed = args.trim()
  const rawFirstToken = trimmed.split(/\s+/, 1)[0] ?? ''
  const flags = new Set<string>()
  let rest = trimmed
  for (const name of names) {
    const next = rest.replace(
      new RegExp(`(?:^|\\s)--${name}(?=\\s|$)`, 'g'),
      '',
    )
    if (next !== rest) {
      flags.add(name)
      rest = next.trim()
    }
  }
  return { rawFirstToken, flags, rest }
}

function joinTarget(tokens: string[]): string {
  const [first = '', ...rest] = tokens
  return [first.replaceAll('`', '').replace(/^#/, ''), ...rest]
    .filter(Boolean)
    .join(' ')
}

type MaxFindings = number | 'all' | 'default'
type ParsedReviewArgs = {
  explicit: ReviewLevel | undefined
  target: string
  comment: boolean
  fix: boolean
  post: boolean
  unrecognizedLevel: string | undefined
  ultraFallback: boolean
  maxFindings: MaxFindings | undefined
  maxFindingsIgnored: boolean
}

export function parseReviewArgs(args: string): ParsedReviewArgs {
  const { rawFirstToken } = removeFlags(args, [])
  const { flags, rest } = removeFlags(args.replace(MAX_FINDINGS_FLAG, '$1'), [
    'comment',
    'fix',
    'post',
    'no-post',
  ])
  const lastMax = [...args.matchAll(MAX_FINDINGS_FLAG)].at(-1)
  const rawMax = lastMax ? (lastMax[2] ?? '').toLowerCase() : undefined
  const count =
    rawMax !== undefined && /^\d+$/.test(rawMax) ? Number(rawMax) : 0
  const maxFindings: MaxFindings | undefined =
    rawMax === 'all' || rawMax === 'default'
      ? rawMax
      : Number.isSafeInteger(count) && count > 0
        ? count
        : undefined
  const tokens = rest.split(/\s+/).filter(Boolean)
  const first = tokens[0] ?? ''
  const common = {
    comment: flags.has('comment'),
    fix: flags.has('fix'),
    post: flags.has('post'),
    maxFindings,
    maxFindingsIgnored: rawMax !== undefined && maxFindings === undefined,
  }
  if (rawFirstToken.toLowerCase() === 'ultra') {
    return {
      ...common,
      explicit: undefined,
      target: joinTarget(tokens.slice(1)),
      unrecognizedLevel: undefined,
      ultraFallback: true,
    }
  }
  const explicit =
    first.toLowerCase() === 'ultra' ? undefined : parseReviewLevel(first)
  if (explicit !== undefined) {
    return {
      ...common,
      explicit,
      target: joinTarget(tokens.slice(1)),
      unrecognizedLevel: undefined,
      ultraFallback: false,
    }
  }
  return {
    ...common,
    explicit: undefined,
    target: joinTarget(tokens),
    unrecognizedLevel: LEVEL_TYPO.test(first) ? first : undefined,
    ultraFallback: false,
  }
}

function getLastTypedLevel(): ReviewLevel | undefined {
  const level = getGlobalConfig().codeReviewLastEffort
  return isReviewLevel(level) ? level : undefined
}

function getLastUsedLevel(
  { explicit, ultraFallback }: ParsedReviewArgs,
  context: ToolUseContext | undefined,
): ReviewLevel | undefined {
  if (isSkillPreload(context)) return undefined
  return explicit === undefined && !ultraFallback
    ? getLastTypedLevel()
    : undefined
}

function toReviewLevel(value: EffortValue): ReviewLevel {
  return isReviewLevel(value) ? value : 'high'
}

// Official resolves the typed level like a turn effort for the main model:
// env override, then the typed level, then the session effort, then the
// model default, clamped to what the model supports.
function resolveReviewLevel(
  parsed: ParsedReviewArgs,
  context: ToolUseContext,
): ReviewLevel {
  const typed = parsed.ultraFallback
    ? 'max'
    : (parsed.explicit ?? getLastUsedLevel(parsed, context))
  const model = getMainLoopModel(context)
  const sessionEffort = context.getAppState().effortValue
  let resolved: EffortValue | undefined
  if (model) {
    if (modelSupportsEffort(model)) {
      resolved = resolveAppliedEffort(model, typed ?? sessionEffort)
      if (resolved === 'max' && !modelSupportsMaxEffort(model))
        resolved = 'high'
      if (resolved === 'xhigh' && !modelSupportsXHighEffort(model))
        resolved = 'high'
    }
    resolved ??= typed
  } else {
    resolved = typed ?? sessionEffort
  }
  return resolved === undefined ? 'medium' : toReviewLevel(resolved)
}

function resolveFindingsLimit(
  { maxFindings }: ParsedReviewArgs,
  cell: ReviewCell,
  context: ToolUseContext | undefined,
): {
  asked: FindingsCap | undefined
  stated: FindingsCap | undefined
  reused: boolean
} {
  const last = getGlobalConfig().codeReviewLastMaxFindings
  const reused =
    maxFindings === undefined &&
    cell !== 'low-sonnet5' &&
    !isSkillPreload(context) &&
    (last === 'all' ||
      (typeof last === 'number' && Number.isSafeInteger(last) && last > 0))
  const asked = reused
    ? last
    : maxFindings === 'default'
      ? undefined
      : maxFindings
  const stated =
    cell === 'low-sonnet5'
      ? undefined
      : cell === 'o5-bmin' &&
          (asked === 'all' ||
            (asked !== undefined && asked > FINDINGS_HARD_CAP))
        ? FINDINGS_HARD_CAP
        : asked
  return { asked, stated, reused }
}

function describeFindingsLimit(
  {
    asked,
    stated,
    reused,
    ignored,
  }: {
    asked: FindingsCap | undefined
    stated: FindingsCap | undefined
    reused: boolean
    ignored: boolean
  },
  who: 'you' | 'the user',
): string {
  const notes: string[] = []
  if (ignored) {
    notes.push(
      `\`--max-findings\` was ignored: type a whole number above zero, \`all\`, or \`default\` after it.${reused ? '' : ' Using the usual limit.'}`,
    )
  }
  const capped = `This review reports at most ${FINDINGS_HARD_CAP} findings, so the limit is ${FINDINGS_HARD_CAP} here.`
  if (asked !== undefined && stated === undefined) {
    notes.push(
      '`--max-findings` does not change this review: low effort here has no maximum.',
    )
  } else if (stated !== asked) {
    notes.push(
      reused
        ? `${who === 'you' ? 'You' : 'The user'} set \`--max-findings ${asked}\` last time. ${capped}`
        : capped,
    )
  } else if (reused && asked !== undefined) {
    notes.push(
      asked === 'all'
        ? `Reporting every finding, as ${who} chose last time with \`--max-findings all\`.`
        : `Reporting up to ${asked} ${plural(asked, 'finding')}, the limit ${who} set last time with \`--max-findings\`.`,
    )
  }
  return notes.join(' ')
}

function getDescription(): string {
  const ultra = isUltraOffered()
    ? `; ultra: deep multi-agent review in the cloud${isUltraAvailable() ? '' : ' (requires claude.ai account access)'}`
    : ''
  const post = isUltraOffered()
    ? ' For ultra on a GitHub.com PR target, --post asks to post the finished review’s findings to the PR as a single comment from the user’s GitHub account (not a review; the launch dialog still confirms in interactive sessions, while non-interactive mode posts on the flag alone) and --no-post hides that option.'
    : ''
  return `Review the current diff, or a PR number/branch/path target, for correctness bugs (plus reuse/simplification/efficiency cleanups where the model's recipe covers them) at the effort level given first, before any target (${REVIEW_LEVELS.join('|')}: from few high-confidence findings to many, some uncertain${ultra}); with no level given, it reuses the level you typed last. Pass --comment to post findings as inline PR comments, or --fix to apply them to the working tree after the review. Pass --max-findings <n> to report up to n findings, or --max-findings all for every finding. The choice stays until you pass --max-findings default.${post}`
}

function getWhenToUse(): string {
  return isUltraOffered()
    ? 'Use the max or ultra level only when the user, or instructions such as CLAUDE.md or a skill, explicitly ask for one, never on your own judgment: they are the costliest reviews and start many reviewer subagents.'
    : 'Use the max level only when the user, or instructions such as CLAUDE.md or a skill, explicitly ask for it, never on your own judgment: it is the costliest level and starts many reviewer subagents.'
}

function getArgumentHint(): string {
  const levels = isUltraOffered()
    ? `${REVIEW_LEVELS.join('|')}|ultra`
    : REVIEW_LEVELS.join('|')
  return `[${levels}] [--fix] [--comment] [<pr#>|<branch>|<path>] [--max-findings <n>|all]`
}

const GITHUB_COMMENT_SECTION = `

## Posting to GitHub (--comment)

The \`--comment\` flag was passed. After producing the findings list, if the
review target is a GitHub PR, post each finding as an inline PR comment via
\`mcp__github_inline_comment__create_inline_comment\` (one call per finding;
include a suggestion block only when it fully fixes the issue). If that tool
is not available in this session, fall back to \`gh api\` (repos/{owner}/{repo}/pulls/{pr}/comments)
or print the findings instead. If the target is not a PR, print the findings
to the terminal and note that \`--comment\` was ignored.
`

const GITLAB_MR_URL = /\/-\/merge_requests\/(\d+)/
const GITLAB_PROJECT_URL =
  /^(https?:\/\/[^\s/?#]+(?::\d{1,5})?\/(?:[^\s/?#]+\/)+[^\s/?#]+)\/-\/merge_requests\/\d/

async function isGitLabTarget(target: string): Promise<boolean> {
  if (
    /^https?:\/\/[^\s]+\/-\/merge_requests\/\d+/i.test(target) ||
    /^!\d+$/.test(target)
  ) {
    return true
  }
  if (/^https?:\/\//i.test(target)) return false
  const repository = await detectCurrentRepositoryWithHost()
  return repository !== null && repository.host.includes('gitlab')
}

function gitLabCommentSection(target: string): string {
  const raw =
    GITLAB_MR_URL.exec(target)?.[1] ?? target.replace(/^!(\d+)$/, '$1')
  const iid = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(raw) ? raw : ''
  const project = GITLAB_PROJECT_URL.exec(target)?.[1] ?? null
  const command = `glab mr note${iid ? ` ${iid}` : ''}${project ? ` -R ${project}` : ''} -m "<body>"`
  return `

## Posting to GitLab (--comment)

The \`--comment\` flag was passed. After producing the findings list, if the
review target is a GitLab merge request, post the findings as one general MR
note via \`${command}\`${project ? '' : " from inside that project's checkout"}
(every finding with its file:line, the issue, and the suggested fix). glab has no single verb for line-anchored
comments; those require \`glab api projects/:id/merge_requests/:iid/discussions\`,
so post the general note unless the user asks for inline threads. If glab is
not available in this session, print the findings instead. If the target is
not an MR, print the findings to the terminal and note that \`--comment\` was
ignored.
`
}

const FIX_SECTION = `

## Applying fixes (--fix)

The \`--fix\` flag was passed. After producing the findings list, apply the
findings to the working tree instead of stopping at the report: fix each one
directly — correctness bugs and reuse/simplification/efficiency cleanups alike.
Skip any finding whose fix would change intended behavior, require changes well
outside the reviewed diff, or that you judge to be a false positive — note the
skip rather than arguing with it. Finish with a brief summary of what was fixed
and what was skipped.
`

// The --numstat count of the committed diff (or of an explicit range target).
async function countDiffLines(target: string): Promise<number | undefined> {
  let range: string
  if (!target) range = '@{upstream}...HEAD'
  else if (
    target.length <= 256 &&
    /^[@\w][@\w./~^-]*\.\.\.?[@\w][@\w./~^-]*$/.test(target)
  ) {
    range = target
  } else return undefined
  const { stdout, code } = await execFileNoThrow(
    gitExe(),
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=',
      '-c',
      'core.askPass=',
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--numstat',
      '--end-of-options',
      range,
      '--',
    ],
    { timeout: 5000, preserveOutputOnError: false, useCwd: true },
  )
  if (code !== 0) return undefined
  let lines = 0
  for (const line of stdout.split('\n')) {
    const match = line.match(/^(\d+)\t(\d+)\t/)
    if (match) lines += Number(match[1]) + Number(match[2])
  }
  return lines > 0 ? lines : undefined
}

async function getFinderBudgetText(
  family: ModelFamily,
  level: ReviewLevel,
  target: string,
): Promise<string> {
  if (!REVIEW_CELLS[family][level].finderBudgetHint) return ''
  const lines = await countDiffLines(target)
  if (lines === undefined) return ''
  const budget = Math.max(2, Math.min(8, Math.ceil(lines / 150)))
  if (!target) {
    return `The committed diff (@{upstream}...HEAD) is about ${lines} lines. Uncommitted changes aren't counted here, so treat this as a floor — start with about ${budget} finder subagents (min 2, max 8) and scale up if Phase 0 finds additional working-tree scope.\n\n`
  }
  return `This diff is about ${lines} lines. Spawn about ${budget} finder subagents (min 2, max 8) — scale your investigation depth to the diff size rather than using a fixed large fleet.\n\n`
}

function buildLeadIn({
  parsed,
  gitlabTarget,
  lastUsed,
  level,
  context,
}: {
  parsed: ParsedReviewArgs
  gitlabTarget: boolean
  lastUsed: ReviewLevel | undefined
  level: ReviewLevel
  context: ToolUseContext
}): string {
  const { ultraFallback, fix, post, comment, unrecognizedLevel } = parsed
  const postNote = comment
    ? gitlabTarget
      ? 'when the target is a GitLab merge request, your `--comment` is what posts the findings as one general MR note via glab'
      : 'when the target is a GitHub PR, your `--comment` is what posts the findings as inline PR comments'
    : gitlabTarget
      ? 'this local review will not post to GitLab; `--comment` is the flag that posts local findings as a general MR note'
      : 'this local review will not post to GitHub; `--comment` is the flag that posts local findings as inline PR comments'
  const withPost = (text: string): string =>
    post
      ? `${text}(The typed \`--post\` applies only to the \`/code-review ultra\` cloud review and was ignored — ${postNote}. Tell the user this in one short line.)\n\n`
      : text
  if (ultraFallback) {
    if (!isUltraAvailable()) {
      if (fix) {
        return withPost(
          `(Running a local ${level}-effort review and applying its findings.)\n\n`,
        )
      }
      if (isUltraOffered()) {
        return withPost(
          `(ultra (cloud review) requires claude.ai account access this session doesn't have — see https://code.claude.com/docs/en/ultrareview. Falling back to a local ${level}-effort review.)\n\n`,
        )
      }
      return withPost(
        `(ultra (cloud review) isn't available in this environment — see https://code.claude.com/docs/en/ultrareview. Falling back to a local ${level}-effort review.)\n\n`,
      )
    }
    const canType =
      context.options.commands?.some(
        command => command.name === 'ultrareview' && isCommandEnabled(command),
      ) ?? false
    if (fix) {
      return withPost(
        canType
          ? `(Claude can't launch the cloud review directly — type \`/code-review ultra --fix\` to review in the cloud and apply the findings locally when it completes. Running a local ${level}-effort review and applying its findings for now.)\n\n`
          : `(Running a local ${level}-effort review and applying its findings.)\n\n`,
      )
    }
    return withPost(
      canType
        ? `(Claude can't launch the cloud review directly — type \`/code-review ultra\` to run it. Falling back to a local ${level}-effort review for now.)\n\n`
        : `(Claude can't launch the cloud review directly — the user can run \`claude ultrareview\` from a terminal to start it. Falling back to a local ${level}-effort review for now.)\n\n`,
    )
  }
  // The fork always runs the review as a forked agent.
  const changeHint =
    'typing a level (for example `/code-review high`) changes it'
  const tellUser = (text: string): string =>
    `(${text} Open your report with one short line telling the user this, and that ${changeHint}; that opening line reaches them with the findings.)\n\n`
  if (unrecognizedLevel !== undefined) {
    const text = `Ignoring unrecognized effort "${unrecognizedLevel}"; valid: ${REVIEW_LEVELS.join(', ')}. Using ${level}${lastUsed === level ? ', the level the user typed last time' : ''}.`
    return withPost(lastUsed !== undefined ? tellUser(text) : `(${text})\n\n`)
  }
  if (lastUsed !== undefined) {
    const reuse = `reusing ${lastUsed}, the level the user typed last time${level !== lastUsed ? `; running at ${level} here` : ''}`
    return withPost(tellUser(`No effort level given — ${reuse}.`))
  }
  return withPost('')
}

async function getCodeReviewPrompt(
  args: string,
  context: ToolUseContext,
): Promise<{ type: 'text'; text: string }[]> {
  const parsed = parseReviewArgs(args)
  const lastUsed = getLastUsedLevel(parsed, context)
  const level = resolveReviewLevel(parsed, context)
  const family = getModelFamily(getMainLoopModel(context))
  const tableFamily =
    isSkillPreload(context) && PRELOAD_DEFAULT_FAMILIES.has(family)
      ? 'default'
      : family
  const config = REVIEW_CELLS[tableFamily][level]
  const limit = resolveFindingsLimit(parsed, config.cell, context)
  const commentTarget = parsed.target.split(' ', 1)[0] ?? ''
  const gitlabTarget = await isGitLabTarget(commentTarget)
  const leadIn = buildLeadIn({ parsed, gitlabTarget, lastUsed, level, context })
  const limitNote = describeFindingsLimit(
    { ...limit, ignored: parsed.maxFindingsIgnored },
    'the user',
  )
  const resetHint = limit.reused
    ? 'passing `--max-findings default` goes back to the usual limit'
    : undefined
  const limitText = limitNote
    ? `(${limitNote} Open your report with one short line telling the user this${resetHint ? `, and that ${resetHint}` : ''}; that opening line reaches them with the findings.)\n\n`
    : ''
  const agentToolAvailable = canSpawnAgents(context)
  const budgetText =
    !isSkillPreload(context) && agentToolAvailable
      ? await getFinderBudgetText(family, level, parsed.target)
      : ''
  const targetText = parsed.target
    ? `Review target: \`${parsed.target}\`\n\n`
    : ''
  const commentText = parsed.comment
    ? gitlabTarget
      ? gitLabCommentSection(commentTarget)
      : GITHUB_COMMENT_SECTION
    : ''
  return [
    {
      type: 'text',
      text: `${leadIn}${limitText}${targetText}${budgetText}${renderReviewCell(config.cell, agentToolAvailable, limit.stated)}${commentText}${parsed.fix ? FIX_SECTION : ''}`,
    },
  ]
}

const findingsSchema = lazySchema(() =>
  z.array(
    z.object({
      file: z.string(),
      line: z.union([z.number(), z.string()]).nullish(),
      summary: z.string(),
      failure_scenario: z.string().nullish(),
    }),
  ),
)
const JSON_FENCE = /^```json[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gim
// Makes control and invisible characters visible, keeping emoji sequences.
function escapeControlCharacters(text: string): string {
  // eslint-disable-next-line no-control-regex
  const UNSAFE_CHARS =
    /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu
  if (!UNSAFE_CHARS.test(text)) return text
  let out = ''
  for (const { segment } of new Intl.Segmenter(undefined, {
    granularity: 'grapheme',
  }).segment(text)) {
    const emoji =
      /\p{Extended_Pictographic}|\p{Regional_Indicator}|^[#*0-9]\uFE0F?\u20E3$/u.test(
        segment,
      )
    const tagFlag =
      /^\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{1,6}\u{E007F}$/u.test(
        segment,
      )
    UNSAFE_CHARS.lastIndex = 0
    out += segment.replace(UNSAFE_CHARS, (char, offset: number) => {
      if (char === '\n' || char === '\t') return char
      const code = char.codePointAt(0) ?? 0
      if (
        emoji &&
        (char === '\uFE0F' ||
          char === '\uFE0E' ||
          char === '\u20E3' ||
          (char === '\u200D' && offset + char.length < segment.length) ||
          (tagFlag && code >= 0xe0020 && code <= 0xe007f))
      ) {
        return char
      }
      if (code === 27) return '\u241B'
      if (code < 32) return String.fromCodePoint(0x2400 + code)
      if (code === 127) return '\u2421'
      return `\\u{${code.toString(16).toUpperCase()}}`
    })
  }
  return out
}

function formatFindingsJson(json: string): string | undefined {
  const result = findingsSchema().safeParse(safeParseJSON(json.trim(), false))
  if (!result.success) return undefined
  const findings = result.data
  if (findings.length === 0) return 'No findings.'
  const items = findings.map((finding, index) => {
    const location = finding.line
      ? `${finding.file}:${finding.line}`
      : finding.file
    const scenario = finding.failure_scenario
      ? `\n\nFailure scenario: ${finding.failure_scenario}`
      : ''
    const prefix = `${index + 1}. `
    return escapeControlCharacters(
      `${prefix}\`${location}\`: ${finding.summary}${scenario}`,
    ).replace(/\n(?=[^\n])/g, `\n${' '.repeat(prefix.length)}`)
  })
  const order = findings.length > 1 ? ', most severe first' : ''
  return `${findings.length} ${plural(findings.length, 'finding')}${order}:\n\n${items.join('\n\n')}`
}

export function formatCodeReviewResult(resultText: string): string {
  const format = getPrintOutputFormat()
  if (format === 'text' || format === 'json') return resultText
  return (
    (resultText.trimStart().startsWith('[')
      ? formatFindingsJson(resultText)
      : undefined) ??
    resultText.replace(
      JSON_FENCE,
      (block, json: string) => formatFindingsJson(json) ?? block,
    )
  )
}

export function registerCodeReviewSkill(): void {
  registerBundledSkill({
    name: 'code-review',
    menuDescription: 'Review the current diff or a PR for bugs and cleanups',
    aliases: ['review'],
    subcommands: { ultra: 'ultrareview' },
    description: getDescription,
    whenToUse: getWhenToUse,
    argumentHint: getArgumentHint,
    userInvocable: true,
    getEffort(args, context) {
      const { explicit } = parseReviewArgs(args)
      if (explicit === undefined) return undefined
      return getModelEffort(getModelFamily(getMainLoopModel(context)), explicit)
    },
    getDefaultEffort(args, context) {
      const parsed = parseReviewArgs(args)
      const lastUsed = getLastUsedLevel(parsed, context)
      if (lastUsed === undefined) return undefined
      const level = context ? resolveReviewLevel(parsed, context) : lastUsed
      const family = getModelFamily(getMainLoopModel(context))
      const limit = resolveFindingsLimit(
        parsed,
        REVIEW_CELLS[family][level].cell,
        context,
      )
      const limitNote = describeFindingsLimit(
        { ...limit, ignored: parsed.maxFindingsIgnored },
        'you',
      )
      const unrecognized =
        parsed.unrecognizedLevel !== undefined
          ? `Ignoring unrecognized effort "${parsed.unrecognizedLevel}"; valid: ${REVIEW_LEVELS.join(', ')}. `
          : ''
      return {
        value: getModelEffort(family, lastUsed),
        notice: `${unrecognized}Reusing ${lastUsed} effort, the level you typed last time${level !== lastUsed ? `; running at ${level} here` : ''}. Type a level like \`/code-review high\` to change it.${limitNote ? ` ${limitNote}${limit.reused ? ' Pass `--max-findings default` to go back to the usual limit.' : ''}` : ''}`,
      }
    },
    onUserTypedArgs(args) {
      const { explicit, maxFindings } = parseReviewArgs(args)
      if (explicit !== undefined) {
        saveGlobalConfig(config =>
          config.codeReviewLastEffort === explicit
            ? config
            : { ...config, codeReviewLastEffort: explicit },
        )
      }
      if (maxFindings !== undefined) {
        const value = maxFindings === 'default' ? undefined : maxFindings
        saveGlobalConfig(config =>
          config.codeReviewLastMaxFindings === value
            ? config
            : { ...config, codeReviewLastMaxFindings: value },
        )
      }
    },
    getContext() {
      return isCoordinatorMode() ? 'inline' : 'fork'
    },
    formatForegroundForkResult: formatCodeReviewResult,
    getPromptForCommand: getCodeReviewPrompt,
  })
}
