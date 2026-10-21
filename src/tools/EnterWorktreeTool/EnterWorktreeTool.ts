import { z } from 'zod/v4'
import { getSessionId, setOriginalCwd } from '../../bootstrap/state.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { logEvent } from '../../services/analytics/index.js'
import type { Tool } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { clearMemoryFileCaches } from '../../utils/claudemd.js'
import { getCwd } from '../../utils/cwd.js'
import { findCanonicalGitRoot } from '../../utils/git.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getPlanSlug, getPlansDirectory } from '../../utils/plans.js'
import { setCwd } from '../../utils/Shell.js'
import { saveWorktreeState } from '../../utils/sessionStorage.js'
import {
  createWorktreeForSession,
  enterExistingWorktree,
  getCurrentWorktreeSession,
  resolveExistingWorktree,
  validateWorktreeSlug,
} from '../../utils/worktree.js'
import { ENTER_WORKTREE_TOOL_NAME } from './constants.js'
import { getEnterWorktreeToolPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    name: z
      .string()
      .superRefine((s, ctx) => {
        try {
          validateWorktreeSlug(s)
        } catch (e) {
          ctx.addIssue({ code: 'custom', message: (e as Error).message })
        }
      })
      .optional()
      .describe(
        'Optional name for a new worktree. Each "/"-separated segment may contain only letters, digits, dots, underscores, and dashes; max 64 chars total. A random name is generated if not provided. Mutually exclusive with `path`.',
      ),
    path: z
      .string()
      .optional()
      .describe(
        'Path to an existing worktree to switch into instead of creating a new one. Must appear in `git worktree list` for the current repo. Mutually exclusive with `name`.',
      ),
  }).refine(input => !(input.name && input.path), {
    message: 'Provide at most one of `name` or `path`, not both.',
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    worktreePath: z.string(),
    worktreeBranch: z.string().optional(),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const EnterWorktreeTool: Tool<InputSchema, Output> = buildTool({
  name: ENTER_WORKTREE_TOOL_NAME,
  searchHint: 'create an isolated git worktree and switch into it',
  maxResultSizeChars: 100_000,
  async description() {
    return 'Creates an isolated worktree (via git or configured hooks) and switches the session into it'
  },
  async prompt() {
    return getEnterWorktreeToolPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName(input) {
    return input?.path ? 'Entering worktree' : 'Creating worktree'
  },
  shouldDefer: true,
  toAutoClassifierInput(input) {
    return input.path ?? input.name ?? ''
  },
  async validateInput(input) {
    if (getCurrentWorktreeSession() && !input.path) {
      return {
        result: false,
        message:
          'Already in a worktree session. Pass `path` to switch into another existing worktree, or use ExitWorktree to leave this one before creating a new worktree.',
        errorCode: 2,
      }
    }
    return { result: true }
  },
  async checkPermissions(input) {
    if (!input.path) return { behavior: 'allow', updatedInput: input }
    // Worktrees under .claude/worktrees/ are Claude-managed; anything else
    // moves the session's write access elsewhere, so ask first.
    const existing = await resolveExistingWorktree(input.path).catch(
      () => null,
    )
    if (existing?.managed) {
      return {
        behavior: 'allow',
        updatedInput: { ...input, path: existing.worktreePath },
      }
    }
    const target = existing?.worktreePath ?? input.path
    return {
      behavior: 'ask',
      message: `Enter the worktree at "${target}"? This moves the session's working directory and write access there, and loads project configuration (CLAUDE.md, settings) from that location.`,
      updatedInput: { ...input, path: target },
      decisionReason: {
        type: 'safetyCheck',
        reason: `permission-root relocation to "${target}" — a model-supplied worktree outside .claude/worktrees/`,
        classifierApprovable: false,
      },
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call(input) {
    // Validate not already in a worktree created by this session
    if (getCurrentWorktreeSession() && !input.path) {
      throw new Error('Already in a worktree session')
    }

    let worktreeSession
    if (input.path) {
      worktreeSession = await enterExistingWorktree(getSessionId(), input.path)
    } else {
      // Resolve to main repo root so worktree creation works from within a
      // worktree; worktree.baseRef "head" still reads HEAD where we started.
      const fromCwd = getCwd()
      const mainRepoRoot = findCanonicalGitRoot(fromCwd)
      if (mainRepoRoot && mainRepoRoot !== fromCwd) {
        process.chdir(mainRepoRoot)
        setCwd(mainRepoRoot)
      }

      const slug = input.name ?? getPlanSlug()

      worktreeSession = await createWorktreeForSession(
        getSessionId(),
        slug,
        undefined,
        { fromCwd },
      )
    }

    process.chdir(worktreeSession.worktreePath)
    setCwd(worktreeSession.worktreePath)
    setOriginalCwd(getCwd())
    saveWorktreeState(worktreeSession)
    // Clear cached system prompt sections so env_info_simple recomputes with worktree context
    clearSystemPromptSections()
    // Clear memoized caches that depend on CWD
    clearMemoryFileCaches()
    getPlansDirectory.cache.clear?.()

    logEvent(
      input.path ? 'tengu_worktree_entered_existing' : 'tengu_worktree_created',
      {
        mid_session: true,
      },
    )

    const branchInfo = worktreeSession.worktreeBranch
      ? ` on branch ${worktreeSession.worktreeBranch}`
      : ''

    return {
      data: {
        worktreePath: worktreeSession.worktreePath,
        worktreeBranch: worktreeSession.worktreeBranch,
        message: `${input.path ? 'Entered' : 'Created'} worktree at ${worktreeSession.worktreePath}${branchInfo}. The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.`,
      },
    }
  },
  mapToolResultToToolResultBlockParam({ message }, toolUseID) {
    return {
      type: 'tool_result',
      content: message,
      tool_use_id: toolUseID,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
