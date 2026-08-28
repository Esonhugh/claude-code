export type PendingSSH = {
  host: string | undefined
  cwd: string | undefined
  permissionMode: string | undefined
  dangerouslySkipPermissions: boolean
  allowDangerouslySkipPermissions: boolean
  local: boolean
  extraCliArgs: string[]
}

type RootSSHArgvParseResult =
  | { type: 'none' }
  | { type: 'error'; message: string }
  | {
      type: 'ssh'
      pending: PendingSSH
      remainingArgs: string[]
    }

type OptionArity = 'boolean' | 'required' | 'optional' | 'variadic'
type OptionDisposition = 'local' | 'remote' | 'both' | 'model'

type RootOptionSpec = {
  arity: OptionArity
  disposition?: OptionDisposition
  canonical?: string
}

const ROOT_OPTIONS = new Map<string, RootOptionSpec>()

function addOptions(
  flags: readonly string[],
  arity: OptionArity,
  disposition: OptionDisposition = 'local',
  canonical?: string,
): void {
  for (const flag of flags) {
    ROOT_OPTIONS.set(flag, { arity, disposition, canonical })
  }
}

addOptions(
  [
    '--allowed-tools',
    '--allowedTools',
    '--tools',
    '--disallowed-tools',
    '--disallowedTools',
    '--mcp-config',
    '--add-dir',
    '--betas',
    '--file',
  ],
  'variadic',
  'remote',
)
ROOT_OPTIONS.set('--allowedTools', {
  arity: 'variadic',
  disposition: 'remote',
  canonical: '--allowed-tools',
})
ROOT_OPTIONS.set('--disallowedTools', {
  arity: 'variadic',
  disposition: 'remote',
  canonical: '--disallowed-tools',
})
addOptions(
  ['--channels', '--dangerously-load-development-channels'],
  'variadic',
)
addOptions(
  [
    '--agent',
    '--agents',
    '--append-system-prompt',
    '--append-system-prompt-file',
    '--fallback-model',
    '--max-budget-usd',
    '--max-thinking-tokens',
    '--max-turns',
    '--plugin-dir',
    '--resume-session-at',
    '--rewind-files',
    '--session-id',
    '--system-prompt',
    '--system-prompt-file',
    '--task-budget',
    '--workload',
  ],
  'required',
  'remote',
)
addOptions(['--setting-sources', '--settings'], 'required')
addOptions(['--effort', '--thinking'], 'required', 'both')
addOptions(['--model'], 'required', 'model')
addOptions(['-w', '--worktree'], 'optional')
addOptions(['--tmux'], 'optional')
addOptions(['--advisor'], 'required', 'remote')
addOptions(['--agent-type', '--sdk-url'], 'required')
addOptions(
  ['--teleport', '--remote', '--remote-control', '--rc'],
  'optional',
)
addOptions(
  [
    '--agent-teams',
    '--bare',
    '--fork-session',
    '--no-session-persistence',
    '--strict-mcp-config',
  ],
  'boolean',
  'remote',
)
ROOT_OPTIONS.set('--bare', { arity: 'boolean', disposition: 'both' })
addOptions(['-c', '--continue'], 'boolean', 'remote', '--continue')
addOptions(['-r', '--resume'], 'optional', 'remote', '--resume')
addOptions(['--from-pr'], 'optional', 'remote')

addOptions(
  [
    '--debug-file',
    '--deep-link-last-fetch',
    '--deep-link-repo',
    '--json-schema',
    '--messaging-socket-path',
    '--name',
    '-n',
    '--output-format',
    '--permission-prompt-tool',
    '--prefill',
    '--team-name',
    '--teammate-mode',
    '--parent-session-id',
    '--agent-id',
    '--agent-name',
    '--agent-color',
    '--input-format',
  ],
  'required',
)
addOptions(['-d', '--debug', '--tasks'], 'optional')

addOptions(
  [
    '-p',
    '--print',
    '--allow-dangerously-skip-permissions',
    '--dangerously-skip-permissions',
    '--local',
    '--permission-mode',
  ],
  'boolean',
)
ROOT_OPTIONS.set('--permission-mode', { arity: 'required' })

function optionName(arg: string): string {
  const equals = arg.indexOf('=')
  return equals === -1 ? arg : arg.slice(0, equals)
}

