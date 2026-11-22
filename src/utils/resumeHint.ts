import { stringWidth } from '../ink/stringWidth.js'
import { validateWorktreeSlug } from './worktree.js'

const WORKTREE_ADVICE = [
  'This session ran in a worktree',
  'In its folder, run the command below to resume in it',
  'To find that folder, try git worktree list',
]
const LAUNCHER_PROGRAM = /^\w[\w-]*$/

function isPrintableWorktreeName(name: string | null): name is string {
  if (name === null || name.startsWith('-')) return false
  try {
    validateWorktreeSlug(name)
    return true
  } catch {
    return false
  }
}

/**
 * The command the exit hint prints, like official 2.1.329. A launcher from
 * CLAUDE_CODE_RESUME_HINT_COMMAND replaces the whole `claude ...` prefix.
 */
export function buildResumeHint({
  sessionId,
  worktree,
  columns,
  envAssignment,
  launchFlags = '',
  launcherProgram,
}: {
  sessionId: string
  worktree?: { name: string | null; recordCleared: boolean }
  columns?: number
  envAssignment?: string
  launchFlags?: string
  launcherProgram?: string
}): { advice: string[]; command: string } {
  if (launcherProgram !== undefined && LAUNCHER_PROGRAM.test(launcherProgram)) {
    return { advice: [], command: `${launcherProgram} --resume ${sessionId}` }
  }
  const claude = envAssignment === undefined ? 'claude' : `${envAssignment} claude`
  const floored = Math.floor(columns ?? Number.NaN)
  const width = floored >= 1 && floored <= 8192 ? floored : undefined
  const fits = (command: string) =>
    width !== undefined && stringWidth(command) <= width
  // Flags that carry a path only make sense where the session started, so
  // they are replayed only when the whole command stays on one line.
  const withFlags =
    launchFlags !== '' &&
    (!/[/.]/.test(launchFlags) ||
      fits(`${claude} ${launchFlags} --resume ${sessionId}`))
  const prefix = withFlags ? `${claude} ${launchFlags}` : claude
  const plain = `${prefix} --resume ${sessionId}`
  if (worktree === undefined) return { advice: [], command: plain }

  const { name } = worktree
  if (isPrintableWorktreeName(name)) {
    const command = [
      `${prefix} --worktree "${name}" --resume ${sessionId}`,
      `${prefix} -w "${name}" -r ${sessionId}`,
    ].find(fits)
    if (command !== undefined) return { advice: [], command }
  }
  return {
    advice: worktree.recordCleared ? WORKTREE_ADVICE : [],
    command: plain,
  }
}

// Options whose value belongs to one process: no flags are replayed at all.
const UNREPLAYABLE_OPTIONS = new Set([
  'agent-id',
  'agent-name',
  'team-name',
  'agent-color',
  'agent-type',
  'parent-session-id',
  'lead-verify-key',
  'plan-mode-required',
  'inherit-permission-mode',
  'agents-view-if-allowed',
  'attach-serve',
  'session-began-as-copy',
  'messaging-socket-path',
  'project-config-root',
  'hold-repository-while-parked',
])
// Options that pick the session or its start: left out of the replayed flags.
const SESSION_OPTIONS = new Set([
  'resume',
  'continue',
  'from-pr',
  'fork-session',
  'session-id',
  'name',
  'teleport',
  'cloud',
  'remote',
  'desktop',
  'environment',
  'pool',
  'project',
  'ref',
  'on-branch',
  'correlation-id',
  'metadata',
  'forward-home-settings',
  'resume-session-at',
  'resume-drops-turn',
  'reply-on-resume',
  'rewind-files',
  'worktree',
  'tmux',
  'background',
  'routine',
  'file',
  'init',
  'init-only',
  'maintenance',
  'prefill',
  'prefill-b64',
  'deep-link-origin',
  'deep-link-repo',
  'deep-link-last-fetch',
  'deep-link-cwd-b64',
  'watch-artifact',
  'watch-artifact-no-autoreact',
])
const SAFE_FLAG = /^-[\w/:@=+-]*$/
const SAFE_FLAG_ARGUMENT = /^[\w./:+][\w./:@=+-]*$/
const DEVICE_PATH = /(^|=)\/(dev|proc)\//

type CliOption = {
  short?: string
  long?: string
  required: boolean
  optional: boolean
  variadic: boolean
  name(): string
}

function isFlag(arg: string): boolean {
  return arg.length > 1 && arg.startsWith('-')
}

/**
 * The launch flags worth repeating in the exit hint, like official 2.1.329:
 * '' unless every flag is a known option that can be pasted into a shell
 * unquoted.
 */
export function getResumeHintLaunchFlags(
  options: readonly CliOption[],
  argv: readonly string[],
): string {
  const find = (flag: string) =>
    options.find(o => o.short === flag || o.long === flag)
  const kept: string[] = []
  let i = 0
  while (i < argv.length) {
    const flag = argv[i++]!
    if (flag === '--') break
    if (!isFlag(flag)) continue
    const args: string[] = []
    let option = find(flag)
    if (option) {
      if (option.required) {
        if (i >= argv.length) return ''
        args.push(argv[i++]!)
      } else if (option.optional && i < argv.length && !isFlag(argv[i]!)) {
        args.push(argv[i++]!)
      }
      if (option.variadic) {
        while (i < argv.length && !isFlag(argv[i]!)) args.push(argv[i++]!)
      }
    } else {
      const eq = flag.startsWith('--') ? flag.indexOf('=') : -1
      option = eq > 2 ? find(flag.slice(0, eq)) : undefined
      if (!option || !(option.required || option.optional)) return ''
    }
    if (UNREPLAYABLE_OPTIONS.has(option.name())) return ''
    if (SESSION_OPTIONS.has(option.name())) continue
    if (
      !SAFE_FLAG.test(flag) ||
      !args.every(arg => SAFE_FLAG_ARGUMENT.test(arg)) ||
      [flag, ...args].some(arg => DEVICE_PATH.test(arg))
    ) {
      return ''
    }
    kept.push(flag, ...args)
  }
  return kept.join(' ')
}
