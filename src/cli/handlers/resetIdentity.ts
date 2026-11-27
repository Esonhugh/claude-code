/**
 * `claude reset-identity` — rotates the identifiers that let Anthropic link
 * this install across sessions: the device id, the install and first-token
 * dates, and the telemetry batches still queued with them. It runs only once
 * logged out, since a logged-in account would link the old and new ids.
 */
/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

import { readdir, rm } from 'fs/promises'
import { join } from 'path'
import { createInterface } from 'readline/promises'
import { getApiKeyFromConfigOrMacOSKeychain } from '../../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'

const CONFIG_KEYS = {
  userID: 'device id sent with API requests and telemetry',
  firstStartTime: 'when Claude Code first ran on this computer',
  claudeCodeFirstTokenDate: "the account's first Claude Code token date",
} as const

type ConfigKey = keyof typeof CONFIG_KEYS

type Item =
  | { kind: 'config-key'; key: ConfigKey }
  | { kind: 'file'; path: string }

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

/** What still ties this computer to an Anthropic account. */
function loggedInReasons(): string[] {
  const reasons: string[] = []
  // @ts-ignore - recovered code
  if (getSecureStorage().read()?.claudeAiOauth) reasons.push('a Claude account login')
  if (getGlobalConfig().oauthAccount) reasons.push('cached account details in ~/.claude.json')
  if (getApiKeyFromConfigOrMacOSKeychain()) reasons.push('an API key saved by /login')
  return reasons
}

async function telemetryFiles(): Promise<string[]> {
  const dir = join(getClaudeConfigHomeDir(), 'telemetry')
  try {
    const names = await readdir(dir)
    return names.filter(name => name.startsWith('1p_failed_events.')).map(name => join(dir, name))
  } catch {
    return []
  }
}

async function items(): Promise<Item[]> {
  const config = getGlobalConfig()
  // Startup records firstStartTime before this command runs, so a value from
  // this process is already a fresh one.
  const startedAt = Date.now() - process.uptime() * 1000
  const keys = (Object.keys(CONFIG_KEYS) as ConfigKey[]).filter(key =>
    key === 'firstStartTime'
      ? config.firstStartTime !== undefined && Date.parse(config.firstStartTime) < startedAt
      : config[key] !== undefined,
  )
  return [
    ...keys.map(key => ({ kind: 'config-key' as const, key })),
    ...(await telemetryFiles()).map(path => ({ kind: 'file' as const, path })),
  ]
}

function describe(item: Item): string {
  return item.kind === 'config-key'
    ? `config: ${item.key} (${CONFIG_KEYS[item.key]})`
    : `file:   ${item.path} (unsent telemetry with the old device id)`
}

async function remove(item: Item): Promise<string | null> {
  try {
    if (item.kind === 'file') {
      await rm(item.path, { force: true })
    } else {
      saveGlobalConfig(config =>
        config[item.key] === undefined ? config : { ...config, [item.key]: undefined },
      )
    }
    return null
  } catch (error) {
    return `Could not reset ${item.kind === 'file' ? item.path : item.key} — ${errorMessage(error)}`
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
  const reasons = loggedInReasons()
  if (reasons.length > 0) {
    exitWith(
      `Log out first (claude auth logout or /logout): this computer still has ${reasons.join(', ')}, which would link the new device id to the old one.`,
      1,
    )
  }

  const plan = await items()
  if (plan.length === 0) {
    out('Nothing to reset: no device id or tracking data is stored.')
    process.exit(0)
  }
  out('Will reset:')
  for (const item of plan) out(`  ${describe(item)}`)
  out('\nA new device id is created the next time Claude Code starts. Sessions already running keep the old one until they restart.')
  if (options.dryRun) {
    out(`Dry run: ${plan.length} item(s) would be reset.`)
    process.exit(0)
  }
  if (!options.yes && !(await confirm(`Reset ${plan.length} item(s)?`))) {
    exitWith('Aborted.', 1)
  }

  const failures: string[] = []
  for (const item of plan) {
    const failure = await remove(item)
    if (failure) failures.push(failure)
  }
  if (failures.length > 0) {
    exitWith(`${failures.length} item(s) failed:\n  ${failures.join('\n  ')}\nRun the command again once the cause is fixed.`, 1)
  }
  out(`Reset ${plan.length} item(s).`)
  process.exit(0)
}