function unsupportedSSHWorkspaceOption(
  args: readonly string[],
): '--worktree' | '--tmux' | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--') return undefined
    if (arg === '-w' || arg.startsWith('-w=') || /^-w[^-]/.test(arg)) {
      return '--worktree'
    }
    const name = optionName(arg)
    if (name === '--worktree') return '--worktree'
    if (name === '--tmux') return '--tmux'

    if (arg.includes('=')) continue
    const spec = ROOT_OPTIONS.get(arg)
    if (spec?.arity === 'required' && args[index + 1] !== undefined) index++
  }
  return undefined
}

function findSSHIndex(args: readonly string[]): number {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === 'ssh') return index
    if (arg === '--' || !arg.startsWith('-')) return -1
    if (arg.includes('=')) continue

    const spec = ROOT_OPTIONS.get(arg)
    if (!spec || spec.arity === 'boolean') continue
    if (spec.arity === 'required') {
      if (args[index + 1] !== undefined) index++
      continue
    }
    if (spec.arity === 'optional') {
      const next = args[index + 1]
      if (next && next !== 'ssh' && !next.startsWith('-')) index++
      continue
    }
    while (
      args[index + 1] &&
      args[index + 1] !== 'ssh' &&
      !args[index + 1]!.startsWith('-')
    ) {
      index++
    }
  }
  return -1
}

export function createPendingSSH(): PendingSSH {
  return {
    host: undefined,
    cwd: undefined,
    permissionMode: undefined,
    dangerouslySkipPermissions: false,
    allowDangerouslySkipPermissions: false,
    local: false,
    extraCliArgs: [],
  }
}

function parseBooleanValue(arg: string, flag: string): boolean | undefined {
  if (arg === flag || arg === `${flag}=true`) return true
  if (arg === `${flag}=false`) return false
  return undefined
}

function extractSSHOptions(
  args: readonly string[],
  pending: PendingSSH,
): string[] {
  const remaining: string[] = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--') {
      remaining.push(...args.slice(index))
      break
    }

    if (arg.startsWith('-r') && arg !== '-r') {
      const value = arg.slice(2).replace(/^=/, '')
      if (value) {
        pending.extraCliArgs.push('--resume', value)
        continue
      }
    }

    const local = parseBooleanValue(arg, '--local')
    if (local !== undefined) {
      pending.local = local
      continue
    }
    const bypass = parseBooleanValue(arg, '--dangerously-skip-permissions')
    if (bypass !== undefined) {
      pending.dangerouslySkipPermissions = bypass
      continue
    }
    const allowBypass = parseBooleanValue(
      arg,
      '--allow-dangerously-skip-permissions',
    )
    if (allowBypass !== undefined) {
      pending.allowDangerouslySkipPermissions = allowBypass
      continue
    }

    if (arg === '--permission-mode') {
      const value = args[index + 1]
      if (value) {
        pending.permissionMode = value
        index++
        continue
      }
    } else if (arg.startsWith('--permission-mode=')) {
      pending.permissionMode = arg.slice('--permission-mode='.length)
      continue
    }
    if (
      arg === '--delegate-permissions' ||
      arg === '--dangerously-skip-permissions-with-classifiers' ||
      arg === '--afk'
    ) {
      pending.permissionMode = 'auto'
      continue
    }

    const name = optionName(arg)
    const spec = ROOT_OPTIONS.get(name)
    if (!spec) {
      remaining.push(arg)
      continue
    }

    if (spec.disposition === 'local' || spec.disposition === 'model') {
      remaining.push(arg)
      if (!arg.includes('=')) {
        if (spec.arity === 'required' && args[index + 1] !== undefined) {
          remaining.push(args[++index]!)
        } else if (
          spec.arity === 'optional' &&
          args[index + 1] &&
          !args[index + 1]!.startsWith('-')
        ) {
          remaining.push(args[++index]!)
        } else if (spec.arity === 'variadic') {
          while (args[index + 1] && !args[index + 1]!.startsWith('-')) {
            remaining.push(args[++index]!)
          }
        }
      }
      continue
    }

    const canonical = spec.canonical ?? name
    const equals = arg.indexOf('=')
    const inlineValue = equals === -1 ? undefined : arg.slice(equals + 1)
    const forwarded: string[] = [canonical]
    let consumed = 0
    let valid = true

    if (spec.arity === 'boolean') {
      valid = inlineValue === undefined
    } else if (inlineValue !== undefined) {
      forwarded.push(inlineValue)
    } else if (spec.arity === 'required') {
      const value = args[index + 1]
      if (value === undefined) valid = false
      else {
        forwarded.push(value)
        consumed = 1
      }
    } else if (spec.arity === 'optional') {
      const value = args[index + 1]
      if (value && !value.startsWith('-')) {
        forwarded.push(value)
        consumed = 1
      }
    } else {
      while (
        args[index + consumed + 1] !== undefined &&
        !args[index + consumed + 1]!.startsWith('-')
      ) {
        forwarded.push(args[index + consumed + 1]!)
        consumed++
      }
      valid = consumed > 0
    }

    if (!valid) {
      remaining.push(arg)
      continue
    }
    pending.extraCliArgs.push(...forwarded)
    if (spec.disposition === 'both') {
      remaining.push(arg, ...args.slice(index + 1, index + consumed + 1))
    }
    index += consumed
  }

  return remaining
}

