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

const ROOT_FLAGS_WITH_VALUES = new Set([
  '--add-dir',
  '--agent',
  '--agents',
  '--allowed-tools',
  '--allowedTools',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--betas',
  '--debug-file',
  '--effort',
  '--fallback-model',
  '--file',
  '--json-schema',
  '--max-budget-usd',
  '--max-turns',
  '--mcp-config',
  '--model',
  '--output-format',
  '--permission-mode',
  '--plugin-dir',
  '--prefill',
  '--session-id',
  '--setting-sources',
  '--settings',
  '--system-prompt',
  '--system-prompt-file',
  '--tools',
])

const ROOT_FLAGS_WITH_OPTIONAL_VALUES = new Set([
  '--debug',
  '--from-pr',
  '--resume',
  '-d',
  '-r',
])

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

export function parseRootSSHArgv(
  inputArgs: readonly string[],
): RootSSHArgvParseResult {
  const rawCliArgs = [...inputArgs]
  let sshIndex = -1
  for (let index = 0; index < rawCliArgs.length; index++) {
    const arg = rawCliArgs[index]!
    if (arg === 'ssh') {
      sshIndex = index
      break
    }
    if (arg === '--' || !arg.startsWith('-')) break
    if (arg.includes('=')) continue
    if (
      ROOT_FLAGS_WITH_VALUES.has(arg) ||
      (ROOT_FLAGS_WITH_OPTIONAL_VALUES.has(arg) &&
        rawCliArgs[index + 1] &&
        !rawCliArgs[index + 1]!.startsWith('-'))
    ) {
      index++
    }
  }
  if (sshIndex === -1) return { type: 'none' }
  if (sshIndex > 0) {
    const rootFlags = rawCliArgs.slice(0, sshIndex)
    rawCliArgs.splice(
      0,
      rawCliArgs.length,
      'ssh',
      ...rawCliArgs.slice(sshIndex + 1),
      ...rootFlags,
    )
  }

  const pending = createPendingSSH()
  const extractBooleanFlag = (flag: string): boolean => {
    const index = rawCliArgs.indexOf(flag)
    const equalsIndex = rawCliArgs.indexOf(`${flag}=true`)
    const found = index !== -1 || equalsIndex !== -1
    if (index !== -1) rawCliArgs.splice(index, 1)
    if (equalsIndex !== -1) rawCliArgs.splice(equalsIndex, 1)
    return found
  }
  pending.local = extractBooleanFlag('--local')
  pending.dangerouslySkipPermissions = extractBooleanFlag(
    '--dangerously-skip-permissions',
  )
  pending.allowDangerouslySkipPermissions = extractBooleanFlag(
    '--allow-dangerously-skip-permissions',
  )
  const permissionModeIndex = rawCliArgs.indexOf('--permission-mode')
  if (
    permissionModeIndex !== -1 &&
    rawCliArgs[permissionModeIndex + 1] &&
    !rawCliArgs[permissionModeIndex + 1]!.startsWith('-')
  ) {
    pending.permissionMode = rawCliArgs[permissionModeIndex + 1]
    rawCliArgs.splice(permissionModeIndex, 2)
  }
  const permissionModeEqualsIndex = rawCliArgs.findIndex(arg =>
    arg.startsWith('--permission-mode='),
  )
  if (permissionModeEqualsIndex !== -1) {
    pending.permissionMode = rawCliArgs[permissionModeEqualsIndex]!.split('=')[1]
    rawCliArgs.splice(permissionModeEqualsIndex, 1)
  }

  const extractFlag = (
    flag: string,
    options: { hasValue?: boolean; as?: string } = {},
  ) => {
    const index = rawCliArgs.indexOf(flag)
    if (index !== -1) {
      pending.extraCliArgs.push(options.as ?? flag)
      const value = rawCliArgs[index + 1]
      if (options.hasValue && value && !value.startsWith('-')) {
        pending.extraCliArgs.push(value)
        rawCliArgs.splice(index, 2)
      } else {
        rawCliArgs.splice(index, 1)
      }
    }
    const equalsIndex = rawCliArgs.findIndex(arg =>
      arg.startsWith(`${flag}=`),
    )
    if (equalsIndex !== -1) {
      pending.extraCliArgs.push(
        options.as ?? flag,
        rawCliArgs[equalsIndex]!.slice(flag.length + 1),
      )
      rawCliArgs.splice(equalsIndex, 1)
    }
  }
  extractFlag('-c', { as: '--continue' })
  extractFlag('--continue')
  extractFlag('--resume', { hasValue: true })
  extractFlag('--model', { hasValue: true })

  if (
    rawCliArgs[0] !== 'ssh' ||
    !rawCliArgs[1] ||
    rawCliArgs[1].startsWith('-')
  ) {
    return { type: 'none' }
  }

  pending.host = rawCliArgs[1]
  let consumed = 2
  if (rawCliArgs[2] && !rawCliArgs[2].startsWith('-')) {
    pending.cwd = rawCliArgs[2]
    consumed = 3
  }
  const remainingArgs = rawCliArgs.slice(consumed)
  if (remainingArgs.includes('-p') || remainingArgs.includes('--print')) {
    return {
      type: 'error',
      message:
        'Error: headless (-p/--print) mode is not supported with claude ssh\n',
    }
  }

  return { type: 'ssh', pending, remainingArgs }
}
