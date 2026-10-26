/**
 * Adapter layer that wraps @anthropic-ai/sandbox-runtime with Claude CLI-specific integrations.
 * This file provides the bridge between the external sandbox-runtime package and Claude CLI's
 * settings system, tool integration, and additional features.
 */

import type {
  FsReadRestrictionConfig,
  FsWriteRestrictionConfig,
  IgnoreViolationsConfig,
  NetworkHostPattern,
  NetworkRestrictionConfig,
  SandboxAskCallback,
  SandboxDependencyCheck,
  SandboxRuntimeConfig,
  SandboxViolationEvent,
} from '@anthropic-ai/sandbox-runtime'
import {
  SandboxManager as BaseSandboxManager,
  SandboxRuntimeConfigSchema,
  SandboxViolationStore,
  VENDORED_SRT_WIN_EXE,
  getWindowsSandboxUserStatus,
  resolveSrtWin,
} from '@anthropic-ai/sandbox-runtime'
import { checkLinuxDependencies } from '@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js'
import { execFileSync } from 'child_process'
import { existsSync, realpathSync, rmSync, statSync } from 'fs'
import { readFile } from 'fs/promises'
import { memoize } from 'lodash-es'
import { basename, dirname, join, posix, resolve, sep } from 'path'
import {
  getAdditionalDirectoriesForClaudeMd,
  getCwdState,
  getInlinePlugins,
  getInlinePluginsNoMcp,
  getOriginalCwd,
} from '../../bootstrap/state.js'
import { CACHE_PATHS } from '../cachePaths.js'
import { logForDebugging } from '../debug.js'
import { extractEmbeddedBinary } from '../embeddedRipgrep.js'
import { expandPath } from '../path.js'
import { getPlatform, type Platform } from '../platform.js'
import { settingsChangeDetector } from '../settings/changeDetector.js'
import {
  isSettingSourceEnabled,
  SETTING_SOURCES,
  type SettingSource,
} from '../settings/constants.js'
import { getManagedSettingsDropInDir } from '../settings/managedPath.js'
import {
  getInitialSettings,
  getSettings_DEPRECATED,
  getSettingsFilePathForSource,
  getSettingsForSource,
  getSettingsRootPathForSource,
  updateSettingsForSource,
} from '../settings/settings.js'
import type { SettingsJson } from '../settings/types.js'

// ============================================================================
// Settings Converter
// ============================================================================

import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { WEB_FETCH_TOOL_NAME } from 'src/tools/WebFetchTool/prompt.js'
import { errorMessage } from '../errors.js'
import {
  getClaudeTempDir,
  getClaudeTempDirName,
  pathInWorkingPath,
} from '../permissions/filesystem.js'
import type { PermissionRuleValue } from '../permissions/PermissionRule.js'
import { ripgrepCommand } from '../ripgrep.js'

// Local copies to avoid circular dependency
// (permissions.ts imports SandboxManager, bashPermissions.ts imports permissions.ts)
function permissionRuleValueFromString(
  ruleString: string,
): PermissionRuleValue {
  const matches = ruleString.match(/^([^(]+)\(([^)]+)\)$/)
  if (!matches) {
    return { toolName: ruleString }
  }
  const toolName = matches[1]
  const ruleContent = matches[2]
  if (!toolName || !ruleContent) {
    return { toolName: ruleString }
  }
  return { toolName, ruleContent }
}

function permissionRuleExtractPrefix(permissionRule: string): string | null {
  const match = permissionRule.match(/^(.+):\*$/)
  return match?.[1] ?? null
}

/**
 * Resolve Claude Code-specific path patterns for sandbox-runtime.
 *
 * Claude Code uses special path prefixes in permission rules:
 * - `//path` → absolute from filesystem root (becomes `/path`)
 * - `/path` → relative to settings file directory (becomes `$SETTINGS_DIR/path`)
 * - `~/path` → passed through (sandbox-runtime handles this)
 * - `./path` or `path` → passed through (sandbox-runtime handles this)
 *
 * This function only handles CC-specific conventions (`//` and `/`).
 * Standard path patterns like `~/` and relative paths are passed through
 * for sandbox-runtime's normalizePathForSandbox to handle.
 *
 * @param pattern The path pattern from a permission rule
 * @param source The settings source this pattern came from (needed to resolve `/path` patterns)
 */
export function resolvePathPatternForSandbox(
  pattern: string,
  source: SettingSource,
): string {
  // Handle // prefix - absolute from root (CC-specific convention)
  if (pattern.startsWith('//')) {
    return pattern.slice(1) // "//.aws/**" → "/.aws/**"
  }

  // Handle / prefix - relative to settings file directory (CC-specific convention)
  // Note: ~/path and relative paths are passed through for sandbox-runtime to handle
  if (pattern.startsWith('/') && !pattern.startsWith('//')) {
    const root = getSettingsRootPathForSource(source)
    // Pattern like "/foo/**" becomes "${root}/foo/**"
    return resolve(root, pattern.slice(1))
  }

  // Other patterns (~/path, ./path, path) pass through as-is
  // sandbox-runtime's normalizePathForSandbox will handle them
  return pattern
}

/**
 * Resolve paths from sandbox.filesystem.* settings (allowWrite, denyWrite, etc).
 *
 * Unlike permission rules (Edit/Read), these settings use standard path semantics:
 * - `/path` → absolute path (as written, NOT settings-relative)
 * - `~/path` → expanded to home directory
 * - `./path` or `path` → relative to settings file directory
 * - `//path` → absolute (legacy permission-rule syntax, accepted for compat)
 *
 * Fix for #30067: resolvePathPatternForSandbox treats `/Users/foo/.cargo` as
 * settings-relative (permission-rule convention). Users reasonably expect
 * absolute paths in sandbox.filesystem.allowWrite to work as-is.
 *
 * Also expands `~` here rather than relying on sandbox-runtime, because
 * sandbox-runtime's getFsWriteConfig() does not call normalizePathForSandbox
 * on allowWrite paths (it only strips trailing glob suffixes).
 */
export function resolveSandboxFilesystemPath(
  pattern: string,
  source: SettingSource,
): string {
  // Legacy permission-rule escape: //path → /path. Kept for compat with
  // users who worked around #30067 by writing //Users/foo/.cargo in config.
  if (pattern.startsWith('//')) return pattern.slice(1)
  return expandPath(pattern, getSettingsRootPathForSource(source))
}