function extractHostAndCwd(args: readonly string[]): {
  host: string | undefined
  cwd: string | undefined
  remaining: string[]
} {
  let host: string | undefined
  let cwd: string | undefined
  const remaining: string[] = []

  let positionalOnly = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--') {
      positionalOnly = true
      continue
    }
    if (!positionalOnly && arg.startsWith('-')) {
      remaining.push(arg)
      if (arg.includes('=')) continue
      const spec = ROOT_OPTIONS.get(arg)
      if (!spec || spec.arity === 'boolean') continue
      if (spec.arity === 'required') {
        if (args[index + 1] !== undefined) remaining.push(args[++index]!)
      } else if (spec.arity === 'optional') {
        if (args[index + 1] && !args[index + 1]!.startsWith('-')) {
          remaining.push(args[++index]!)
        }
      } else {
        while (args[index + 1] && !args[index + 1]!.startsWith('-')) {
          remaining.push(args[++index]!)
        }
      }
      continue
    }
    if (!host) host = arg
    else if (!cwd) cwd = arg
    else {
      if (positionalOnly && remaining.length === 0) remaining.push('--')
      remaining.push(arg)
    }
  }

  return { host, cwd, remaining }
}

export function parseRootSSHArgv(
  inputArgs: readonly string[],
): RootSSHArgvParseResult {
  const sshIndex = findSSHIndex(inputArgs)
  if (sshIndex === -1) return { type: 'none' }

  const pending = createPendingSSH()
  const rootInputArgs = inputArgs.slice(0, sshIndex)
  const sshInputArgs = inputArgs.slice(sshIndex + 1)
  const unsupportedWorkspaceOption = unsupportedSSHWorkspaceOption([
    ...rootInputArgs,
    ...sshInputArgs,
  ])
  if (unsupportedWorkspaceOption) {
    return {
      type: 'error',
      message: `Error: ${unsupportedWorkspaceOption} is not supported with claude ssh\n`,
    }
  }

  const rootArgs = extractSSHOptions(rootInputArgs, pending)
  const sshArgs = extractSSHOptions(sshInputArgs, pending)
  const parsedPositionals = extractHostAndCwd(sshArgs)

  if (!parsedPositionals.host || parsedPositionals.host.startsWith('-')) {
    return { type: 'none' }
  }
  pending.host = parsedPositionals.host
  pending.cwd = parsedPositionals.cwd

  const remainingArgs = [...rootArgs, ...parsedPositionals.remaining]
  if (
    remainingArgs.some(
      arg => arg === '-p' || arg === '--print' || arg.startsWith('--print='),
    )
  ) {
    return {
      type: 'error',
      message:
        'Error: headless (-p/--print) mode is not supported with claude ssh\n',
    }
  }
  if (
    remainingArgs.some(
      arg => arg === '--sdk-url' || arg.startsWith('--sdk-url='),
    )
  ) {
    return {
      type: 'error',
      message: 'Error: --sdk-url is not supported with claude ssh\n',
    }
  }

  return { type: 'ssh', pending, remainingArgs }
}
