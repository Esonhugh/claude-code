import { isDeepStrictEqual } from 'node:util'
import { ZodError } from 'zod/v4'
import type { Tool, ToolUseContext } from '../../Tool.js'
import type { PermissionDenyDecision } from '../../types/permissions.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { formatZodValidationError } from '../toolErrors.js'

const REWRITE_INVALID =
  "The tool input from the model was valid; the hook's rewrite of it was not."

export type HookUpdatedInputCheck =
  | { input: Record<string, unknown>; deny?: undefined }
  | { input?: undefined; deny: PermissionDenyDecision }

type UnknownKeysIssue = { keys: string[]; path: PropertyKey[] }

function isUnknownKeysIssue(issue: { code: string }): boolean {
  return issue.code === 'unrecognized_keys'
}

// Copy-on-write removal of the keys zod reported as unrecognized.
function dropUnknownKeys(
  input: Record<string, unknown>,
  issues: UnknownKeysIssue[],
): Record<string, unknown> {
  const root: Record<string, unknown> = { ...input }
  const copied = new Set<unknown>([root])
  for (const issue of issues) {
    let node: Record<string, unknown> | undefined = root
    for (const key of issue.path) {
      const child: unknown = node[key as string]
      if (typeof child !== 'object' || child === null) {
        node = undefined
        break
      }
      if (!copied.has(child)) {
        const copy = Array.isArray(child) ? [...child] : { ...child }
        copied.add(copy)
        node[key as string] = copy
      }
      node = node[key as string] as Record<string, unknown>
    }
    if (node) for (const key of issue.keys) delete node[key]
  }
  return root
}

/**
 * Validates a PreToolUse / PermissionRequest hook's `updatedInput` the way
 * model input is validated (official 2.1.300): keys the tool schema does not
 * know are dropped, any other schema issue or a validateInput() refusal
 * denies the call. `shown` is the input the hook was shown; keys it carried
 * that the hook sent back unchanged survive even if the schema strips them.
 */
export async function checkHookUpdatedInput(
  tool: Tool,
  updatedInput: Record<string, unknown>,
  opts: {
    event: 'PreToolUse' | 'PermissionRequest'
    context: ToolUseContext
    hookSource?: string
    shown?: Record<string, unknown>
  },
): Promise<HookUpdatedInputCheck> {
  const { event, context, hookSource, shown } = opts
  const label = `${event} hook${hookSource && !hookSource.endsWith('Settings') ? ` (${hookSource})` : ''} for ${tool.name}`
  const deny = (message: string): HookUpdatedInputCheck => ({
    deny: {
      behavior: 'deny',
      message,
      decisionReason: {
        type: 'hook',
        hookName:
          event === 'PermissionRequest'
            ? 'PermissionRequest'
            : `PreToolUse:${tool.name}`,
        hookSource,
        reason: message,
      },
    },
  })

  let parsed = tool.inputSchema.safeParse(updatedInput)
  if (!parsed.success) {
    const unknownKeys = parsed.error.issues.filter(isUnknownKeysIssue)
    if (unknownKeys.length === parsed.error.issues.length)
      parsed = tool.inputSchema.safeParse(
        dropUnknownKeys(
          updatedInput,
          unknownKeys as unknown as UnknownKeysIssue[],
        ),
      )
  }
  if (!parsed.success) {
    const otherIssues = parsed.error.issues.filter(i => !isUnknownKeysIssue(i))
    const issues = otherIssues.length ? otherIssues : parsed.error.issues
    logForDebugging(
      `${event} hook's updatedInput for ${tool.name} failed schema validation (${issues.map(i => i.code).join(',')})`,
      { level: 'warn' },
    )
    return deny(
      `${label} returned updatedInput that failed schema validation: ${formatZodValidationError(tool.name, new ZodError(issues))}\n${REWRITE_INVALID}`,
    )
  }

  const input: Record<string, unknown> = { ...parsed.data }
  if (shown) {
    for (const key of Object.keys(shown)) {
      if (
        key !== '__proto__' &&
        !Object.hasOwn(input, key) &&
        Object.hasOwn(updatedInput, key) &&
        isDeepStrictEqual(updatedInput[key], shown[key])
      )
        input[key] = shown[key]
    }
  }

  let validation: Awaited<ReturnType<NonNullable<Tool['validateInput']>>>
  try {
    validation = await tool.validateInput?.(parsed.data, context)
  } catch (error) {
    if (context.abortController.signal.aborted) throw error
    return deny(
      `${label} returned updatedInput that the tool could not check: ${errorMessage(error)}\nThe tool input from the model was valid.`,
    )
  }
  if (validation?.result === false) {
    logForDebugging(
      `${event} hook's updatedInput for ${tool.name} was refused by the tool (code=${validation.errorCode})`,
      { level: 'warn' },
    )
    return deny(
      `${label} returned updatedInput that the tool refused: ${validation.message}\n${REWRITE_INVALID}`,
    )
  }
  return { input }
}
