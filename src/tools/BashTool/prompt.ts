import { feature } from 'bun:bundle'
import { prependBullets } from '../../constants/prompts.js'
import { getAttributionTexts } from '../../utils/attribution.js'
import { hasEmbeddedSearchTools } from '../../utils/embeddedTools.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { shouldIncludeGitInstructions } from '../../utils/gitSettings.js'
import { getClaudeTempDir } from '../../utils/permissions/filesystem.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  getDefaultBashTimeoutMs,
  getMaxBashTimeoutMs,
} from '../../utils/timeouts.js'
import {
  getUndercoverInstructions,
  isUndercover,
} from '../../utils/undercover.js'
import { BASH_TOOL_NAME } from './toolName.js'
import { isAnt } from 'src/utils/userType.js'


export function getDefaultTimeoutMs(): number {
  return getDefaultBashTimeoutMs()
}

export function getMaxTimeoutMs(): number {
  return getMaxBashTimeoutMs()
}

function getGitSection(): string {
  if (!shouldIncludeGitInstructions()) return ''
  const { commit, pr } = getAttributionTexts()
  return [
    '# Git',
    '- Commit or push only when the user asks. If on the default branch, branch first.',
    '- Interactive flags (`-i`, e.g. `git rebase -i`) are not supported. Use the `gh` CLI for GitHub (PRs, issues, API).',
    '- GitHub notifies whoever a bare `@name` in a PR, issue or comment names: write one only for a real login you mean to notify, and put roles, placeholders and code (`@reviewer`, `@types/node`) in backticks.',
    ...(commit ? [`- End git commit messages with:\n${commit}`] : []),
    ...(pr ? [`- End PR bodies with:\n${pr}`] : []),
  ].join('\n')
}

function getCommitAndPRInstructions(): string {
  // Defense-in-depth: undercover instructions must survive even if the user
  // has disabled git instructions entirely. Attribution stripping and model-ID
  // hiding are mechanical and work regardless, but the explicit "don't blow
  // your cover" instructions are the last line of defense against the model
  // volunteering an internal codename in a commit message.
  const undercoverSection =
    isAnt() && isUndercover()
      ? getUndercoverInstructions() + '\n'
      : ''

  return undercoverSection
}

// SandboxManager merges config from multiple sources (settings layers, defaults,
// CLI flags) without deduping, so paths like ~/.cache appear 3× in allowOnly.
// Dedup here before inlining into the prompt — affects only what the model sees,
// not sandbox enforcement. Saves ~150-200 tokens/request when sandbox is enabled.
function dedup<T>(arr: T[] | undefined): T[] | undefined {
  if (!arr || arr.length === 0) return arr
  return [...new Set(arr)]
}