/**
 * Check if only managed sandbox domains should be used.
 * This is true when policySettings has sandbox.network.allowManagedDomainsOnly: true
 */
export function shouldAllowManagedSandboxDomainsOnly(): boolean {
  return (
    getSettingsForSource('policySettings')?.sandbox?.network
      ?.allowManagedDomainsOnly === true
  )
}

// Sources the repo cannot write: settings that loosen the sandbox or hand it
// credentials are only honored from these. Highest priority first.
const TRUSTED_SANDBOX_SOURCES = [
  'policySettings',
  'flagSettings',
  'userSettings',
] as const

function isTrustedSandboxSource(source: SettingSource): boolean {
  return (TRUSTED_SANDBOX_SOURCES as readonly string[]).includes(source)
}

function trustedSandboxValue<T>(
  pick: (sandbox: NonNullable<SettingsJson['sandbox']>) => T | undefined,
): T | undefined {
  for (const source of TRUSTED_SANDBOX_SOURCES.filter(isSettingSourceEnabled)) {
    const sandbox = getSettingsForSource(source)?.sandbox
    const value = sandbox ? pick(sandbox) : undefined
    if (value !== undefined) return value
  }
  return undefined
}

function isUnsandboxedFallbackLocked(): boolean {
  return (['policySettings', 'flagSettings'] as const).some(
    source =>
      getSettingsForSource(source)?.sandbox?.allowUnsandboxedCommands === false,
  )
}

function shouldAllowManagedReadPathsOnly(): boolean {
  return (
    getSettingsForSource('policySettings')?.sandbox?.filesystem
      ?.allowManagedReadPathsOnly === true
  )
}

/**
 * Convert Claude Code settings format to SandboxRuntimeConfig format
 * (Function exported for testing)
 *
 * @param settings Merged settings (used for sandbox config like network, ripgrep, etc.)
 */
