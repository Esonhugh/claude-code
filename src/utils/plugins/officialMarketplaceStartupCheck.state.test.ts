import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The startup check reads and writes the process-wide global config, so each
// case runs in a child whose HOME and config dir are owned by this test.
async function runCheck(globalConfig: Record<string, unknown>, env: Record<string, string> = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mkt-autoinstall-')))
  try {
    const configDir = join(home, 'config')
    mkdirSync(join(configDir, 'plugins'), { recursive: true })
    writeFileSync(join(configDir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, ...globalConfig }))
    // Already present, so a check that runs records success without cloning.
    writeFileSync(join(configDir, 'plugins', 'known_marketplaces.json'), JSON.stringify({
      'Esonhugh-Marketplace': {
        source: { source: 'github', repo: 'Esonhugh/Marketplace' },
        installLocation: join(configDir, 'plugins', 'marketplaces', 'Esonhugh-Marketplace'),
        lastUpdated: '2026-01-01T00:00:00.000Z',
      },
    }))
    const child = Bun.spawn([process.execPath, '-e', `
      globalThis.MACRO = { VERSION: 'test' }
      const { enableConfigs } = await import(${JSON.stringify(join(import.meta.dir, '..', 'config.ts'))})
      enableConfigs()
      const { checkAndInstallOfficialMarketplace } = await import(${JSON.stringify(join(import.meta.dir, 'officialMarketplaceStartupCheck.ts'))})
      console.log(JSON.stringify(await checkAndInstallOfficialMarketplace()))
    `], {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...env },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (code !== 0) throw new Error(stderr)
    return {
      result: JSON.parse(stdout.trim().split('\n').at(-1)!),
      config: JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8')) as Record<string, unknown>,
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

const officialKeys = (config: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(config).filter(([key]) => key.startsWith('officialMarketplaceAutoInstall')))

test('the official CLI recording its own marketplace as installed does not skip the Esonhugh check', async () => {
  const { result, config } = await runCheck({ officialMarketplaceAutoInstallAttempted: true, officialMarketplaceAutoInstalled: true })
  expect(result.reason).toBe('already_installed')
  expect(config.esonhughMarketplaceAutoInstalled).toBe(true)
  expect(officialKeys(config)).toEqual({ officialMarketplaceAutoInstallAttempted: true, officialMarketplaceAutoInstalled: true })
}, 60000)

test('the Esonhugh check records its result under its own keys and leaves the official CLI keys alone', async () => {
  const { result, config } = await runCheck({}, { CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1' })
  expect(result.reason).toBe('policy_blocked')
  expect(config.esonhughMarketplaceAutoInstallFailReason).toBe('policy_blocked')
  expect(officialKeys(config)).toEqual({})
}, 60000)
