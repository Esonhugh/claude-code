/**
 * `claude reset-identity` — rotates the identifiers that let Anthropic link
 * this install across sessions: the device id, the install and first-token
 * dates, and the telemetry batches still queued with them. It runs only once
 * logged out, since a logged-in account would link the old and new ids.
 */
/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

import { readdir, readFile, rm } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { createInterface } from 'readline/promises'
import { getApiKeyFromConfigOrMacOSKeychain } from '../../utils/auth.js'
import { type GlobalConfig, getGlobalConfig, saveGlobalConfigFile } from '../../utils/config.js'
import { getAllGlobalClaudeFiles, getGlobalClaudeFile, getSharedGlobalClaudeFile } from '../../utils/env.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { errorMessage, getErrnoCode } from '../../utils/errors.js'
import { stripBOM } from '../../utils/jsonRead.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { SETTINGS_PROFILE_ENV } from '../../utils/settingsProfile.js'
import { jsonParse } from '../../utils/slowOperations.js'

const CONFIG_KEYS = {
  userID: 'device id sent with API requests and telemetry',
  firstStartTime: 'when Claude Code first ran on this computer',
  claudeCodeFirstTokenDate: "the account's first Claude Code token date",
} as const

type ConfigKey = keyof typeof CONFIG_KEYS

// Credentials in the environment can't be logged out of, so they only warn.
const CREDENTIAL_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] as const

type Item =
  | { kind: 'config-key'; file: string; key: ConfigKey; detail: string }
  | { kind: 'file'; path: string; detail: string }

/** A global config: the shared one, or a `claude web` / desktop profile's. */
type ConfigFile = { path: string; config: GlobalConfig }

type ResetIdentityOptions = {
  dryRun?: boolean
  yes?: boolean
}

function out(line = ''): void {
  process.stdout.write(`${line}\n`)
}