export function convertToSandboxRuntimeConfig(
  settings: SettingsJson,
): SandboxRuntimeConfig {
  const permissions = settings.permissions || {}

  // Extract network domains from WebFetch rules
  const allowedDomains: string[] = []
  const deniedDomains: string[] = []

  // When allowManagedSandboxDomainsOnly is enabled, only use domains from policy settings
  if (shouldAllowManagedSandboxDomainsOnly()) {
    const policySettings = getSettingsForSource('policySettings')
    for (const domain of policySettings?.sandbox?.network?.allowedDomains ||
      []) {
      allowedDomains.push(domain)
    }
    for (const ruleString of policySettings?.permissions?.allow || []) {
      const rule = permissionRuleValueFromString(ruleString)
      if (
        rule.toolName === WEB_FETCH_TOOL_NAME &&
        rule.ruleContent?.startsWith('domain:')
      ) {
        allowedDomains.push(rule.ruleContent.substring('domain:'.length))
      }
    }
  } else {
    // Under a strict allowlist the repo's own settings cannot extend it.
    const strict = trustedSandboxValue(sb => sb.network?.strictAllowlist)
    for (const source of SETTING_SOURCES.filter(isSettingSourceEnabled)) {
      if (strict && (source === 'projectSettings' || source === 'localSettings')) {
        continue
      }
      allowedDomains.push(
        ...(getSettingsForSource(source)?.sandbox?.network?.allowedDomains ?? []),
      )
    }
    for (const ruleString of permissions.allow || []) {
      const rule = permissionRuleValueFromString(ruleString)
      if (
        rule.toolName === WEB_FETCH_TOOL_NAME &&
        rule.ruleContent?.startsWith('domain:')
      ) {
        allowedDomains.push(rule.ruleContent.substring('domain:'.length))
      }
    }
  }

  for (const ruleString of permissions.deny || []) {
    const rule = permissionRuleValueFromString(ruleString)
    if (
      rule.toolName === WEB_FETCH_TOOL_NAME &&
      rule.ruleContent?.startsWith('domain:')
    ) {
      deniedDomains.push(rule.ruleContent.substring('domain:'.length))
    }
  }
  deniedDomains.push(...(settings.sandbox?.network?.deniedDomains ?? []))

  // Extract filesystem paths from Edit and Read rules
  // Always include current directory and Claude temp directory as writable
  // The temp directory is needed for Shell.ts cwd tracking files
  const allowWrite: string[] = ['.', getClaudeTempDir()]
  const denyWrite: string[] = []
  const denyRead: string[] = []
  const allowRead: string[] = []

  // Always deny writes to settings.json files to prevent sandbox escape
  // This blocks settings in the original working directory (where Claude Code started)
  const settingsPaths = SETTING_SOURCES.map(source =>
    getSettingsFilePathForSource(source),
  ).filter((p): p is string => p !== undefined)
  denyWrite.push(...settingsPaths)
  denyWrite.push(getManagedSettingsDropInDir())

  // Also block settings files in the current working directory if it differs from original
  // This handles the case where the user has cd'd to a different directory
  const cwd = getCwdState()
  const originalCwd = getOriginalCwd()
  if (cwd !== originalCwd) {
    denyWrite.push(resolve(cwd, '.claude', 'settings.json'))
    denyWrite.push(resolve(cwd, '.claude', 'settings.local.json'))
  }

  // Block writes to .claude/skills in both original and current working directories.
  // The sandbox-runtime's getDangerousDirectories() protects .claude/commands and
  // .claude/agents but not .claude/skills. Skills have the same privilege level
  // (auto-discovered, auto-loaded, full Claude capabilities) so they need the
  // same OS-level sandbox protection.
  denyWrite.push(resolve(originalCwd, '.claude', 'skills'))
  if (cwd !== originalCwd) {
    denyWrite.push(resolve(cwd, '.claude', 'skills'))
  }

  // --plugin-dir code is reloaded and run outside the sandbox.
  for (const dir of [...getInlinePlugins(), ...getInlinePluginsNoMcp()]) {
    denyWrite.push(resolve(originalCwd, dir))
  }

  // SECURITY: Git's is_git_directory() treats cwd as a bare repo if it has
  // HEAD + objects/ + refs/. An attacker planting these (plus a config with
  // core.fsmonitor) escapes the sandbox when Claude's unsandboxed git runs.
  //
  // Unconditionally denying these paths makes sandbox-runtime mount
  // /dev/null at non-existent ones, which (a) leaves a 0-byte HEAD stub on
  // the host and (b) breaks `git log HEAD` inside bwrap ("ambiguous argument").
  // So: if a file exists, denyWrite (ro-bind in place, no stub). If not, scrub
  // it post-command in scrubBareGitRepoFiles() — planted files are gone before
  // unsandboxed git runs; inside the command, git is itself sandboxed.
  // Outside an existing bare-repo layout, project folders named `hooks/` or
  // `config/` stay writable and a planted bare repo is broken by scrubbing
  // only the HEAD/objects/refs it added.
  bareGitRepoScrubDirs.length = 0
  const bareGitRepoFiles = ['HEAD', 'objects', 'refs', 'hooks', 'config']
  for (const dir of cwd === originalCwd ? [originalCwd] : [originalCwd, cwd]) {
    // eslint-disable-next-line custom-rules/no-sync-fs -- refreshConfig() must be sync
    const isBareRepo = BARE_GIT_REPO_MARKERS.every(f => existsSync(resolve(dir, f)))
    const planted: string[] = []
    for (const gitFile of bareGitRepoFiles) {
      const p = resolve(dir, gitFile)
      let stat
      try {
        // eslint-disable-next-line custom-rules/no-sync-fs -- refreshConfig() must be sync
        stat = statSync(p)
      } catch {
        if (isBareRepo || BARE_GIT_REPO_MARKERS.includes(gitFile)) {
          planted.push(p)
        }
        continue
      }
      if (
        isBareRepo ||
        BARE_GIT_REPO_MARKERS.includes(gitFile) ||
        (gitFile === 'config' && !stat.isDirectory())
      ) {
        denyWrite.push(p)
      }
    }
    bareGitRepoScrubDirs.push({ dir, planted })
  }

  // If we detected a git worktree during initialize(), the main repo path is
  // cached in worktreeMainRepoPath. Git operations in a worktree need write
  // access to the main repo's .git directory for index.lock etc.
  // This is resolved once at init time (worktree status doesn't change mid-session).
  // Only the shared .git is opened, and its hooks and config stay read-only
  // because unsandboxed git runs them.
  if (worktreeMainRepoPath && worktreeMainRepoPath !== cwd) {
    const gitDir = join(worktreeMainRepoPath, '.git')
    allowWrite.push(gitDir)
    denyWrite.push(join(gitDir, 'hooks'), join(gitDir, 'config'))
  }

  // Include directories added via --add-dir CLI flag or /add-dir command.
  // These must be in allowWrite so that Bash commands (which run inside the
  // sandbox) can access them — not just file tools, which check permissions
  // at the app level via pathInAllowedWorkingPath().
  // Two sources: persisted in settings, and session-only in bootstrap state.
  const additionalDirs = new Set([
    ...(settings.permissions?.additionalDirectories || []),
    ...getAdditionalDirectoriesForClaudeMd(),
  ])
  allowWrite.push(...additionalDirs)

  const trustedDenyRead: string[] = []
  const repoAllowRead: string[] = []

  // Iterate through each settings source to resolve paths correctly
  // Path patterns like `/foo` are relative to the settings file directory,
  // so we need to know which source each rule came from
  for (const source of SETTING_SOURCES.filter(isSettingSourceEnabled)) {
    const sourceSettings = getSettingsForSource(source)

    // Extract filesystem paths from permission rules
    if (sourceSettings?.permissions) {
      for (const ruleString of sourceSettings.permissions.allow || []) {
        const rule = permissionRuleValueFromString(ruleString)
        if (rule.toolName === FILE_EDIT_TOOL_NAME && rule.ruleContent) {
          allowWrite.push(
            resolvePathPatternForSandbox(rule.ruleContent, source),
          )
        }
      }

      for (const ruleString of sourceSettings.permissions.deny || []) {
        const rule = permissionRuleValueFromString(ruleString)
        if (rule.toolName === FILE_EDIT_TOOL_NAME && rule.ruleContent) {
          denyWrite.push(resolvePathPatternForSandbox(rule.ruleContent, source))
        }
        if (rule.toolName === FILE_READ_TOOL_NAME && rule.ruleContent) {
          denyRead.push(resolvePathPatternForSandbox(rule.ruleContent, source))
        }
      }
    }

    // Extract filesystem paths from sandbox.filesystem settings
    // sandbox.filesystem.* uses standard path semantics (/path = absolute),
    // NOT the permission-rule convention (/path = settings-relative). #30067
    const fs = sourceSettings?.sandbox?.filesystem
    if (fs) {
      for (const p of fs.allowWrite || []) {
        allowWrite.push(resolveSandboxFilesystemPath(p, source))
      }
      for (const p of fs.denyWrite || []) {
        denyWrite.push(resolveSandboxFilesystemPath(p, source))
      }
      for (const p of fs.denyRead || []) {
        denyRead.push(resolveSandboxFilesystemPath(p, source))
        if (isTrustedSandboxSource(source)) {
          trustedDenyRead.push(resolveSandboxFilesystemPath(p, source))
        }
      }
      if (!shouldAllowManagedReadPathsOnly() || source === 'policySettings') {
        for (const p of fs.allowRead || []) {
          const path = resolveSandboxFilesystemPath(p, source)
          if (isTrustedSandboxSource(source)) allowRead.push(path)
          else repoAllowRead.push(path)
        }
      }
    }
  }
  // Under a locked sandbox, the repo's allowRead cannot re-open a path that
  // trusted settings deny, nor use globs or network paths to do so; carving
  // out of the repo's own denyRead still works.
  const overlaps = (a: string, b: string) =>
    a === b || a.startsWith(b + sep) || b.startsWith(a + sep)
  allowRead.push(
    ...(isUnsandboxedFallbackLocked()
      ? repoAllowRead.filter(
          p =>
            !/[*?[\]{}]/.test(p) &&
            !p.startsWith('//') &&
            !trustedDenyRead.some(d => overlaps(p, d)),
        )
      : repoAllowRead),
  )
  // Ripgrep config for sandbox. User settings take priority; otherwise pass our rg.
  // In embedded mode (argv0='rg' dispatch), sandbox-runtime spawns with argv0 set.
  // Project settings cannot swap the binary the sandbox runs.
  const { rgPath, rgArgs, argv0 } = ripgrepCommand()
  const ripgrepConfig = trustedSandboxValue(sb => sb.ripgrep) ?? {
    command: rgPath,
    args: rgArgs,
    argv0,
  }

  // An admin who deployed filesystem restrictions must not have them switched
  // off by a user-writable file.
  const policySandbox = getSettingsForSource('policySettings')?.sandbox
  const filesystemDisabled =
    policySandbox?.filesystem !== undefined ||
    policySandbox?.credentials?.files?.some(f => f.mode === 'deny')
      ? policySandbox?.filesystem?.disabled
      : trustedSandboxValue(sb => sb.filesystem?.disabled)

  const credentialFiles: NonNullable<
    NonNullable<SandboxRuntimeConfig['credentials']>['files']
  > = []
  const credentialEnvVars: NonNullable<
    NonNullable<SandboxRuntimeConfig['credentials']>['envVars']
  > = []
  // The repo may add deny entries; mask entries (real values injected at the
  // proxy) only come from trusted sources.
  for (const source of SETTING_SOURCES.filter(isSettingSourceEnabled)) {
    const trusted = isTrustedSandboxSource(source)
    const credentials = getSettingsForSource(source)?.sandbox?.credentials
    for (const file of credentials?.files ?? []) {
      if (trusted || file.mode === 'deny') {
        credentialFiles.push({
          ...file,
          path: resolveSandboxFilesystemPath(file.path, source),
        })
      }
    }
    credentialEnvVars.push(
      ...(credentials?.envVars ?? []).filter(v => trusted || v.mode === 'deny'),
    )
  }
  const hasCredentials =
    credentialFiles.length > 0 || credentialEnvVars.length > 0

  return {
    network: {
      allowedDomains,
      deniedDomains,
      allowUnixSockets: settings.sandbox?.network?.allowUnixSockets,
      allowAllUnixSockets: settings.sandbox?.network?.allowAllUnixSockets,
      allowLocalBinding: settings.sandbox?.network?.allowLocalBinding,
      // The repo cannot route traffic around a managed deny list or a locked sandbox.
      ...(policySandbox?.network?.deniedDomains?.length ||
      isUnsandboxedFallbackLocked()
        ? {
            httpProxyPort: trustedSandboxValue(sb => sb.network?.httpProxyPort),
            socksProxyPort: trustedSandboxValue(
              sb => sb.network?.socksProxyPort,
            ),
          }
        : {
            httpProxyPort: settings.sandbox?.network?.httpProxyPort,
            socksProxyPort: settings.sandbox?.network?.socksProxyPort,
          }),
      allowMachLookup: settings.sandbox?.network?.allowMachLookup,
      strictAllowlist: trustedSandboxValue(sb => sb.network?.strictAllowlist),
      tlsTerminate: trustedSandboxValue(sb => sb.network?.tlsTerminate),
    },
    filesystem: {
      denyRead,
      allowRead,
      allowWrite,
      denyWrite:
        getPlatform() === 'windows'
          ? denyWrite.filter(p => isInsideWindowsWriteGrant(p, allowWrite))
          : denyWrite,
      disabled: filesystemDisabled,
    },
    ...(hasCredentials && {
      credentials: {
        files: credentialFiles,
        envVars: credentialEnvVars,
        allowPlaintextInject: trustedSandboxValue(
          sb => sb.credentials?.allowPlaintextInject,
        ),
        awsPairs: trustedSandboxValue(sb => sb.credentials?.awsPairs),
        sigv4: trustedSandboxValue(sb => sb.credentials?.sigv4),
      },
    }),
    ignoreViolations: settings.sandbox?.ignoreViolations,
    enableWeakerNestedSandbox: settings.sandbox?.enableWeakerNestedSandbox,
    enableWeakerNetworkIsolation:
      settings.sandbox?.enableWeakerNetworkIsolation,
    allowAppleEvents: settings.sandbox?.allowAppleEvents,
    ripgrep: ripgrepConfig,
    bwrapPath: policySandbox?.bwrapPath,
    socatPath: policySandbox?.socatPath,
    ...(getPlatform() === 'windows' &&
      getSrtWinPath() && { windows: { srtWin: { path: getSrtWinPath()! } } }),
  }
}

