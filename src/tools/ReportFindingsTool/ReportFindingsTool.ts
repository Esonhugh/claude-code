import { z } from 'zod/v4'

import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { plural } from '../../utils/stringUtils.js'
import { REPORT_FINDINGS_TOOL_NAME } from './constants.js'

const DESCRIPTION =
  "Report code-review findings as a typed list so the host UI can render them. Use this only when the active code-review instructions tell you to report findings with this tool; otherwise follow whatever output format those instructions specify. When reporting a review's results, call it once with the verified findings ranked most-severe first (empty array if nothing survived verification) and do not also print the findings as text. When re-reporting after applying fixes (only if the apply instructions ask for it), set `outcome` on each finding to what actually happened."

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

const findingSchema = lazySchema(() =>
  z.object({
    file: z.string().describe('Repo-relative path of the file the finding is in'),
    line: z
      .number()
      .int()
      .optional()
      .describe('1-indexed line the finding anchors to'),
    summary: z.string().describe('One-sentence statement of the defect'),
    short_summary: z
      .string()
      .max(60)
      .optional()
      .describe(
        'Compressed label for compact UI (≤60 chars): the claim alone, no rationale or consequence clause',
      ),
    failure_scenario: z
      .string()
      .describe('Concrete inputs/state → wrong output/crash'),
    category: z
      .string()
      .max(40)
      .optional()
      .describe(
        'Short kebab-case slug of the finding type, e.g. "correctness", "simplification", "efficiency", "test-coverage"',
      ),
    verdict: z
      .enum(['CONFIRMED', 'PLAUSIBLE'])
      .optional()
      .describe('Set when a verify pass ran; absent on inline-only reviews'),
    outcome: z
      .enum(['fixed', 'skipped', 'no_change_needed'])
      .optional()
      .describe(
        'Set ONLY when re-reporting after applying fixes: what happened to this finding',
      ),
  }),
)

const inputSchema = lazySchema(() =>
  z.strictObject({
    level: z
      .enum(LEVELS)
      .optional()
      .describe('Effort level the review ran at'),
    findings: z
      .array(findingSchema())
      .max(32)
      .describe('Verified findings, most-severe first; empty if none survived'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    count: z.number().describe('Number of findings reported'),
    level: z
      .enum(LEVELS)
      .optional()
      .describe('Effort level the review ran at'),
    findings: z
      .array(findingSchema())
      .describe('Echoed for the result body'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const ReportFindingsTool = buildTool({
  name: REPORT_FINDINGS_TOOL_NAME,
  searchHint: 'report code-review findings as a structured list',
  maxResultSizeChars: 256,
  strict: true,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return DESCRIPTION
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput({ findings }) {
    return `${findings.length} findings`
  },
  userFacingName() {
    return 'Code review'
  },
  renderToolUseMessage({ level, findings }) {
    const count = findings?.length ?? 0
    return `${level ?? 'review'} · ${count} ${plural(count, 'finding')}`
  },
  async checkPermissions(input) {
    return { behavior: 'allow', updatedInput: input }
  },
  async call({ findings, level }) {
    return { data: { count: findings.length, level, findings } }
  },
  mapToolResultToToolResultBlockParam({ count }, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content:
        count === 0
          ? 'No findings reported.'
          : `${count} ${plural(count, 'finding')} reported.`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
