import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { readdir, readFile, realpath, stat, symlink } from 'fs/promises'
import { homedir } from 'os'
import { isAbsolute, join, relative, sep } from 'path'
import { getCwd } from '../cwd.js'
import { getFsImplementation } from '../fsOperations.js'
import { getPlatform } from '../platform.js'
import type { CommandPluginSource } from './schemas.js'

const DEFAULT_TIMEOUT_SECONDS = 60
const MAX_STDOUT_BYTES = 64 * 1024

// A printed directory must hold at least one of these at its top level.
const PLUGIN_CONTENT_NAMES = new Set([
  '.claude-plugin',
  'commands',
  'skills',
  'agents',
  'hooks',
  'themes',
  'output-styles',
  'monitors',
  'workflows',
  'SKILL.md',
  '.mcp.json',
  '.lsp.json',
])

/**
 * What the user reviews before a command source runs: the command, plus the
 * mode when it links. A recorded consent only covers this exact string.
 */
export function commandSourceConsentKey(source: CommandPluginSource): string {
  return source.mode === 'link'
    ? `${source.command} [mode: link]`
    : source.command
}

export function isCommandPluginSource(
  source: unknown,
): source is CommandPluginSource {
  return (
    typeof source === 'object' &&
    source !== null &&
    (source as { source?: unknown }).source === 'command'
  )
}

function assertConsent(
  source: CommandPluginSource,
  consent: string | undefined,
  pluginId: string,
): void {
  const key = commandSourceConsentKey(source)
  if (consent === key) return
  if (consent !== undefined) {
    throw new Error(
      `${pluginId}'s marketplace changed the command that installs it (now \`${key}\`) since it was accepted, so it was not run. Review and accept the new command with: claude plugin update ${pluginId}`,
    )
  }
  throw new Error(
    `${pluginId} is installed by running a command on this machine (\`${key}\`) that has not been reviewed, so it was not run. Review and accept it from its /plugin details pane, or in a terminal: claude plugin install ${pluginId}`,
  )
}

function isSameOrAncestor(candidate: string, path: string): boolean {
  const part = relative(candidate, path)
  return part === '' || (!part.startsWith('..') && !isAbsolute(part))
}

type RunResult = { code: number | null; stdout: string; stderr: string; failure?: string }

// Runs through the shell in its own process group, so a timeout also stops
// grandchildren that would otherwise hold stdout open.
function runShell(command: string, timeoutMs: number): Promise<RunResult> {
  return new Promise(resolve => {
    const windows = getPlatform() === 'windows'
    const child = spawn(command, {
      shell: true,
      cwd: homedir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !windows,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let failure: string | undefined
    const stop = (reason: string) => {
      failure ??= reason
      try {
        if (!windows && child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }
    const timer = setTimeout(() => stop(`did not finish within ${timeoutMs / 1000}s`), timeoutMs)
    child.stdout.on('data', chunk => {
      stdout += chunk
      if (stdout.length > MAX_STDOUT_BYTES) stop(`printed more than ${MAX_STDOUT_BYTES / 1024} KB`)
    })
    child.stderr.on('data', chunk => {
      if (stderr.length < MAX_STDOUT_BYTES) stderr += chunk
    })
    child.on('error', error => {
      failure ??= `could not be started: ${error.message}`
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, failure })
    })
  })
}

async function resolvePluginDirectory(
  source: CommandPluginSource,
): Promise<string> {
  const timeoutMs = (source.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000
  const shown = `\`${source.command}\``
  const result = await runShell(source.command, timeoutMs)
  if (result.failure || result.code !== 0) {
    const stderr = result.stderr.trim().slice(0, 500)
    throw new Error(
      `Plugin source command ${shown} failed (${result.failure ?? `exit code ${result.code}`})${stderr ? `: ${stderr}` : ''}`,
    )
  }
  const lines = result.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  if (lines.length !== 1) {
    throw new Error(
      lines.length === 0
        ? `Plugin source command ${shown} printed nothing; it must print the absolute path of the plugin directory.`
        : `Plugin source command ${shown} printed ${lines.length} lines; it must print exactly one absolute path.`,
    )
  }
  const printed = lines[0]!
  if (!isAbsolute(printed)) {
    throw new Error(
      `Plugin source command ${shown} printed \`${printed}\`, which is not an absolute path.`,
    )
  }
  let directory: string
  try {
    directory = await realpath(printed)
  } catch (error) {
    throw new Error(
      `Plugin source command ${shown} printed \`${printed}\`, but that path could not be resolved.`,
      { cause: error },
    )
  }
  if (!(await stat(directory)).isDirectory()) {
    throw new Error(
      `Plugin source command ${shown} printed \`${printed}\`, which is not a directory.`,
    )
  }
  if (isSameOrAncestor(directory, await realpath(getCwd()))) {
    throw new Error(
      `Plugin source command ${shown} printed the working directory or one of its parents (${printed}); refusing to use it as a plugin.`,
    )
  }
  const names = await readdir(directory)
  if (!names.some(name => PLUGIN_CONTENT_NAMES.has(name))) {
    throw new Error(
      `Plugin source command ${shown} printed \`${printed}\`, but that directory has no plugin content (expected .claude-plugin/ or a commands/, skills/, agents/, hooks/ or similar entry at the top level). Nothing was installed.`,
    )
  }
  return directory
}

async function hashDirectory(root: string): Promise<string> {
  const hash = createHash('sha256')
  async function walk(dir: string): Promise<void> {
    const entries = (await readdir(dir, { withFileTypes: true })).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )
    for (const entry of entries) {
      const path = join(dir, entry.name)
      const name = relative(root, path).split(sep).join('/')
      if (entry.isDirectory()) {
        if (dir === root && entry.name === '.git') continue
        hash.update(`d ${name}\0`)
        await walk(path)
      } else if (entry.isFile()) {
        const content = await readFile(path)
        hash.update(`f ${name}\0${content.length}\0`)
        hash.update(content)
      } else if (entry.isSymbolicLink()) {
        hash.update(`l ${name}\0`)
      }
    }
  }
  await walk(root)
  return hash.digest('hex')
}

/**
 * Run a `command` source and materialize the directory it prints at
 * `targetPath`: copied (default), or linked entry by entry (`mode: "link"`).
 * Returns a content version so updates notice a changed export.
 */
export async function installFromCommand(
  source: CommandPluginSource,
  targetPath: string,
  options: {
    consent: string | undefined
    pluginId: string
    copyDir: (src: string, dest: string) => Promise<void>
  },
): Promise<{ contentVersion: string }> {
  assertConsent(source, options.consent, options.pluginId)
  if (source.mode === 'link' && getPlatform() === 'windows') {
    throw new Error(
      'This plugin source uses mode "link", which is not supported on Windows yet.',
    )
  }
  const directory = await resolvePluginDirectory(source)
  if (source.mode === 'link') {
    await getFsImplementation().mkdir(targetPath)
    const names = (await readdir(directory)).filter(name => name !== '.git')
    for (const name of names) await symlink(join(directory, name), join(targetPath, name))
    const hash = createHash('sha256').update(directory)
    for (const name of names.sort()) hash.update(`\0${name}`)
    return { contentVersion: hash.digest('hex').slice(0, 12) }
  }
  await options.copyDir(directory, targetPath)
  await getFsImplementation().rm(join(targetPath, '.git'), {
    recursive: true,
    force: true,
  })
  return { contentVersion: (await hashDirectory(targetPath)).slice(0, 12) }
}