/**
 * The Windows sandbox user can write only where it is granted, so a write
 * deny outside every grant changes nothing. srt-win still stamps each one,
 * and stamping under the user's profile or Program Files is slow or fails.
 */
function isInsideWindowsWriteGrant(
  path: string,
  allowWrite: string[],
): boolean {
  // Compare long names: a grant and a deny may spell one folder in 8.3 form.
  const longPath = (p: string): string => {
    const rest: string[] = []
    for (let dir = resolve(getCwdState(), p); ; ) {
      try {
        return join(realpathSync.native(dir), ...rest)
      } catch {
        const parent = dirname(dir)
        if (parent === dir) return resolve(getCwdState(), p)
        rest.unshift(basename(dir))
        dir = parent
      }
    }
  }
  const target = longPath(path)
  return allowWrite.some(root => pathInWorkingPath(target, longPath(root)))
}

/**
 * srt-win.exe, which the Windows sandbox spawns. The compiled binary embeds
 * it; a source checkout uses the runtime's vendored copy.
 */
export const getSrtWinPath = memoize((): string | undefined => {
  const sourcePath = process.env.CLAUDE_CODE_EMBEDDED_SRT_WIN_PATH
  const version = process.env.CLAUDE_CODE_EMBEDDED_SRT_WIN_VERSION
  if (sourcePath && version) {
    return extractEmbeddedBinary(
      sourcePath,
      join(CACHE_PATHS.srtWin(), `${version}-${process.arch}`, 'srt-win.exe'),
    )
  }
  return existsSync(VENDORED_SRT_WIN_EXE) ? VENDORED_SRT_WIN_EXE : undefined
})

// ============================================================================
// Claude CLI-specific state
// ============================================================================

let initializationPromise: Promise<void> | undefined
let settingsSubscriptionCleanup: (() => void) | undefined

// Cached main repo path for git worktrees, resolved once during initialize().
// In a worktree, .git is a file containing "gitdir: /path/to/main/repo/.git/worktrees/name".
// undefined = not yet resolved; null = not a worktree or detection failed.
let worktreeMainRepoPath: string | null | undefined

