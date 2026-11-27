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

/** The profiles `claude web` and the desktop app use. */
export const APP_SETTINGS_PROFILES = ['web', 'desktop'] as const

/**
 * `desktop` for the desktop app's `claude web --stdio`, else `web`. Root
 * options have no `--stdio`, so any one before `--` belongs to `web`.
 */
export function webSettingsProfile(argv: string[]): (typeof APP_SETTINGS_PROFILES)[number] {
  const separator = argv.indexOf('--')
  return (separator === -1 ? argv : argv.slice(0, separator)).includes('--stdio') ? 'desktop' : 'web'
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
