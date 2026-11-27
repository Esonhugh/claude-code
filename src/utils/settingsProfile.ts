import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { getClaudeConfigHomeDir } from './envUtils.js'

/**
 * `claude web` and the desktop app keep their own user settings.json and
 * global config (.claude.json) in <config dir>/<profile>/, so what they change
 * doesn't reach the terminal CLI and the other way round. The sessions they
 * start inherit the variable.
 */
export const SETTINGS_PROFILE_ENV = 'CLAUDE_CODE_SETTINGS_PROFILE'

const PROFILE_NAME = /^[a-z0-9][a-z0-9-]*$/

// Root flags `claude web` forwards to its sessions; each takes one value.
const ROOT_VALUE_FLAGS = new Set(['--plugin-dir', '--plugin-dir-no-mcp', '--plugin-url', '--settings', '--setting-sources'])

/** `web` for `claude web`, `desktop` for the desktop app's `claude web --stdio`, else undefined. */
export function settingsProfileForArgs(args: string[]): string | undefined {
  let i = 0
  while (i < args.length && args[i]!.startsWith('-')) {
    i += ROOT_VALUE_FLAGS.has(args[i]!) ? 2 : 1
  }
  if (args[i] !== 'web') return undefined
  const rest = args.slice(i + 1)
  const separator = rest.indexOf('--')
  return (separator === -1 ? rest : rest.slice(0, separator)).includes('--stdio') ? 'desktop' : 'web'
}

/** <config dir>/<profile>, or undefined when the shared files are in use. */
export function getSettingsProfileDir(): string | undefined {
  const profile = process.env[SETTINGS_PROFILE_ENV]
  if (!profile || !PROFILE_NAME.test(profile)) return undefined
  return join(getClaudeConfigHomeDir(), profile)
}

const seeded = new Set<string>()

/**
 * First use of a profile file: copy the file this launch would otherwise have
 * used, or write `{}` when there is none. An existing file is left alone.
 */
export function seedSettingsProfileFile(path: string, source: string): void {
  if (seeded.has(path)) return
  seeded.add(path)
  if (existsSync(path)) return
  const tmp = `${path}.${process.pid}.tmp`
  try {
    let content = '{}\n'
    try {
      content = readFileSync(source, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(tmp, content, { mode: 0o600 })
    if (existsSync(path)) unlinkSync(tmp)
    else renameSync(tmp, path)
  } catch (e) {
    // Tried again on the next launch, since the file still doesn't exist.
    try {
      unlinkSync(tmp)
    } catch {
      // Never written.
    }
    process.stderr.write(`Could not create ${path} from ${source}: ${(e as Error).message}\n`)
  }
}