// Git treats a folder holding all of these as a bare repo.
const BARE_GIT_REPO_MARKERS = ['HEAD', 'objects', 'refs']

// Bare-repo files at cwd that didn't exist at config time and should be
// scrubbed if they complete a bare-repo layout after a sandboxed command:
// the missing markers, or hooks/config when the layout already existed.
// See anthropics/claude-code#29316.
const bareGitRepoScrubDirs: Array<{ dir: string; planted: string[] }> = []

/**
 * Delete bare-repo files planted at cwd during a sandboxed command, before
 * Claude's unsandboxed git calls can see them. See the SECURITY block above
 * bareGitRepoFiles. anthropics/claude-code#29316.
 */
function scrubBareGitRepoFiles(): void {
  for (const { dir, planted } of bareGitRepoScrubDirs) {
    // eslint-disable-next-line custom-rules/no-sync-fs -- cleanupAfterCommand must be sync (Shell.ts:367)
    if (!BARE_GIT_REPO_MARKERS.every(f => existsSync(resolve(dir, f)))) {
      continue
    }
    for (const p of planted) {
      try {
        // eslint-disable-next-line custom-rules/no-sync-fs -- cleanupAfterCommand must be sync (Shell.ts:367)
        rmSync(p, { recursive: true })
        logForDebugging(`[Sandbox] scrubbed planted bare-repo file: ${p}`)
      } catch {
        // ENOENT: this one was not planted
      }
    }
  }
}

/**
 * Detect if cwd is a git worktree and resolve the main repo path.
 * Called once during initialize() and cached for the session.
 * In a worktree, .git is a file (not a directory) containing "gitdir: ...".
 * If .git is a directory, readFile throws EISDIR and we return null.
 */
async function detectWorktreeMainRepoPath(cwd: string): Promise<string | null> {
  const gitPath = join(cwd, '.git')
  try {
    const gitContent = await readFile(gitPath, { encoding: 'utf8' })
    const gitdirMatch = gitContent.match(/^gitdir:\s*(.+)$/m)
    if (!gitdirMatch?.[1]) {
      return null
    }
    // gitdir may be relative (rare, but git accepts it) — resolve against cwd
    const gitdir = resolve(cwd, gitdirMatch[1].trim())
    // gitdir format: /path/to/main/repo/.git/worktrees/worktree-name
    // Match the /.git/worktrees/ segment specifically — indexOf('.git') alone
    // would false-match paths like /home/user/.github-projects/...
    const marker = `${sep}.git${sep}worktrees${sep}`
    const markerIndex = gitdir.lastIndexOf(marker)
    if (markerIndex > 0) {
      return gitdir.substring(0, markerIndex)
    }
    return null
  } catch {
    // Not in a worktree, .git is a directory (EISDIR), or can't read .git file
    return null
  }
}

/**
 * Check if dependencies are available (memoized)
 * Returns { errors, warnings } - errors mean sandbox cannot run
 */
const checkDependencies = memoize((): SandboxDependencyCheck => {
  if (getPlatform() === 'windows') return checkWindowsDependencies()
  const { rgPath, rgArgs } = ripgrepCommand()
  const result = BaseSandboxManager.checkDependencies({
    command: rgPath,
    args: rgArgs,
  })
  const { bwrapPath, socatPath } =
    getSettingsForSource('policySettings')?.sandbox ?? {}
  const platform = getPlatform()
  if ((!bwrapPath && !socatPath) || (platform !== 'linux' && platform !== 'wsl')) {
    return result
  }
  // The runtime only reads binary overrides from an initialized config, so
  // swap its PATH-based bwrap/socat findings for ones against the overrides.
  const onPath = checkLinuxDependencies({})
  return {
    errors: [
      ...result.errors.filter(e => !onPath.errors.includes(e)),
      ...checkLinuxDependencies({ bwrapPath, socatPath }).errors,
    ],
    warnings: result.warnings,
  }
})

/**
 * The runtime only finds srt-win through an initialized config, so probe the
 * install here. srt-win starts the command as the `srt-sandbox` user, which
 * needs read and execute on srt-win.exe itself; the extracted copy lives in
 * the user's profile, which that user cannot read.
 */