function getSimpleSandboxSection(): string {
  if (!SandboxManager.isSandboxingEnabled()) {
    return ''
  }

  const fsReadConfig = SandboxManager.getFsReadConfig()
  const fsWriteConfig = SandboxManager.getFsWriteConfig()
  const networkRestrictionConfig = SandboxManager.getNetworkRestrictionConfig()
  const allowUnixSockets = SandboxManager.getAllowUnixSockets()
  const ignoreViolations = SandboxManager.getIgnoreViolations()
  const allowUnsandboxedCommands =
    SandboxManager.areUnsandboxedCommandsAllowed()

  // Replace the per-UID temp dir literal (e.g. /private/tmp/claude-1001/) with
  // "$TMPDIR" so the prompt is identical across users — avoids busting the
  // cross-user global prompt cache. The sandbox already sets $TMPDIR at runtime.
  const claudeTempDir = getClaudeTempDir()
  const normalizeAllowOnly = (paths: string[]): string[] =>
    [...new Set(paths)].map(p => (p === claudeTempDir ? '$TMPDIR' : p))

  const filesystemConfig = {
    read: {
      denyOnly: dedup(fsReadConfig.denyOnly),
      ...(fsReadConfig.allowWithinDeny && {
        allowWithinDeny: dedup(fsReadConfig.allowWithinDeny),
      }),
    },
    write: {
      allowOnly: normalizeAllowOnly(fsWriteConfig.allowOnly),
      denyWithinAllow: dedup(fsWriteConfig.denyWithinAllow),
    },
  }

  const networkConfig = {
    ...(networkRestrictionConfig?.allowedHosts && {
      allowedHosts: dedup(networkRestrictionConfig.allowedHosts),
    }),
    ...(networkRestrictionConfig?.deniedHosts && {
      deniedHosts: dedup(networkRestrictionConfig.deniedHosts),
    }),
    ...(allowUnixSockets && { allowUnixSockets: dedup(allowUnixSockets) }),
  }

  const restrictionsLines = []
  if (Object.keys(filesystemConfig).length > 0) {
    restrictionsLines.push(`Filesystem: ${jsonStringify(filesystemConfig)}`)
  }
  if (Object.keys(networkConfig).length > 0) {
    restrictionsLines.push(`Network: ${jsonStringify(networkConfig)}`)
  }
  if (ignoreViolations) {
    restrictionsLines.push(
      `Ignored violations: ${jsonStringify(ignoreViolations)}`,
    )
  }

  const sandboxOverrideItems: Array<string | string[]> =
    allowUnsandboxedCommands
      ? [
          'You should always default to running commands within the sandbox. Do NOT attempt to set `dangerouslyDisableSandbox: true` unless:',
          [
            'The user *explicitly* asks you to bypass sandbox',
            'A specific command just failed and you see evidence of sandbox restrictions causing the failure. Note that commands can fail for many reasons unrelated to the sandbox (missing files, wrong arguments, network issues, etc.).',
          ],
          'Evidence of sandbox-caused failures includes:',
          [
            '"Operation not permitted" errors for file/network operations',
            'Access denied to specific paths outside allowed directories',
            'Network connection failures to non-whitelisted hosts',
            'Unix socket connection errors',
          ],
          'When you see evidence of sandbox-caused failure:',
          [
            "Immediately retry with `dangerouslyDisableSandbox: true` (don't ask, just do it)",
            'Briefly explain what sandbox restriction likely caused the failure. Be sure to mention that the user can use the `/sandbox` command to manage restrictions.',
            'This will prompt the user for permission',
          ],
          'Treat each command you execute with `dangerouslyDisableSandbox: true` individually. Even if you have recently run a command with this setting, you should default to running future commands within the sandbox.',
          'Do not suggest adding sensitive paths like ~/.bashrc, ~/.zshrc, ~/.ssh/*, or credential files to the sandbox allowlist.',
        ]
      : [
          'All commands MUST run in sandbox mode - the `dangerouslyDisableSandbox` parameter is disabled by policy.',
          'Commands cannot run outside the sandbox under any circumstances.',
          'If a command fails due to sandbox restrictions, work with the user to adjust sandbox settings instead.',
        ]

  const items: Array<string | string[]> = [
    ...sandboxOverrideItems,
    'For command-local temporary files, use the `$TMPDIR` environment variable. TMPDIR is automatically set to the correct sandbox-writable directory in sandbox mode. Do NOT use `/tmp` directly.',
  ]

  return [
    '',
    '## Command sandbox',
    'By default, your command will be run in a sandbox. This sandbox controls which directories and network hosts commands may access or modify without an explicit override.',
    '',
    'The sandbox has the following restrictions:',
    restrictionsLines.join('\n'),
    '',
    ...prependBullets(items),
  ].join('\n')
}

export function getSimplePrompt(): string {
  // Ant-native builds alias find/grep to embedded bfs/ugrep in Claude's shell.
  const embedded = hasEmbeddedSearchTools()
  const background = !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)
  const monitor = feature('MONITOR_TOOL') ? background : false

  const items: string[] = [
    "The working directory persists between calls, but is reset to the project root if a command leaves it outside the allowed working directories. Shell state (env vars, functions) does not persist; the shell is initialized from the user's profile.",
    'Quote paths that contain spaces. Before creating files in a directory you have not inspected, check it with `ls`.',
    `\`timeout\` is in milliseconds: default ${getDefaultTimeoutMs()}, max ${getMaxTimeoutMs()}.`,
    ...(background
      ? ['`run_in_background` runs the command detached and notifies you when it exits. No `&` needed; do not poll it.']
      : []),
    `Chain dependent commands with '&&' or ';' in one ${BASH_TOOL_NAME} call; multiline scripts are fine.`,
    monitor
      ? 'Do not sleep between commands or retry failures in a sleep loop. Leading `sleep` commands are blocked: to wait for a condition, use Monitor with an until-loop (`until <check>; do sleep 2; done`).'
      : 'Do not sleep between commands or retry failures in a sleep loop; poll with a check command instead.',
    ...(embedded
      ? [
          // bfs (which backs `find`) uses Oniguruma for -regex, which picks the
          // FIRST matching alternative (leftmost-first), unlike GNU find's
          // POSIX leftmost-longest. This silently drops matches when a shorter
          // alternative is a prefix of a longer one.
          "With `find -regex` alternation, put the longest alternative first: `'.*\\.\\(tsx\\|ts\\)'`, not `'.*\\.\\(ts\\|tsx\\)'`, which silently skips `.tsx` files.",
        ]
      : []),
  ]

  return [
    'Executes a bash command and returns its output.',
    '',
    ...items.map(item => `- ${item}`),
    getSimpleSandboxSection(),
    ...(getGitSection() ? ['', getGitSection()] : []),
    ...(getCommitAndPRInstructions() ? ['', getCommitAndPRInstructions()] : []),
  ].join('\n')
}
