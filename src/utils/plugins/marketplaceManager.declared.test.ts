import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Declared marketplaces come from process-wide settings, so each case runs in a
// child whose HOME and config dir are owned by this test.
async function declaredFor(enabledPlugins: Record<string, boolean> | undefined) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mkt-declared-')))
  try {
    mkdirSync(join(home, 'config'), { recursive: true })
    writeFileSync(join(home, 'config', 'settings.json'), JSON.stringify(enabledPlugins ? { enabledPlugins } : {}))
    const child = Bun.spawn([process.execPath, '-e', `
      globalThis.MACRO = { VERSION: 'test' }
      const { enableConfigs } = await import(${JSON.stringify(join(import.meta.dir, '../config.ts'))})
      enableConfigs()
      const { getDeclaredMarketplaces } = await import(${JSON.stringify(join(import.meta.dir, 'marketplaceManager.ts'))})
      console.log(JSON.stringify(Object.keys(getDeclaredMarketplaces()).sort()))
    `], {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, CLAUDE_CONFIG_DIR: join(home, 'config'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (code !== 0) throw new Error(stderr)
    return JSON.parse(stdout.trim().split('\n').at(-1)!) as string[]
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('Esonhugh-Marketplace is declared only when an enabled plugin references it, like claude-plugins-official', async () => {
  expect(await declaredFor(undefined)).toEqual([])
  expect(await declaredFor({ 'x@Esonhugh-Marketplace': false })).toEqual([])
  expect(await declaredFor({ 'x@Esonhugh-Marketplace': true })).toEqual(['Esonhugh-Marketplace'])
  expect(await declaredFor({ 'x@claude-plugins-official': true })).toEqual(['claude-plugins-official'])
}, 60000)

// Same isolation, with a project folder whose settings declare a marketplace.
async function declaredInProject(trusted: boolean) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mkt-declared-')))
  try {
    const project = join(home, 'project')
    const source = { source: 'directory', path: join(home, 'mkt') }
    mkdirSync(join(home, 'config'), { recursive: true })
    mkdirSync(join(project, '.claude'), { recursive: true })
    writeFileSync(join(home, 'config', 'settings.json'), JSON.stringify({ extraKnownMarketplaces: { 'user-mkt': { source } } }))
    writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ extraKnownMarketplaces: { 'project-mkt': { source } } }))
    writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ extraKnownMarketplaces: { 'local-mkt': { source } } }))
    writeFileSync(join(home, 'config', '.claude.json'), JSON.stringify(trusted ? { projects: { [project]: { hasTrustDialogAccepted: true } } } : {}))
    const child = Bun.spawn([process.execPath, '-e', `
      globalThis.MACRO = { VERSION: 'test' }
      const { enableConfigs } = await import(${JSON.stringify(join(import.meta.dir, '../config.ts'))})
      enableConfigs()
      const { getDeclaredMarketplaces } = await import(${JSON.stringify(join(import.meta.dir, 'marketplaceManager.ts'))})
      console.log(JSON.stringify(Object.keys(getDeclaredMarketplaces()).sort()))
    `], {
      cwd: project,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, CLAUDE_CONFIG_DIR: join(home, 'config'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (code !== 0) throw new Error(stderr)
    return JSON.parse(stdout.trim().split('\n').at(-1)!) as string[]
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

// Official 2.1.329: -p never shows the trust dialog, so project and local
// settings of an untrusted folder must not get a marketplace registered.
test('an untrusted workspace declares marketplaces from user settings only', async () => {
  expect(await declaredInProject(false)).toEqual(['user-mkt'])
  expect(await declaredInProject(true)).toEqual(['local-mkt', 'project-mkt', 'user-mkt'])
}, 60000)

// Sources that stay in force are merged the way settings are: a later source
// naming the same repository without a ref keeps the ref pinned by the user.
async function pinnedInProject(trusted: boolean) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mkt-declared-')))
  try {
    const project = join(home, 'project')
    mkdirSync(join(home, 'config'), { recursive: true })
    mkdirSync(project, { recursive: true })
    writeFileSync(join(home, 'config', 'settings.json'), JSON.stringify({
      extraKnownMarketplaces: { 'pin-mkt': { source: { source: 'github', repo: 'owner/repo', ref: 'pinned' } } },
    }))
    writeFileSync(join(home, 'config', '.claude.json'), JSON.stringify(trusted ? { projects: { [project]: { hasTrustDialogAccepted: true } } } : {}))
    const child = Bun.spawn([process.execPath, '-e', `
      globalThis.MACRO = { VERSION: 'test' }
      const { enableConfigs } = await import(${JSON.stringify(join(import.meta.dir, '../config.ts'))})
      enableConfigs()
      const state = await import(${JSON.stringify(join(import.meta.dir, '../../bootstrap/state.ts'))})
      state.setFlagSettingsInline({ extraKnownMarketplaces: { 'pin-mkt': { source: { source: 'github', repo: 'owner/repo' } } } })
      const { getDeclaredMarketplaces } = await import(${JSON.stringify(join(import.meta.dir, 'marketplaceManager.ts'))})
      console.log(JSON.stringify(getDeclaredMarketplaces()['pin-mkt']))
    `], {
      cwd: project,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, CLAUDE_CONFIG_DIR: join(home, 'config'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (code !== 0) throw new Error(stderr)
    return JSON.parse(stdout.trim().split('\n').at(-1)!) as unknown
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('an untrusted workspace merges the remaining declarations like settings do', async () => {
  const pinned = { source: { source: 'github', repo: 'owner/repo', ref: 'pinned' } }
  expect(await pinnedInProject(true)).toEqual(pinned)
  expect(await pinnedInProject(false)).toEqual(pinned)
}, 60000)
