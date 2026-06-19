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

export async function call(args: string) {
  return { type: 'text' as const, value: executeCd(args).message }
}
