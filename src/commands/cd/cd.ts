import type { LocalJSXCommandContext } from '../../types/command.js'
import type { AdditionalWorkingDirectory } from '../../types/permissions.js'
import { getCwd } from '../../utils/cwd.js'
import { changeSessionCwd } from '../../utils/cwdChange.js'

type ExecuteCdOptions = Parameters<typeof changeSessionCwd>[1]

type CdCommandResult = {
  message: string
}

function parseCdPath(args: string): string {
  const path = args.trim()
  if (path.length >= 2) {
    const first = path[0]
    const last = path[path.length - 1]
    if ((first === '"' || first === "'") && first === last) {
      return path.slice(1, -1)
    }
  }
  return path
}

export function executeCd(
  args: string,
  options?: ExecuteCdOptions,
): CdCommandResult {
  const path = parseCdPath(args)
  if (!path) {
    return { message: 'Usage: /cd <path>' }
  }

  try {
    const newCwd = changeSessionCwd(path, options)
    return { message: `Changed directory to ${newCwd}` }
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

function addCwdToAdditionalWorkingDirectories(
  context: Pick<LocalJSXCommandContext, 'getAppState' | 'setAppState'>,
  cwd: string,
): void {
  context.setAppState(prev => {
    const current = prev.toolPermissionContext
      .additionalWorkingDirectories as unknown as Map<
      string,
      AdditionalWorkingDirectory
    >
    if (current.has(cwd)) return prev
    const additionalWorkingDirectories = new Map(current)
    additionalWorkingDirectories.set(cwd, {
      path: cwd,
      source: 'session',
    })
    return {
      ...prev,
      toolPermissionContext: {
        ...prev.toolPermissionContext,
        additionalWorkingDirectories,
      },
    }
  })
}

export async function call(args: string, context: LocalJSXCommandContext) {
  const result = executeCd(args)
  const cwd = getCwd()
  if (result.message === `Changed directory to ${cwd}`) {
    addCwdToAdditionalWorkingDirectories(context, cwd)
  }
  return { type: 'text' as const, value: result.message }
}