function exitWith(message: string, code: number): never {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

/**
 * The global configs that exist. The active one is read through the config
 * cache; the others are read from disk, and one that can't be read is
 * reported rather than reset, since writing it would replace it with defaults.
 */
async function configFiles(): Promise<{ files: ConfigFile[]; unreadable: string[] }> {
  const files: ConfigFile[] = []
  const unreadable: string[] = []
  for (const path of getAllGlobalClaudeFiles()) {
    if (path === getGlobalClaudeFile()) {
      files.push({ path, config: getGlobalConfig() })
      continue
    }
    try {
      files.push({ path, config: jsonParse(stripBOM(await readFile(path, 'utf8'))) as GlobalConfig })
    } catch (error) {
      if (getErrnoCode(error) !== 'ENOENT') unreadable.push(`Could not read ${path} — ${errorMessage(error)}`)
    }
  }
  return { files, unreadable }
}

/** How to log out of the account a global config belongs to. */
function logoutCommand(path: string): string {
  if (path === getGlobalClaudeFile()) return 'claude auth logout or /logout'
  const profile = path === getSharedGlobalClaudeFile() ? '' : basename(dirname(path))
  return `${SETTINGS_PROFILE_ENV}=${profile} claude auth logout`
}

/** What still ties this computer to an Anthropic account, and how to log out. */
function loggedInReasons(files: ConfigFile[]): string[] {
  const reasons: string[] = []
  // @ts-ignore - recovered code
  if (getSecureStorage().read()?.claudeAiOauth) reasons.push('a Claude account login (claude auth logout or /logout)')
  if (getApiKeyFromConfigOrMacOSKeychain()) reasons.push('an API key saved by /login (claude auth logout or /logout)')
  for (const { path, config } of files) {
    if (config.oauthAccount) reasons.push(`cached account details in ${path} (${logoutCommand(path)})`)
    if (config.primaryApiKey && path !== getGlobalClaudeFile()) {
      reasons.push(`an API key saved by /login in ${path} (${logoutCommand(path)})`)
    }
  }
  return reasons
}

async function telemetryFiles(): Promise<{ path: string; detail: string }[]> {
  const dir = join(getClaudeConfigHomeDir(), 'telemetry')
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const files = names.filter(name => name.startsWith('1p_failed_events.')).map(name => join(dir, name))
  return Promise.all(
    files.map(async path => {
      try {
        // One event per line, as the 1P exporter writes them.
        const text = await readFile(path, 'utf8')
        const events = text.split('\n').filter(line => line.trim()).length
        return { path, detail: `${events} event(s), ${Buffer.byteLength(text)} bytes` }
      } catch (error) {
        return { path, detail: `unreadable: ${errorMessage(error)}` }
      }
    }),
  )
}

async function items(files: ConfigFile[]): Promise<Item[]> {
  // Startup records firstStartTime before this command runs, so a value from
  // this process is already a fresh one.
  const startedAt = Date.now() - process.uptime() * 1000
  const keys = files.flatMap(({ path, config }) =>
    (Object.keys(CONFIG_KEYS) as ConfigKey[])
      .filter(key =>
        key === 'firstStartTime'
          ? config.firstStartTime !== undefined && Date.parse(config.firstStartTime) < startedAt
          : config[key] !== undefined,
      )
      .map(key => ({ kind: 'config-key' as const, file: path, key, detail: String(config[key]) })),
  )
  return [...keys, ...(await telemetryFiles()).map(file => ({ kind: 'file' as const, ...file }))]
}

function describe(item: Item, showFile: boolean): string {
  return item.kind === 'config-key'
    ? `config: ${item.key} = ${item.detail} (${CONFIG_KEYS[item.key]}${showFile ? `; ${item.file}` : ''})`
    : `file:   ${item.path} (${item.detail}; unsent telemetry with the old device id)`
}

/** Clears one config file's keys in a single write, or deletes one file. */
async function remove(target: { file: string; keys: ConfigKey[] } | { path: string }): Promise<string | null> {
  const name = 'path' in target ? target.path : target.file
  try {
    if ('path' in target) {
      await rm(target.path, { force: true })
      return null
    }
    const written = saveGlobalConfigFile(target.file, config =>
      target.keys.some(key => config[key] !== undefined)
        ? { ...config, ...Object.fromEntries(target.keys.map(key => [key, undefined])) }
        : config,
    )
    // Refused when the file can't be read back or the write would drop a login.
    return written ? null : `Could not reset ${name} — it could not be read or written; nothing in it was changed`
  } catch (error) {
    return `Could not reset ${name} — ${errorMessage(error)}`
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(`${question} [y/N] `)
    return /^y(es)?$/i.test(answer.trim())
  } catch {
    return false
  } finally {
    rl.close()
  }
}

export async function resetIdentityHandler(options: ResetIdentityOptions): Promise<never> {
  const { files, unreadable } = await configFiles()
  const reasons = loggedInReasons(files)
  const loggedIn = `this computer still has ${reasons.join(', ')}, which would link the new device id to the old one`
  // A dry run changes nothing, so it shows the plan even while logged in.
  if (reasons.length > 0 && !options.dryRun) {
    exitWith(`Log out first: ${loggedIn}.`, 1)
  }
  for (const name of CREDENTIAL_ENV) {
    if (process.env[name]) {
      process.stderr.write(`Warning: ${name} is set. Requests made with it still identify you to Anthropic, whatever the device id.\n`)
    }
  }

  const plan = await items(files)
  if (plan.length === 0 && unreadable.length === 0) {
    out('Nothing to reset: no device id or tracking data is stored.')
    process.exit(0)
  }
  const showFile = files.length > 1
  if (plan.length > 0) {
    out('Will reset:')
    for (const item of plan) out(`  ${describe(item, showFile)}`)
    out('\nA new device id is created the next time Claude Code starts. Sessions already running keep the old one until they restart.')
    out(`Config backups (the backups/ directories under ${getClaudeConfigHomeDir()}) are not removed and may still hold the old values.`)
  }
  if (options.dryRun) {
    for (const line of unreadable) out(line)
    if (reasons.length > 0) out(`Log out before resetting: ${loggedIn}.`)
    out(`Dry run: ${plan.length} item(s) would be reset.`)
    process.exit(0)
  }
  if (plan.length > 0 && !options.yes && !(await confirm(`Reset ${plan.length} item(s)?`))) {
    exitWith('Aborted.', 1)
  }

  const targets = [
    ...files
      .map(({ path }) => ({
        file: path,
        keys: plan.flatMap(item => (item.kind === 'config-key' && item.file === path ? [item.key] : [])),
      }))
      .filter(target => target.keys.length > 0),
    ...plan.flatMap(item => (item.kind === 'file' ? [{ path: item.path }] : [])),
  ]
  const failures = [...unreadable]
  for (const target of targets) {
    const failure = await remove(target)
    if (failure) failures.push(failure)
  }
  if (failures.length > 0) {
    exitWith(`${failures.length} item(s) failed:\n  ${failures.join('\n  ')}\nRun the command again once the cause is fixed.`, 1)
  }
  out(`Reset ${plan.length} item(s).`)
  process.exit(0)
}