function checkWindowsDependencies(): SandboxDependencyCheck {
  const path = getSrtWinPath()
  if (!path) {
    return { errors: ['srt-win.exe not found'], warnings: [] }
  }
  let sid: string | undefined
  try {
    const user = getWindowsSandboxUserStatus({
      srtWin: resolveSrtWin({ path }),
    })
    if (user.provisioned && user.credPresent) sid = user.sid
  } catch (error) {
    return {
      errors: [`srt-win user status failed: ${errorMessage(error)}`],
      warnings: [],
    }
  }
  if (!sid) {
    return {
      errors: [
        'the Windows sandbox is not installed (run `claude sandbox install`, one UAC prompt)',
      ],
      warnings: [],
    }
  }
  try {
    execFileSync('icacls', [path, '/grant', `*${sid}:RX`], {
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch (error) {
    return {
      errors: [`could not let the sandbox user run ${path}: ${errorMessage(error)}`],
      warnings: [],
    }
  }
  return { errors: [], warnings: [] }
}

function getSandboxEnabledSetting(): boolean {
  try {
    const settings = getSettings_DEPRECATED()
    return settings?.sandbox?.enabled ?? false
  } catch (error) {
    logForDebugging(`Failed to get settings for sandbox check: ${error}`)
    return false
  }
}

function isAutoAllowBashIfSandboxedEnabled(): boolean {
  const settings = getSettings_DEPRECATED()
  return settings?.sandbox?.autoAllowBashIfSandboxed ?? true
}

function areUnsandboxedCommandsAllowed(): boolean {
  const settings = getSettings_DEPRECATED()
  return settings?.sandbox?.allowUnsandboxedCommands ?? true
}

function isSandboxRequired(): boolean {
  const settings = getSettings_DEPRECATED()
  return (
    getSandboxEnabledSetting() &&
    (settings?.sandbox?.failIfUnavailable ?? false)
  )
}

/**
 * Check if the current platform is supported for sandboxing (memoized)
 * Supports: macOS, Linux, and WSL2+ (WSL1 is not supported)
 */
const isSupportedPlatform = memoize((): boolean => {
  return BaseSandboxManager.isSupportedPlatform()
})

/**
 * Check if the current platform is in the enabledPlatforms list.
 *
 * This is an undocumented setting that allows restricting sandbox to specific platforms.
 * When enabledPlatforms is not set, all supported platforms are allowed.
 *
 * Added to unblock NVIDIA enterprise rollout: they want to enable autoAllowBashIfSandboxed
 * but only on macOS initially, since Linux/WSL sandbox support is newer. This allows
 * setting enabledPlatforms: ["macos"] to disable sandbox (and auto-allow) on other platforms.
 */
function isPlatformInEnabledList(): boolean {
  try {
    const settings = getInitialSettings()
    const enabledPlatforms = (
      settings?.sandbox as { enabledPlatforms?: Platform[] } | undefined
    )?.enabledPlatforms

    if (enabledPlatforms === undefined) {
      return true
    }

    if (enabledPlatforms.length === 0) {
      return false
    }

    const currentPlatform = getPlatform()
    return enabledPlatforms.includes(currentPlatform)
  } catch (error) {
    logForDebugging(`Failed to check enabledPlatforms: ${error}`)
    return true // Default to enabled if we can't read settings
  }
}

/**
 * Check if sandboxing is enabled
 * This checks the user's enabled setting, platform support, and enabledPlatforms restriction
 */
function isSandboxingEnabled(): boolean {
  // Settings first: the dependency probe spawns processes, so skip it for
  // the default (sandbox off) case.
  if (!getSandboxEnabledSetting()) {
    return false
  }

  if (!isSupportedPlatform()) {
    return false
  }

  if (checkDependencies().errors.length > 0) {
    return false
  }

  // Check if current platform is in the enabledPlatforms list (undocumented setting)
  if (!isPlatformInEnabledList()) {
    return false
  }

  return true
}

/**
 * If the user explicitly enabled sandbox (sandbox.enabled: true in settings)
 * but it cannot actually run, return a human-readable reason. Otherwise
 * return undefined.
 *
 * Fix for #34044: previously isSandboxingEnabled() silently returned false
 * when dependencies were missing, giving users zero feedback that their
 * explicit security setting was being ignored. This is a security footgun —
 * users configure allowedDomains expecting enforcement, get none.
 *
 * Call this once at startup (REPL/print) and surface the reason if present.
 * Does not cover the case where the user never enabled sandbox (no noise).
 */
function getSandboxUnavailableReason(): string | undefined {
  // Only warn if user explicitly asked for sandbox. If they didn't enable
  // it, missing deps are irrelevant.
  if (!getSandboxEnabledSetting()) {
    return undefined
  }

  if (!isSupportedPlatform()) {
    const platform = getPlatform()
    if (platform === 'wsl') {
      return 'sandbox.enabled is set but WSL1 is not supported (requires WSL2)'
    }
    return `sandbox.enabled is set but ${platform} is not supported (requires macOS, Linux, WSL2, or Windows)`
  }

  if (!isPlatformInEnabledList()) {
    return `sandbox.enabled is set but ${getPlatform()} is not in sandbox.enabledPlatforms`
  }

  const deps = checkDependencies()
  if (deps.errors.length > 0) {
    const platform = getPlatform()
    const hint =
      platform === 'macos' || platform === 'windows'
        ? 'run /sandbox or /doctor for details'
        : 'install missing tools (e.g. apt install bubblewrap socat) or run /sandbox for details'
    return `sandbox.enabled is set but dependencies are missing: ${deps.errors.join(', ')} · ${hint}`
  }

  return undefined
}

/**
 * Get glob patterns that won't work fully on Linux/WSL
 */
function getLinuxGlobPatternWarnings(): string[] {
  // Only return warnings on Linux/WSL (bubblewrap doesn't support globs)
  const platform = getPlatform()
  if (platform !== 'linux' && platform !== 'wsl') {
    return []
  }

  try {
    const settings = getSettings_DEPRECATED()

    // Only return warnings when sandboxing is enabled (check settings directly, not cached value)
    if (!settings?.sandbox?.enabled) {
      return []
    }

    const permissions = settings?.permissions || {}
    const warnings: string[] = []

    // Helper to check if a path has glob characters (excluding trailing /**)
    const hasGlobs = (path: string): boolean => {
      const stripped = path.replace(/\/\*\*$/, '')
      return /[*?[\]]/.test(stripped)
    }

    // Check all permission rules
    for (const ruleString of [
      ...(permissions.allow || []),
      ...(permissions.deny || []),
    ]) {
      const rule = permissionRuleValueFromString(ruleString)
      if (
        (rule.toolName === FILE_EDIT_TOOL_NAME ||
          rule.toolName === FILE_READ_TOOL_NAME) &&
        rule.ruleContent &&
        hasGlobs(rule.ruleContent)
      ) {
        warnings.push(ruleString)
      }
    }

    return warnings
  } catch (error) {
    logForDebugging(`Failed to get Linux glob pattern warnings: ${error}`)
    return []
  }
}

/**
 * Check if sandbox settings are locked by policy
 */
function areSandboxSettingsLockedByPolicy(): boolean {
  // Check if sandbox settings are explicitly set in any source that overrides localSettings
  // These sources have higher priority than localSettings and would make local changes ineffective
  const overridingSources = ['flagSettings', 'policySettings'] as const

  for (const source of overridingSources) {
    const settings = getSettingsForSource(source)
    if (
      settings?.sandbox?.enabled !== undefined ||
      settings?.sandbox?.autoAllowBashIfSandboxed !== undefined ||
      settings?.sandbox?.allowUnsandboxedCommands !== undefined
    ) {
      return true
    }
  }

  return false
}

/**
 * Set sandbox settings
 */
async function setSandboxSettings(options: {
  enabled?: boolean
  autoAllowBashIfSandboxed?: boolean
  allowUnsandboxedCommands?: boolean
}): Promise<void> {
  const existingSettings = getSettingsForSource('localSettings')

  // Note: Memoized caches auto-invalidate when settings change because they use
  // the settings object as the cache key (new settings object = cache miss)

  updateSettingsForSource('localSettings', {
    sandbox: {
      ...existingSettings?.sandbox,
      ...(options.enabled !== undefined && { enabled: options.enabled }),
      ...(options.autoAllowBashIfSandboxed !== undefined && {
        autoAllowBashIfSandboxed: options.autoAllowBashIfSandboxed,
      }),
      ...(options.allowUnsandboxedCommands !== undefined && {
        allowUnsandboxedCommands: options.allowUnsandboxedCommands,
      }),
    },
  })
}

/**
 * Get excluded commands (commands that should not be sandboxed)
 */
function getExcludedCommands(): string[] {
  const settings = getSettings_DEPRECATED()
  const excluded = settings?.sandbox?.excludedCommands ?? []
  // Under an admin-locked sandbox the repo's own settings cannot exempt commands.
  const locked =
    shouldAllowManagedSandboxDomainsOnly() || isUnsandboxedFallbackLocked()
  if (!locked) {
    return excluded
  }
  const trusted = new Set(
    (['userSettings', 'flagSettings', 'policySettings'] as const)
      .filter(isSettingSourceEnabled)
      .flatMap(
        source => getSettingsForSource(source)?.sandbox?.excludedCommands ?? [],
      ),
  )
  return excluded.filter(command => trusted.has(command))
}

/**
 * Wrap command with sandbox, optionally specifying the shell to use
 */
async function wrapWithSandbox(
  command: string,
  binShell?: string,
  customConfig?: Partial<SandboxRuntimeConfig>,
  abortSignal?: AbortSignal,
): Promise<string> {
  // If sandboxing is enabled, ensure initialization is complete
  if (isSandboxingEnabled()) {
    if (initializationPromise) {
      await initializationPromise
    } else {
      throw new Error('Sandbox failed to initialize. ')
    }
  }

  // sandbox-runtime sets TMPDIR inside the sandbox from CLAUDE_TMPDIR (default
  // /tmp/claude); point it at the per-user dir Shell.ts creates and allows.
  process.env.CLAUDE_TMPDIR = posix.join(
    process.env.CLAUDE_CODE_TMPDIR || '/tmp',
    getClaudeTempDirName(),
  )
  return BaseSandboxManager.wrapWithSandbox(
    command,
    binShell,
    customConfig,
    abortSignal,
  )
}

/**
 * Wrap command with sandbox as an argv to spawn with `shell: false`. This is
 * the only form the runtime supports on Windows.
 */
async function wrapWithSandboxArgv(
  command: string,
  binShell: string,
  cwd: string,
  abortSignal?: AbortSignal,
): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }> {
  if (isSandboxingEnabled()) {
    if (initializationPromise) {
      await initializationPromise
    } else {
      throw new Error('Sandbox failed to initialize. ')
    }
  }
  return BaseSandboxManager.wrapWithSandboxArgv(
    command,
    binShell,
    undefined,
    abortSignal,
    cwd,
  )
}

/**
 * Initialize sandbox with log monitoring enabled by default
 */
async function initialize(
  sandboxAskCallback?: SandboxAskCallback,
): Promise<void> {
  // If already initializing or initialized, return the promise
  if (initializationPromise) {
    return initializationPromise
  }

  // Check if sandboxing is enabled in settings
  if (!isSandboxingEnabled()) {
    return
  }

  // Wrap the callback to enforce allowManagedDomainsOnly policy.
  // This ensures all code paths (REPL, print/SDK) are covered.
  const wrappedCallback: SandboxAskCallback | undefined = sandboxAskCallback
    ? async (hostPattern: NetworkHostPattern) => {
        if (shouldAllowManagedSandboxDomainsOnly()) {
          logForDebugging(
            `[sandbox] Blocked network request to ${hostPattern.host} (allowManagedDomainsOnly)`,
          )
          return false
        }
        return sandboxAskCallback(hostPattern)
      }
    : undefined

  // Create the initialization promise synchronously (before any await) to prevent
  // race conditions where wrapWithSandbox() is called before the promise is assigned.
  initializationPromise = (async () => {
    try {
      // Resolve worktree main repo path once before building config.
      // Worktree status doesn't change mid-session, so this is cached for all
      // subsequent refreshConfig() calls (which must be synchronous to avoid
      // race conditions where pending requests slip through with stale config).
      if (worktreeMainRepoPath === undefined) {
        worktreeMainRepoPath = await detectWorktreeMainRepoPath(getCwdState())
      }

      const settings = getSettings_DEPRECATED()
      const runtimeConfig = convertToSandboxRuntimeConfig(settings)

      // Log monitor is automatically enabled for macOS
      await BaseSandboxManager.initialize(runtimeConfig, wrappedCallback)

      // Subscribe to settings changes to update sandbox config dynamically
      settingsSubscriptionCleanup = settingsChangeDetector.subscribe(() => {
        const settings = getSettings_DEPRECATED()
        const newConfig = convertToSandboxRuntimeConfig(settings)
        BaseSandboxManager.updateConfig(newConfig)
        logForDebugging('Sandbox configuration updated from settings change')
      })
    } catch (error) {
      // Clear the promise on error so initialization can be retried
      initializationPromise = undefined

      // Log error but don't throw - let sandboxing fail gracefully
      logForDebugging(`Failed to initialize sandbox: ${errorMessage(error)}`)
    }
  })()

  return initializationPromise
}

/**
 * Refresh sandbox config from current settings immediately
 * Call this after updating permissions to avoid race conditions
 */
function refreshConfig(): void {
  if (!isSandboxingEnabled()) return
  const settings = getSettings_DEPRECATED()
  const newConfig = convertToSandboxRuntimeConfig(settings)
  BaseSandboxManager.updateConfig(newConfig)
}

/**
 * Reset sandbox state and clear memoized values
 */
async function reset(): Promise<void> {
  // Clean up settings subscription
  settingsSubscriptionCleanup?.()
  settingsSubscriptionCleanup = undefined
  worktreeMainRepoPath = undefined
  bareGitRepoScrubDirs.length = 0

  // Clear memoized caches
  checkDependencies.cache.clear?.()
  isSupportedPlatform.cache.clear?.()
  initializationPromise = undefined

  // Reset the base sandbox manager
  return BaseSandboxManager.reset()
}

/**
 * Add a command to the excluded commands list (commands that should not be sandboxed)
 * This is a Claude CLI-specific function that updates local settings.
 */
export function addToExcludedCommands(
  command: string,
  permissionUpdates?: Array<{
    type: string
    rules: Array<{ toolName: string; ruleContent?: string }>
  }>,
): string {
  const existingSettings = getSettingsForSource('localSettings')
  const existingExcludedCommands =
    existingSettings?.sandbox?.excludedCommands || []

  // Determine the command pattern to add
  // If there are suggestions with Bash rules, extract the pattern (e.g., "npm run test" from "npm run test:*")
  // Otherwise use the exact command
  let commandPattern: string = command

  if (permissionUpdates) {
    const bashSuggestions = permissionUpdates.filter(
      update =>
        update.type === 'addRules' &&
        update.rules.some(rule => rule.toolName === BASH_TOOL_NAME),
    )

    if (bashSuggestions.length > 0 && bashSuggestions[0]!.type === 'addRules') {
      const firstBashRule = bashSuggestions[0]!.rules.find(
        rule => rule.toolName === BASH_TOOL_NAME,
      )
      if (firstBashRule?.ruleContent) {
        // Extract pattern from Bash(command) or Bash(command:*) format
        const prefix = permissionRuleExtractPrefix(firstBashRule.ruleContent)
        commandPattern = prefix || firstBashRule.ruleContent
      }
    }
  }

  // Add to excludedCommands if not already present
  if (!existingExcludedCommands.includes(commandPattern)) {
    updateSettingsForSource('localSettings', {
      sandbox: {
        ...existingSettings?.sandbox,
        excludedCommands: [...existingExcludedCommands, commandPattern],
      },
    })
  }

  return commandPattern
}

// ============================================================================
// Export interface and implementation
// ============================================================================

export interface ISandboxManager {
  initialize(sandboxAskCallback?: SandboxAskCallback): Promise<void>
  isSupportedPlatform(): boolean
  isPlatformInEnabledList(): boolean
  getSandboxUnavailableReason(): string | undefined
  isSandboxingEnabled(): boolean
  isSandboxEnabledInSettings(): boolean
  checkDependencies(): SandboxDependencyCheck
  isAutoAllowBashIfSandboxedEnabled(): boolean
  areUnsandboxedCommandsAllowed(): boolean
  isSandboxRequired(): boolean
  areSandboxSettingsLockedByPolicy(): boolean
  setSandboxSettings(options: {
    enabled?: boolean
    autoAllowBashIfSandboxed?: boolean
    allowUnsandboxedCommands?: boolean
  }): Promise<void>
  getFsReadConfig(): FsReadRestrictionConfig
  getFsWriteConfig(): FsWriteRestrictionConfig
  getNetworkRestrictionConfig(): NetworkRestrictionConfig
  getAllowUnixSockets(): string[] | undefined
  getAllowLocalBinding(): boolean | undefined
  getIgnoreViolations(): IgnoreViolationsConfig | undefined
  getEnableWeakerNestedSandbox(): boolean | undefined
  getExcludedCommands(): string[]
  getProxyPort(): number | undefined
  getSocksProxyPort(): number | undefined
  getLinuxHttpSocketPath(): string | undefined
  getLinuxSocksSocketPath(): string | undefined
  waitForNetworkInitialization(): Promise<boolean>
  wrapWithSandbox(
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal,
  ): Promise<string>
  wrapWithSandboxArgv(
    command: string,
    binShell: string,
    cwd: string,
    abortSignal?: AbortSignal,
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>
  cleanupAfterCommand(): void
  getSandboxViolationStore(): SandboxViolationStore
  annotateStderrWithSandboxFailures(command: string, stderr: string): string
  getLinuxGlobPatternWarnings(): string[]
  refreshConfig(): void
  reset(): Promise<void>
}

/**
 * Claude CLI sandbox manager - wraps sandbox-runtime with Claude-specific features
 */
export const SandboxManager: ISandboxManager = {
  // Custom implementations
  initialize,
  isSandboxingEnabled,
  isSandboxEnabledInSettings: getSandboxEnabledSetting,
  isPlatformInEnabledList,
  getSandboxUnavailableReason,
  isAutoAllowBashIfSandboxedEnabled,
  areUnsandboxedCommandsAllowed,
  isSandboxRequired,
  areSandboxSettingsLockedByPolicy,
  setSandboxSettings,
  getExcludedCommands,
  wrapWithSandbox,
  wrapWithSandboxArgv,
  refreshConfig,
  reset,
  checkDependencies,

  // Forward to base sandbox manager
  getFsReadConfig: BaseSandboxManager.getFsReadConfig,
  getFsWriteConfig: BaseSandboxManager.getFsWriteConfig,
  getNetworkRestrictionConfig: BaseSandboxManager.getNetworkRestrictionConfig,
  getIgnoreViolations: BaseSandboxManager.getIgnoreViolations,
  getLinuxGlobPatternWarnings,
  isSupportedPlatform,
  getAllowUnixSockets: BaseSandboxManager.getAllowUnixSockets,
  getAllowLocalBinding: BaseSandboxManager.getAllowLocalBinding,
  getEnableWeakerNestedSandbox: BaseSandboxManager.getEnableWeakerNestedSandbox,
  getProxyPort: BaseSandboxManager.getProxyPort,
  getSocksProxyPort: BaseSandboxManager.getSocksProxyPort,
  getLinuxHttpSocketPath: BaseSandboxManager.getLinuxHttpSocketPath,
  getLinuxSocksSocketPath: BaseSandboxManager.getLinuxSocksSocketPath,
  waitForNetworkInitialization: BaseSandboxManager.waitForNetworkInitialization,
  getSandboxViolationStore: BaseSandboxManager.getSandboxViolationStore,
  annotateStderrWithSandboxFailures:
    BaseSandboxManager.annotateStderrWithSandboxFailures,
  cleanupAfterCommand: (): void => {
    BaseSandboxManager.cleanupAfterCommand()
    scrubBareGitRepoFiles()
  },
}

// ============================================================================
// Re-export types from sandbox-runtime
// ============================================================================

export type {
  SandboxAskCallback,
  SandboxDependencyCheck,
  FsReadRestrictionConfig,
  FsWriteRestrictionConfig,
  NetworkRestrictionConfig,
  NetworkHostPattern,
  SandboxViolationEvent,
  SandboxRuntimeConfig,
  IgnoreViolationsConfig,
}

export { SandboxViolationStore, SandboxRuntimeConfigSchema }
